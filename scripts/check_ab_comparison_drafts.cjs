#!/usr/bin/env node
// [R3-FE] 比較の保存前入力(比較対象・preference・比較コメント)が消えないことの**実ブラウザ**検査。
//
//  確かめること:
//   A/B各2枚を評価し、比較対象・preference・コメントを入れた状態で ->
//   ケース移動して戻っても完全一致 -> 再読み込みしても完全一致 ->
//   保存すると比較1件が入力どおり記録され、そのケースの下書きは消える ->
//   保存済みを編集し始めた下書きは再読み込みをまたいで残る ->
//   画像を外すと存在しない画像IDの下書きが残らない ->
//   comparisonDrafts を持たない既存記録もそのまま読める ->
//   どの画面幅でも崩れない。
//
//  合成フィクスチャだけを使い、実験の実データは扱わない。使い捨てプロファイルのみ。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function fail(message, detail) {
  const error = new Error(message);
  if (detail !== undefined) error.detail = detail;
  throw error;
}
function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
function safeResolve(urlPath) {
  const cleanPath = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const normalized = cleanPath === "/" ? "/index.html" : cleanPath;
  const target = path.resolve(ROOT, "." + normalized);
  if (!target.startsWith(ROOT + path.sep) && target !== ROOT) return null;
  return target;
}
function createServer() {
  return http.createServer((req, res) => {
    const target = safeResolve(req.url);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": contentType(target), "cache-control": "no-store" });
    fs.createReadStream(target).pipe(res);
  });
}

// [R4C] keep-alive 接続を掴んだままだと server.close() は永久に待つ。
//  接続を控えておき、停止時に能動的に破棄する。
function trackSockets(server) {
  server.__sockets = new Set();
  server.on("connection", (socket) => {
    server.__sockets.add(socket);
    socket.on("close", () => server.__sockets.delete(socket));
  });
  return server;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
// [R4C] 有界なサーバ停止。Chrome の keep-alive 接続を先に破棄してから close を待ち、
//  それでも終わらない場合に備えて上限を設ける(PASS表示後に終了しない問題の直接原因)。
function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    const sockets = server.__sockets || new Set();
    for (const socket of sockets) { try { socket.destroy(); } catch (_) { /* already gone */ } }
    sockets.clear();
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    const timer = setTimeout(done, 3000);
    if (timer.unref) timer.unref();
    try {
      server.close(() => { clearTimeout(timer); done(); });
    } catch (_) { clearTimeout(timer); done(); }
  });
}
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function closeChrome(chrome) {
  return new Promise((resolve) => {
    if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) { resolve(); return; }
    const timeout = setTimeout(() => {
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
      resolve();
    }, 3000);
    chrome.once("exit", () => { clearTimeout(timeout); resolve(); });
    chrome.kill("SIGTERM");
  });
}
async function removeDirWithRetry(dir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) { if (attempt >= 5) throw error; await wait(250); }
  }
}
function waitForChromeWs(chrome) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Timed out waiting for Chrome DevTools endpoint"));
    }, 15000);
    chrome.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    chrome.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Chrome exited early: code=${code} signal=${signal}`));
    });
  });
}
class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}, sessionId = null) {
    await this.ready;
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify(payload));
    return promise;
  }
  close() {
    // [R4C] 保留中の待ちを解いてから閉じる。未解決の Promise が残ると Node が終了しない。
    for (const pending of this.pending.values()) {
      try { pending.reject(new Error("CDP client closed")); } catch (_) { /* noop */ }
    }
    this.pending.clear();
    try { this.ws.close(); } catch (_) { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
function sha(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}
function definitionText(pkg) {
  return JSON.stringify({
    experiment: pkg.experiment, policy: pkg.policy,
    exportTargets: pkg.exportTargets, cases: pkg.cases
  });
}
const LABELS = {
  1: ["合成の重要要素 いち", "合成の重要要素 に", "合成の重要要素 さん"],
  2: ["合成の重要要素 A", "合成の重要要素 B", "合成の重要要素 C"]
};
function buildPackage() {
  const cases = [1, 2].map((n) => {
    const a = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 末尾`;
    const b = "【合成の優先ブロック】\n" + LABELS[n].join("\n") + "\n" + a;
    const settings = { schema: "t9_gen_settings.v1", salt: "draft-" + n };
    return {
      sourceNo: n, baselineGenerationId: "gen-draft-p" + n, role: "合成", species: "", reason: "合成",
      batchId: "draft-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      priorityItems: LABELS[n].map((label, i) => ({ itemId: "P" + (i + 1), label, clauseSha256: sha(label) })),
      arms: {
        A: { generationId: "draft-p" + n + "-A", role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false, diffSummary: "元のプロンプトのまま。" },
        B: { generationId: "draft-p" + n + "-B", role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, diffSummary: "合成の優先ブロックを入れています。" }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-03T00:00:00.000Z", generatedBy: "fixture-drafts",
    experiment: {
      experimentId: "fixture-drafts", hypothesis: "合成", insertionPoint: "合成",
      insertText: "", insertTextSha256: "", holdConstant: ["model"], evaluationFocus: ["合成"],
      automaticProductionUpdate: false, seedSupported: false
    },
    policy: {
      arms: [{ id: "A", role: "control", label: "A 合成" }, { id: "B", role: "treatment", label: "B 合成" }],
      maxImagesPerArm: 2, requiredImagesPerArm: 2, priorityChecksRequired: true,
      priorityStatuses: ["present", "missing", "unclear"],
      compareNotesPlaceholder: "合成の比較案内文",
      imageNotesPlaceholder: "合成の画像コメント案内文",
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-drafts-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abFlowState")||{}).textContent||"")
      + " / " + ((document.getElementById("abPackageStatus")||{}).textContent||""));
  };
  const byId = (id) => document.getElementById(id);
  const problems = [];
  const note = (c, m) => { if (!c) problems.push(m); };
  const setVal = (id, v) => {
    const n = byId(id);
    if (!n) { problems.push("missing input: " + id); return; }
    n.value = String(v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const st = () => (byId("abStatus") || {}).textContent || "";
  const waitS = (re, label) => waitFor(() => re.test(st()), label);
  const makePng = (seed) => new Promise((resolve) => {
    const cv = document.createElement("canvas");
    cv.width = 40; cv.height = 30;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "rgb(" + (seed % 256) + "," + ((seed * 7) % 256) + "," + ((seed * 13) % 256) + ")";
    ctx.fillRect(0, 0, 40, 30);
    cv.toBlob(resolve, "image/png");
  });
  const pickImage = async (arm, name, seed) => {
    byId("abStatus").textContent = "";
    const dt = new DataTransfer();
    dt.items.add(new File([await makePng(seed)], name, { type: "image/png" }));
    const n = byId("abFile" + arm);
    n.files = dt.files;
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitS(/画像を .* 枚置きました|登録できませんでした|上限/, "image " + arm + " " + name);
  };
  // [R4F] 記録は実験ごとの保管庫にある。索引から「いま開いている保管庫」の鍵を引く。
  const abWsIndex = () => {
    try { return JSON.parse(localStorage.getItem("personaGenerator.abWorkspaces.v1")); }
    catch (_) { return null; }
  };
  const activeWsEntry = () => {
    const i = abWsIndex();
    if (!i || !i.activeId) return null;
    return (i.workspaces || []).filter((w) => w.id === i.activeId)[0] || null;
  };
  const abKey = () => {
    const w = activeWsEntry();
    return w ? w.storeKey : "personaGenerator.abExperiment.v1";
  };
  const store = () => JSON.parse(localStorage.getItem(abKey()));
  const drafts = () => (store().comparisonDrafts || {});
  const selectedId = (arm) => {
    const n = byId("abThumbs" + arm).querySelector('[data-ab-selected="true"]');
    return n ? n.getAttribute("data-ab-image-id") : "";
  };
  const thumbIds = (arm) => Array.prototype.map.call(
    byId("abThumbs" + arm).querySelectorAll("img"), (n) => n.getAttribute("data-ab-image-id"));
  const setPrio = (arm, itemId, status) => {
    const row = byId("abRev" + arm + "_priority").querySelector('[data-ab-priority-id="' + itemId + '"]');
    const sel = row.querySelector("select");
    sel.value = status;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const fillImage = (arm, idx, verdict, aes, intent, notes, items) => {
    byId("abThumbs" + arm).querySelectorAll("img")[idx].click();
    setVal("abRev" + arm + "_verdict", verdict);
    setVal("abRev" + arm + "_aestheticSatisfaction", aes);
    setVal("abRev" + arm + "_intentMatch", intent);
    setVal("abRev" + arm + "_notes", notes);
    items.forEach((it) => setPrio(arm, it, "present"));
  };
  const snapshot = () => ({
    a: selectedId("A"), b: selectedId("B"),
    preference: byId("abPreference").value, notes: byId("abCompareNotes").value
  });
`;

const PREF = "B";
const NOTES = "合成の比較コメント。移動と再読み込みをまたいで残ること。";

// ---------------------------------------------------------------------------
// 1-6: 2枚ずつ評価 -> A1/B1 を比較対象に -> preference/コメント -> ケース移動して戻る
// ---------------------------------------------------------------------------
function phaseSetupAndMove(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");

    note(/比較の選択とコメントは、この端末に自動保存されます/.test(
      (byId("abDraftNotice") || {}).textContent || ""), "自動保存の案内が画面に無い");

    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(a.pkg, null, 2) + "\n"], "drafts.json", { type: "application/json" }));
    const inp = byId("abFileInput");
    inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    // 1. A/B各2枚
    await pickImage("A", "d-a1.png", 11);
    await pickImage("A", "d-a2.png", 12);
    await pickImage("B", "d-b1.png", 13);
    await pickImage("B", "d-b2.png", 14);
    note(store().images.length === 4, "A/B各2枚を登録できていない: " + store().images.length);

    // 2. 全画像評価
    const items = a.pkg.cases[0].priorityItems.map((i) => i.itemId);
    fillImage("A", 0, "hold", "3", "2", "A1", items);
    fillImage("A", 1, "accept", "4", "4", "A2", items);
    fillImage("B", 0, "accept", "5", "5", "B1", items);
    fillImage("B", 1, "hold", "2", "3", "B2", items);
    await delay(250);

    // 3. A1 と B1 を比較対象に選ぶ(既定は2枚目なので、明示的に1枚目へ変える)
    byId("abThumbsA").querySelectorAll("img")[0].click();
    byId("abThumbsB").querySelectorAll("img")[0].click();
    await delay(250);
    const wantA = thumbIds("A")[0], wantB = thumbIds("B")[0];
    note(selectedId("A") === wantA && selectedId("B") === wantB, "比較対象を1枚目へ変えられない");
    note(!!drafts()[a.caseKey], "比較対象を変えても下書きが作られていない");

    // 4. preference と比較コメント
    setVal("abPreference", a.pref);
    setVal("abCompareNotes", a.notes);
    await delay(250);
    const d = drafts()[a.caseKey];
    note(!!d, "preference/コメントの下書きが保存されていない");
    note(d && d.preference === a.pref && d.notes === a.notes
      && d.controlImageId === wantA && d.treatmentImageId === wantB,
      "下書きの中身が入力と違う: " + JSON.stringify(d));
    note(store().comparisons.length === 0, "保存前なのに comparison が作られている");
    note(byId("abCaseState").textContent !== "完了", "下書きだけでケースが完了になっている");

    const before = snapshot();

    // 5. ケース移動して戻る
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "case 2");
    note(byId("abPreference").value === "" && byId("abCompareNotes").value === "",
      "移動先へ前ケースの比較入力が漏れている");
    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "back to case 1");
    await delay(300);

    // 6. 完全一致
    const after = snapshot();
    note(JSON.stringify(before) === JSON.stringify(after),
      "ケース移動で比較入力が変わった: " + JSON.stringify(before) + " != " + JSON.stringify(after));
    note(after.preference === a.pref, "preference が消えた: " + after.preference);
    note(after.notes === a.notes, "比較コメントが消えた: " + after.notes);
    note(after.a === wantA && after.b === wantB, "比較対象が復元されない");

    return { pass: problems.length === 0, problems, before, wantA, wantB };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 7-13: 再読み込み -> 一致 -> 保存 -> 記録一致 -> 下書き削除 -> 再読み込みで記録復元
// ---------------------------------------------------------------------------
function phaseReloadSave(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench restored");
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    await waitFor(() => byId("abThumbsA").querySelectorAll("img").length === 2, "thumbs restored");
    await delay(400);

    // 8. 再読み込み後も完全一致
    const after = snapshot();
    note(JSON.stringify(after) === JSON.stringify(a.before),
      "再読み込みで比較入力が変わった: " + JSON.stringify(a.before) + " != " + JSON.stringify(after));

    // 9. 保存できる
    note(byId("abSaveNext").disabled === false,
      "全部揃っているのに保存できない: " + byId("abFlowState").textContent);

    // 10-11. 保存すると入力どおり記録される
    byId("abSaveNext").click();
    await waitFor(() => store().comparisons.length === 1, "comparison saved");
    const cmp = store().comparisons[0];
    note(cmp.preference === a.pref, "preference が記録と違う: " + cmp.preference);
    note(cmp.notes === a.notes, "比較コメントが記録と違う: " + cmp.notes);
    note(cmp.controlImageId === a.wantA && cmp.treatmentImageId === a.wantB,
      "比較対象が記録と違う: " + cmp.controlImageId + " / " + cmp.treatmentImageId);
    note(cmp.adoptionDecision === "not-applicable", "採用判定外でない");

    // 12. 下書きが消える
    note(!drafts()[a.caseKey], "保存後も比較下書きが残っている: " + JSON.stringify(drafts()));

    // 書き出しへ下書きが出ない
    const orig = URL.createObjectURL;
    let cap = null;
    URL.createObjectURL = function (b) { cap = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId("abExportComparisons").click();
    await waitS(/書き出しました/, "comparisons exported");
    const cmpRows = (await cap.text()).trim().split("\n").map((l) => JSON.parse(l));
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "reviews exported");
    const revRows = (await cap.text()).trim().split("\n").map((l) => JSON.parse(l));
    URL.createObjectURL = orig;
    note(cmpRows.length === 1 && !("comparisonDrafts" in cmpRows[0]) && !("draft" in cmpRows[0]),
      "比較JSONLへ下書きが出ている");
    note(cmpRows[0].preference === a.pref && cmpRows[0].notes === a.notes,
      "比較JSONLの内容が入力と違う");
    note(JSON.stringify(revRows).indexOf("comparisonDrafts") < 0, "レビューJSONLへ下書きが出ている");

    return { pass: problems.length === 0, problems, comparison: cmp };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 13,15: 保存済みの復元 / 保存済みを編集した下書きが再読み込みをまたいで残る
// ---------------------------------------------------------------------------
function phaseEditSaved(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    // 保存後は次の未完了ケースから再開するので、ケース1へ戻る
    if (!/ケース 1 \/ 2/.test(byId("abCaseCounter").textContent)) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    }
    await delay(400);

    // 13. 再読み込み後は保存済み comparison が復元される
    const restored = snapshot();
    note(restored.preference === a.pref && restored.notes === a.notes
      && restored.a === a.wantA && restored.b === a.wantB,
      "保存済み comparison が復元されない: " + JSON.stringify(restored));
    note(byId("abCaseState").textContent === "完了", "保存済みケースが完了になっていない");
    note(!drafts()[a.caseKey], "保存済みなのに下書きが残っている");

    // 15. 編集途中の下書きが残る
    setVal("abCompareNotes", a.editedNotes);
    setVal("abPreference", "tie");
    await delay(250);
    const d = drafts()[a.caseKey];
    note(!!d && d.notes === a.editedNotes && d.preference === "tie",
      "保存済みを編集した下書きが作られない: " + JSON.stringify(d));
    note(store().comparisons.length === 1, "編集しただけで comparison が増えた");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

function phaseEditSurvivesReload(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    if (!/ケース 1 \/ 2/.test(byId("abCaseCounter").textContent)) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    }
    await delay(400);
    const now = snapshot();
    note(now.notes === a.editedNotes && now.preference === "tie",
      "編集途中の下書きが再読み込みで消えた: " + JSON.stringify(now));
    note(store().comparisons.length === 1, "再読み込みで comparison が増減した");

    // 14a. 書き出し済み(=提出済み)の画像は外せない
    window.confirm = () => { problems.push("書き出し済み画像で確認ダイアログが出た"); return true; };
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await delay(200);
    const exportedId = selectedId("A");
    note(byId("abRemoveA").disabled === true, "書き出し済み画像の「外す」が押せてしまう");
    note(/書き出し済み/.test(byId("abRemoveA").textContent),
      "書き出し済みだと分かる表示になっていない: " + byId("abRemoveA").textContent);
    byId("abStatus").textContent = "";
    byId("abRemoveA").disabled = false;          // 直接呼んでも拒否されること
    byId("abRemoveA").click();
    await waitS(/提出した記録なので外せません/, "exported image protected");
    note(selectedId("A") === exportedId, "拒否したのに選択が変わった");
    note(store().invalidations.length === 0, "拒否したのに無効化が記録された");

    // 14b. 未書き出しの画像は従来どおり外せて、無効なIDが下書きへ残らない
    window.confirm = () => true;
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "case 2");
    await pickImage("A", "c2-a1.png", 201);
    await pickImage("A", "c2-a2.png", 202);
    await pickImage("B", "c2-b1.png", 203);
    setVal("abPreference", "A");
    setVal("abCompareNotes", "ケース2の下書き");
    await delay(250);
    byId("abThumbsA").querySelectorAll("img")[1].click();
    await delay(200);
    const removed = selectedId("A");
    byId("abStatus").textContent = "";
    byId("abRemoveA").click();
    await waitS(/画像を外しました/, "image removed");
    await delay(300);
    const key2 = "p2";
    const d = drafts()[key2];
    const ids = store().images.filter((r) => !store().invalidations.some((v) => v.imageId === r.imageId))
      .map((r) => r.imageId);
    note(!d || (d.controlImageId === "" || ids.indexOf(d.controlImageId) >= 0),
      "外した画像IDが下書きに残っている: " + JSON.stringify(d));
    note(selectedId("A") !== removed, "外した画像が選ばれたまま");

    // 14c. 外したあとに足しても rank は 1..N のまま（5,6 のような飛び番にしない）
    await pickImage("A", "c2-a3.png", 204);
    await delay(200);
    const live = store().images
      .filter((r) => r.caseKey === "p2" && r.arm === "A" && !store().invalidations.some((v) => v.imageId === r.imageId))
      .map((r) => r.rank).sort((x, y) => x - y);
    note(JSON.stringify(live) === JSON.stringify([1, 2]),
      "外して足した後の rank が 1..N になっていない: [" + live.join(",") + "]");

    return { pass: problems.length === 0, problems, draft: drafts()[key2] || null, ranks: live };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// comparisonDrafts を持たない既存記録もそのまま読める
// ---------------------------------------------------------------------------
function phaseLegacyStore(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    const s = store();
    note(!("comparisonDrafts" in s), "comparisonDrafts を消した記録なのにキーがある");
    note(s.images.length === a.images && s.reviews.length === a.reviews && s.comparisons.length === a.comparisons,
      "従来形の記録が読めていない: " + JSON.stringify({ i: s.images.length, r: s.reviews.length, c: s.comparisons.length }));
    if (!/ケース 1 \/ 2/.test(byId("abCaseCounter").textContent)) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    }
    await delay(400);
    const now = snapshot();
    note(now.preference === a.pref && now.notes === a.notes,
      "従来形の記録から保存済み comparison が復元されない: " + JSON.stringify(now));
    note(byId("abSetup").hidden === true, "従来形の記録で生成元の再入力を求めている");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 17: 画面幅ごとの崩れ
// ---------------------------------------------------------------------------
function phaseLayout(spec) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await delay(400);
    const de = document.documentElement;
    const overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow <= 1, a.label + " で横溢れしている: " + overflow + "px");
    const wide = [];
    byId("abView").querySelectorAll("*").forEach((n) => {
      if (n.scrollWidth > de.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, a.label + " で画面幅より広い要素がある: " + wide.slice(0, 5).join(", "));
    const notice = byId("abDraftNotice");
    note(!!notice && notice.getBoundingClientRect().width > 0, a.label + " で自動保存の案内が出ていない");
    note(notice.scrollWidth <= notice.clientWidth + 1, a.label + " で案内文が折り返されず溢れている");
    ["abPreference", "abCompareNotes"].forEach((id) => {
      const n = byId(id);
      const r = n.getBoundingClientRect();
      note(r.width > 0 && r.width <= de.clientWidth + 1, a.label + " の " + id + " が画面幅を超えている");
      note(parseFloat(getComputedStyle(n).fontSize) >= 16, a.label + " の " + id + " がiOSズームを招く文字サイズ");
    });
    return { pass: problems.length === 0, problems, label: a.label, vw: de.clientWidth, overflow };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const pkg = buildPackage();
  const caseKey = "p1";
  const editedNotes = "保存済みを編集し始めた比較コメント";
  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fe-"));
  const chrome = spawn(CHROME_PATH, [
    "--headless=new", "--disable-background-networking", "--disable-default-apps",
    "--disable-extensions", "--disable-gpu", "--disable-sync",
    "--no-default-browser-check", "--no-first-run", "--window-size=1280,900",
    "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let client = null;
  try {
    const browserWs = await waitForChromeWs(chrome);
    client = new CdpClient(browserWs);
    const target = await client.send("Target.createTarget", { url: baseUrl + "/" });
    const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(1500);

    const run = async (fn, label, arg, timeout = 180000) => {
      let source = fn.toString().replace("__PRELUDE__", PRELUDE);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      const evaluated = await client.send("Runtime.evaluate", {
        expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout,
      }, sessionId);
      if (evaluated.exceptionDetails) fail(`${label} threw`, evaluated.exceptionDetails);
      const value = evaluated.result && evaluated.result.value;
      if (!value || !value.pass) fail(`${label} failed`, value);
      return value;
    };

    const setup = await run(phaseSetupAndMove, "setup, evaluate, choose targets, move away and back",
      { pkg, caseKey, pref: PREF, notes: NOTES });

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    const saved = await run(phaseReloadSave, "reload keeps draft, save records it, draft cleared",
      { before: setup.before, wantA: setup.wantA, wantB: setup.wantB, caseKey, pref: PREF, notes: NOTES });

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    await run(phaseEditSaved, "saved comparison restored, editing creates a draft",
      { caseKey, pref: PREF, notes: NOTES, wantA: setup.wantA, wantB: setup.wantB, editedNotes });

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    const edited = await run(phaseEditSurvivesReload, "edit draft survives reload, removal prunes it",
      { caseKey, editedNotes });

    // comparisonDrafts を持たない従来形の記録へ戻して読み直す
    const counts = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const idx = JSON.parse(localStorage.getItem("personaGenerator.abWorkspaces.v1"));
        const w = (idx.workspaces || []).filter((x) => x.id === idx.activeId)[0];
        const abKey = () => w.storeKey;
        const raw = JSON.parse(localStorage.getItem(abKey()));
        delete raw.comparisonDrafts;
        localStorage.setItem(abKey(), JSON.stringify(raw));
        return { images: raw.images.length, reviews: raw.reviews.length, comparisons: raw.comparisons.length };
      })()`, returnByValue: true
    }, sessionId);
    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    await run(phaseLegacyStore, "records without comparisonDrafts still load",
      Object.assign({ pref: PREF, notes: NOTES }, counts.result.value));

    const specs = [
      { label: "320px", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "375px", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "390px", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "430px", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true },
      { label: "1280px", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }
    ];
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(400);
      layout.push(await run(phaseLayout, spec.label + " layout", spec));
    }

    console.log("R3-FE COMPARISON DRAFT BROWSER ACCEPTANCE PASSED");
    console.log(`  2 images per arm evaluated; A1/B1 chosen as compare targets with preference and notes`);
    console.log(`  moving to another case and back kept every field byte for byte`);
    console.log(`  reload kept them too; save wrote 1 comparison matching the input and cleared the draft`);
    console.log(`  saved comparison restored after reload; editing it created a draft that survived another reload`);
    console.log(`  removing the selected image left no dangling id in the draft (${JSON.stringify(edited.draft)})`);
    console.log(`  records without comparisonDrafts still load and restore the saved comparison`);
    console.log(`  drafts never reach the review or comparison JSONL`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
    console.log(`  saved comparison: preference=${saved.comparison.preference} notes=${JSON.stringify(saved.comparison.notes)}`);
  } finally {
    if (client) client.close();
    await closeChrome(chrome);
    await closeServer(server);
    await removeDirWithRetry(userDataDir);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  if (error && error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
  process.exit(1);
});
