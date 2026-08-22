#!/usr/bin/env node
// [R3-FD] 優先項目チェック(「重要要素の反映」)の**実ブラウザ**受入検査。
//
//  確かめること:
//   宣言の無い従来パッケージは従来どおり(見出しも保存形式も増えない) ->
//   priorityChecksRequired を宣言したパッケージだけ画像ごとに3択が出る ->
//   画像切替・A/B切替・ケース移動・再読み込みをまたいで入力が残る ->
//   1つでも未回答なら完了不可、全部揃うと保存できる ->
//   書き出しの画像数・評価数・priorityChecks数が一致し、missingPriorityCount は
//   status=missing だけを数える(unclear は換算しない) ->
//   デスクトップとiPhone各幅で横溢れ0・A/B整列・長い項目の折返しが崩れない。
//
//  このスクリプトが使うパッケージは**合成フィクスチャ**で、実験の実データは含まない。
//  使い捨てプロファイルのみ。外部ネットワークへは出ない。
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
      reject(new Error(`Chrome exited early: code=${code} signal=${signal} stderr=${stderr.slice(-800)}`));
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
// 合成パッケージ(実験の実データは使わない)
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

// 長い項目でも片側だけ崩れないことを見るため、意図的に長い合成ラベルを混ぜる。
const LONG_LABEL = "合成の長い重要要素。" + "折り返しの検査のために意味を持たない合成文をつないで長くしています。".repeat(3);
const PRIORITY_LABELS = {
  1: ["合成の重要要素 その一", "合成の重要要素 その二", "合成の重要要素 その三"],
  2: ["合成の重要要素 A", "合成の重要要素 B", LONG_LABEL, "合成の重要要素 D", "合成の重要要素 E"]
};

function buildLegacyPackage() {
  const insertText = "【合成テスト用の追加文】これはテスト専用のダミー指示です。";
  const cases = [1].map((n) => {
    const head = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 行目B`;
    const a = head + `\n合成プロンプト ${n} 末尾`;
    const insertOffset = head.length;
    const b = a.slice(0, insertOffset) + "\n" + insertText + a.slice(insertOffset);
    const settings = { schema: "t9_gen_settings.v1", salt: "legacy-" + n };
    return {
      sourceNo: n, baselineGenerationId: "gen-legacy-p001", role: "r", species: "s", reason: "fx",
      batchId: "legacy-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: "legacy-p001-A", role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false },
        B: { generationId: "legacy-p001-B", role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, insertOffset, anchorLine: `合成プロンプト ${n} 行目B` }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-01T00:00:00.000Z", generatedBy: "fixture-legacy",
    experiment: {
      experimentId: "fixture-legacy", hypothesis: "合成", insertionPoint: "合成",
      insertText, insertTextSha256: sha(insertText), holdConstant: ["model"], evaluationFocus: ["合成"]
    },
    policy: {
      arms: [{ id: "A", role: "control", label: "A" }, { id: "B", role: "treatment", label: "B" }],
      maxImagesPerArm: 5, verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    // 既存の顔融合パッケージと同じ書き出し先。従来のファイル名・記録IDが保たれること。
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-facial-fusion-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

function buildPriorityPackage() {
  const cases = [1, 2].map((n) => {
    const head = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 行目B`;
    const a = head + `\n合成プロンプト ${n} 末尾`;
    const b = "【合成の優先ブロック】\n" + PRIORITY_LABELS[n].map((l, i) => `${i + 1}. ${l}`).join("\n") + "\n" + a;
    const settings = { schema: "t9_gen_settings.v1", salt: "priority-" + n, controls: { density: n } };
    return {
      sourceNo: n, baselineGenerationId: "gen-priority-p" + String(n).padStart(3, "0"),
      role: "合成軸" + n, species: "", reason: "合成フィクスチャ",
      batchId: "priority-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      priorityItems: PRIORITY_LABELS[n].map((label, i) => ({
        itemId: "P" + (i + 1), label, clauseSha256: sha(label)
      })),
      arms: {
        A: {
          generationId: "priority-p" + String(n).padStart(3, "0") + "-A", role: "control",
          prompt: a, promptSha256: sha(a), treatmentApplied: false, diffSummary: "元のプロンプトのまま。"
        },
        B: {
          generationId: "priority-p" + String(n).padStart(3, "0") + "-B", role: "treatment",
          prompt: b, promptSha256: sha(b), treatmentApplied: true,
          treatmentRuleId: "FIXTURE-RULE",
          diffSummary: "合成の優先ブロックを冒頭へ入れています。",
          conflictOperations: [{ conflictId: "CF-FX-" + n, operation: "OP-C", targetSentenceSha256: sha("t" + n), appliedSentenceSha256: sha("u" + n) }],
          conflictOperationsSha256: sha("ops" + n)
        }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-02T00:00:00.000Z", generatedBy: "fixture-priority",
    experiment: {
      experimentId: "fixture-priority", hypothesis: "合成", insertionPoint: "合成",
      insertText: "", insertTextSha256: "", treatmentRuleSetId: "FIXTURE-RULE",
      holdConstant: ["model"], evaluationFocus: ["合成"],
      automaticProductionUpdate: false, seedSupported: false
    },
    policy: {
      arms: [{ id: "A", role: "control", label: "A 合成" }, { id: "B", role: "treatment", label: "B 合成" }],
      maxImagesPerArm: 2, requiredImagesPerArm: 2, priorityChecksRequired: true,
      priorityStatuses: ["present", "missing", "unclear"],
      // 画面の案内文はパッケージ側が持つ(公開UIへ実験固有の語を置かないため)
      compareNotesPlaceholder: "合成の比較案内文（AとBの違いを記録）",
      imageNotesPlaceholder: "合成の画像コメント案内文",
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-priority-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

// 改ざんではなく「意味が壊れた」パッケージ。integrity と definitionSha256 は
// 正しく計算し直すので、拒否できるのは意味の検査を持っている場合だけ。
function derive(base, mutate) {
  const next = JSON.parse(JSON.stringify(base));
  mutate(next);
  delete next.definitionSha256;
  delete next.integrity;
  next.definitionSha256 = sha(definitionText(next));
  next.integrity = { algorithm: "sha256", value: sha(JSON.stringify(next)) };
  return next;
}
function buildInvalidPackages(base) {
  return [
    { label: "priorityItems欠落", field: "priorityItems",
      pkg: derive(base, (p) => { delete p.cases[0].priorityItems; }) },
    { label: "priorityItems空配列", field: "priorityItems",
      pkg: derive(base, (p) => { p.cases[0].priorityItems = []; }) },
    { label: "itemId重複", field: "itemId",
      pkg: derive(base, (p) => { p.cases[0].priorityItems[1].itemId = p.cases[0].priorityItems[0].itemId; }) },
    { label: "label空", field: "label",
      pkg: derive(base, (p) => { p.cases[0].priorityItems[1].label = "   "; }) },
    { label: "itemId空", field: "itemId",
      pkg: derive(base, (p) => { p.cases[0].priorityItems[2].itemId = ""; }) },
    { label: "clauseSha256不一致", field: "clauseSha256",
      pkg: derive(base, (p) => { p.cases[0].priorityItems[0].clauseSha256 = sha("別の文字列"); }) },
    { label: "requiredImagesPerArmがmaxImagesPerArm超過", field: "requiredImagesPerArm",
      pkg: derive(base, (p) => { p.policy.requiredImagesPerArm = p.policy.maxImagesPerArm + 1; }) },
    { label: "requiredImagesPerArmが正の整数でない", field: "requiredImagesPerArm",
      pkg: derive(base, (p) => { p.policy.requiredImagesPerArm = 0; }) },
    { label: "未対応priority status", field: "priorityStatuses",
      pkg: derive(base, (p) => { p.policy.priorityStatuses = ["present", "missing", "unclear", "maybe"]; }) },
    { label: "2件目のケースの項目が壊れている", field: "priorityItems",
      pkg: derive(base, (p) => { p.cases[1].priorityItems = null; }) }
  ];
}

// ---------------------------------------------------------------------------
const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abFlowState")||{}).textContent||"")
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
  const files = async (name, seed) => {
    const blob = await makePng(seed);
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: "image/png" }));
    return dt.files;
  };
  const pickImage = async (arm, name, seed) => {
    byId("abStatus").textContent = "";
    const n = byId("abFile" + arm);
    n.files = await files(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitS(/画像を .* 枚置きました|登録できませんでした/, "image " + arm + " " + name);
  };
  const reviewSide = (arm, verdict, aesthetic, intent, notes) => {
    setVal("abRev" + arm + "_verdict", verdict);
    setVal("abRev" + arm + "_aestheticSatisfaction", aesthetic);
    setVal("abRev" + arm + "_intentMatch", intent);
    if (notes !== undefined) setVal("abRev" + arm + "_notes", notes);
  };
  // 優先項目は行のデータ属性から引く(画面にはIDもハッシュも出さないため)。
  const prioRows = (arm) => Array.prototype.slice.call(
    byId("abRev" + arm + "_priority").querySelectorAll("[data-ab-priority-id]"));
  const setPrio = (arm, itemId, status) => {
    const row = byId("abRev" + arm + "_priority").querySelector('[data-ab-priority-id="' + itemId + '"]');
    if (!row) { problems.push("missing priority row: " + arm + " " + itemId); return; }
    const sel = row.querySelector("select");
    sel.value = status;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const getPrio = (arm, itemId) => {
    const row = byId("abRev" + arm + "_priority").querySelector('[data-ab-priority-id="' + itemId + '"]');
    return row ? row.querySelector("select").value : null;
  };
  const setPrioAll = (arm, map) => { Object.keys(map).forEach((k) => setPrio(arm, k, map[k])); };
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
  const loadPkg = (pkg, name) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(pkg, null, 2) + "\\n"], name, { type: "application/json" }));
    const input = byId("abFileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  let lastExportStatus = "";
  const exportRows = async (id) => {
    const orig = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId(id).click();
    await waitS(/書き出しました/, "export " + id);
    lastExportStatus = st();
    const text = await captured.text();
    URL.createObjectURL = orig;
    return text.trim().split("\\n").map((l) => JSON.parse(l));
  };
  const loadAndExpectRejected = async (pkg, name, label) => {
    byId("abPackageStatus").textContent = "";
    loadPkg(pkg, name);
    await waitFor(() => /使えません|読み込みました|中止しました|記録はそのまま/.test(byId("abPackageStatus").textContent),
      "verdict for " + label);
    return byId("abPackageStatus").textContent;
  };
`;

// ---------------------------------------------------------------------------
// シナリオ1: 宣言の無い従来パッケージは従来どおり
// ---------------------------------------------------------------------------
function phaseLegacy(pkg) {
  return (async (p) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    loadPkg(p, "legacy.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "legacy loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    // 案内文が実験固有の語に依存していない(パッケージが文言を持たないので汎用文)
    note(byId("abCompareNotes").placeholder === "AとBの違い、美的満足度、意図の反映について記録",
      "比較コメントの汎用案内が出ていない: " + byId("abCompareNotes").placeholder);

    await pickImage("A", "legacy-a1.png", 11);
    note(byId("abRevA_priorityHead").hidden === true, "宣言が無いのに『重要要素の反映』の見出しが出ている");
    note(prioRows("A").length === 0, "宣言が無いのに優先項目の行が出ている");
    note(byId("abRevA_notes").placeholder === "コメント（気づいた点を自由に記録）",
      "画像コメントの汎用案内が出ていない: " + byId("abRevA_notes").placeholder);

    // 従来どおり片側だけでも保存でき、preference も不要
    reviewSide("A", "hold", "3", "2", "従来の記録");
    await waitFor(() => !byId("abSaveNext").disabled, "legacy single-side enabled");
    note(byId("abSaveNext").textContent === "A の全画像評価を保存する",
      "従来の保存ボタン文言が変わっている: " + byId("abSaveNext").textContent);

    // B 側も置いて、両面の書き出し形をそのまま確かめる
    await pickImage("B", "legacy-b1.png", 12);
    reviewSide("B", "accept", "4", "4", "従来のB");
    setVal("abPreference", "B");
    await waitFor(() => !byId("abSaveNext").disabled, "legacy both enabled");
    note(byId("abSaveNext").textContent === "全2枚の評価と比較を保存して次へ",
      "従来の両面保存文言が変わっている: " + byId("abSaveNext").textContent);
    byId("abSaveNext").click();
    await waitFor(() => store().reviews.length === 2, "legacy saved");

    const rows = await exportRows("abExportReviews");
    const rowA = rows.filter((r) => r.experiment.arm === "A")[0];
    const rowB = rows.filter((r) => r.experiment.arm === "B")[0];
    const ev = rowA.images[0].evaluation;
    note(rowA.schemaVersion === "persona-prompt-review.v2", "従来のレビュースキーマが変わっている");
    note(Object.keys(ev).join(",") === "verdict,aestheticSatisfaction,intentMatch,failures",
      "従来の evaluation にキーが増えている: " + Object.keys(ev).join(","));
    note(!("priorityChecks" in ev) && !("missingPriorityCount" in ev),
      "宣言が無いのに priorityChecks が出ている");
    note(rowA.experiment.insertText === "" && rowA.experiment.insertOffset === null,
      "従来の A 側 insertText/insertOffset が変わっている");
    note(rowB.experiment.insertText === p.experiment.insertText,
      "従来の insertText が変わっている: " + rowB.experiment.insertText);
    note(rowB.experiment.insertOffset === p.cases[0].arms.B.insertOffset,
      "従来の insertOffset が変わっている: " + rowB.experiment.insertOffset);
    note(/A に指定の1文を足しただけ/.test(byId("abDiffB").textContent),
      "従来の1文挿入型の差分説明が変わっている: " + byId("abDiffB").textContent);
    note(store().reviews.every((r) => !("priorityChecks" in r)),
      "宣言が無いのに保存行へ priorityChecks が入っている");

    // 顔融合パッケージは従来のファイル名・記録IDのまま
    note(/書き出しました: facial-fusion-ab-reviews_\d{8}-\d{6}\.jsonl/.test(lastExportStatus),
      "従来のレビュー書き出し名が変わっている: " + lastExportStatus);
    note(rowA.reviewId === "ffrev-" + p.experiment.experimentId + "-p" + p.cases[0].sourceNo + "-A"
      && rowB.reviewId === "ffrev-" + p.experiment.experimentId + "-p" + p.cases[0].sourceNo + "-B",
      "従来の記録IDが変わっている: " + rowA.reviewId + " / " + rowB.reviewId);
    await exportRows("abExportComparisons");
    note(/書き出しました: facial-fusion-ab-comparisons_\d{8}-\d{6}\.jsonl/.test(lastExportStatus),
      "従来の比較書き出し名が変わっている: " + lastExportStatus);
    byId("abStatus").textContent = "";
    byId("abExportCopyList").click();
    await waitS(/書き出しました/, "legacy copy list");
    note(/書き出しました: facial-fusion-ab-image-copy-list_\d{8}-\d{6}\.tsv/.test(st()),
      "従来のコピーリスト名が変わっている: " + st());

    return { pass: problems.length === 0, problems, legacyReviews: store().reviews.length,
      legacyReviewId: rowA.reviewId };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// シナリオ2-3,7-8: 優先対応パッケージ読込 -> 2+2枚 -> 未回答は完了不可 -> 全部で保存可
// ---------------------------------------------------------------------------
function phasePriorityLoad(pkg) {
  return (async (p) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(p, "priority.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "priority loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    // 案内文はパッケージ側の文言を使う
    note(byId("abCompareNotes").placeholder === p.policy.compareNotesPlaceholder,
      "比較コメントの案内がパッケージ由来でない: " + byId("abCompareNotes").placeholder);

    // 空状態: 画像が無くても未入力の内訳が日本語で出る
    note(/未入力 \d+ 件/.test(byId("abFlowState").textContent),
      "空状態で未入力件数が出ていない: " + byId("abFlowState").textContent);
    note(/画像があと 2 枚/.test(byId("abFlowState").textContent),
      "必要枚数が案内されていない: " + byId("abFlowState").textContent);

    await pickImage("A", "p-a1.png", 21);
    note(byId("abRevA_notes").placeholder === p.policy.imageNotesPlaceholder,
      "画像コメントの案内がパッケージ由来でない: " + byId("abRevA_notes").placeholder);
    note(byId("abRevA_priorityHead").hidden === false, "『重要要素の反映』の見出しが出ていない");
    note(byId("abRevA_priorityHead").textContent === "重要要素の反映",
      "見出しの文言が違う: " + byId("abRevA_priorityHead").textContent);
    const rows = prioRows("A");
    note(rows.length === 3, "ケース1の項目数が3でない: " + rows.length);
    const labels = rows.map((r) => r.querySelector(".ab-priority-label").textContent);
    note(JSON.stringify(labels) === JSON.stringify(p.cases[0].priorityItems.map((i) => i.label)),
      "項目の短文が違う: " + labels.join(" | "));
    const opts = rows[0].querySelectorAll("select option");
    note(opts.length === 4 && opts[1].textContent === "出ている"
      && opts[2].textContent === "欠けている" && opts[3].textContent === "判断困難",
      "3択の文言が違う: " + Array.prototype.map.call(opts, (o) => o.textContent).join("/"));
    note(opts[1].value === "present" && opts[2].value === "missing" && opts[3].value === "unclear",
      "保存値が present/missing/unclear でない");
    // 画面へ内部IDやハッシュを出していない
    const shown = byId("abRevA_priority").textContent;
    note(shown.indexOf("P1") < 0 && shown.indexOf(p.cases[0].priorityItems[0].clauseSha256.slice(0, 12)) < 0,
      "内部IDかハッシュが画面へ出ている");

    await pickImage("A", "p-a2.png", 22);
    await pickImage("B", "p-b1.png", 23);
    await pickImage("B", "p-b2.png", 24);
    note(store().images.length === 4, "2枚ずつ登録されていない: " + store().images.length);
    // 上限2枚: 3枚目は拒否
    await pickImage("A", "p-a3.png", 25);
    note(/上限/.test(st()) && store().images.length === 4, "上限2枚が効いていない: " + st());

    // 2枚目(選択中)を全部入れる -> それでも1枚目が未入力なので保存できない
    reviewSide("A", "accept", "4", "4", "A2");
    setPrioAll("A", { P1: "present", P2: "present", P3: "present" });
    reviewSide("B", "hold", "3", "3", "B2");
    setPrioAll("B", { P1: "unclear", P2: "unclear", P3: "unclear" });
    setVal("abPreference", "A");
    await delay(150);
    note(byId("abSaveNext").disabled === true, "1枚目が未入力なのに保存できる");

    // 1枚目へ戻って判定とスコアだけ入れる -> 優先項目が未回答なので保存不可(シナリオ7)
    byId("abThumbsA").querySelectorAll("img")[0].click();
    byId("abThumbsB").querySelectorAll("img")[0].click();
    await delay(150);
    reviewSide("A", "hold", "2", "4", "A1");
    reviewSide("B", "reject", "1", "2", "B1");
    await delay(150);
    note(byId("abSaveNext").disabled === true, "優先項目が未回答なのに保存できる");
    note(/重要要素の反映が \d+ 件/.test(byId("abFlowState").textContent),
      "未回答の内訳が出ていない: " + byId("abFlowState").textContent);
    const before = byId("abFlowState").textContent;

    setPrioAll("A", { P1: "present", P2: "missing" });
    await delay(150);
    note(byId("abSaveNext").disabled === true, "1項目残っているのに保存できる");
    note(byId("abFlowState").textContent !== before, "未入力件数が減っていない");

    setPrio("A", "P3", "unclear");
    setPrioAll("B", { P1: "missing", P2: "missing", P3: "unclear" });
    await delay(200);
    note(byId("abSaveNext").disabled === false,
      "全項目を入れても保存できない: " + byId("abFlowState").textContent);
    note(byId("abSaveNext").textContent === "全4枚の評価と比較を保存して次へ",
      "保存ボタンの文言が違う: " + byId("abSaveNext").textContent);
    note(byId("abCaseState").textContent !== "完了", "保存前から完了になっている");

    return { pass: problems.length === 0, problems, images: store().images.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// シナリオ4-5: 画像切替・A/B切替・ケース移動をまたいで入力が残る
// ---------------------------------------------------------------------------
function phaseRetention() {
  return (async () => {
    __PRELUDE__
    // 4. 1枚目 -> 2枚目 -> 1枚目 で全入力が残る
    byId("abThumbsA").querySelectorAll("img")[1].click();
    await waitFor(() => byId("abRevA_notes").value === "A2", "A2 shown");
    note(getPrio("A", "P1") === "present" && getPrio("A", "P2") === "present" && getPrio("A", "P3") === "present",
      "2枚目の優先項目が残っていない");
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await waitFor(() => byId("abRevA_notes").value === "A1", "A1 restored");
    note(byId("abRevA_verdict").value === "hold" && byId("abRevA_aestheticSatisfaction").value === "2"
      && byId("abRevA_intentMatch").value === "4", "1枚目の判定・スコアが消えた");
    note(getPrio("A", "P1") === "present" && getPrio("A", "P2") === "missing" && getPrio("A", "P3") === "unclear",
      "1枚目の優先項目が消えた: " + [getPrio("A", "P1"), getPrio("A", "P2"), getPrio("A", "P3")].join(","));
    byId("abThumbsB").querySelectorAll("img")[1].click();
    await waitFor(() => byId("abRevB_notes").value === "B2", "B2 shown");
    note(getPrio("B", "P1") === "unclear", "A/B切替でBの優先項目が消えた");
    byId("abThumbsB").querySelectorAll("img")[0].click();
    await waitFor(() => byId("abRevB_notes").value === "B1", "B1 restored");
    note(getPrio("B", "P1") === "missing" && getPrio("B", "P3") === "unclear", "Bの1枚目の優先項目が消えた");

    // 5. ケース移動しても戻れば残る。移動先の項目数は5件。
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "case 2");
    await pickImage("A", "c2-a1.png", 51);
    note(prioRows("A").length === 5, "ケース2の項目数が5でない: " + prioRows("A").length);
    note(getPrio("A", "P1") === "", "ケース移動で前ケースの回答が残っている");
    setPrio("A", "P1", "present");
    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "back to case 1");
    note(prioRows("A").length === 3, "戻ったのに項目数がケース1でない: " + prioRows("A").length);
    // ケースへ戻ると、離れる直前に選んでいた比較対象(1枚目)がそのまま復元される。
    await waitFor(() => byId("abRevA_notes").value === "A1" && byId("abRevB_notes").value === "B1",
      "case1 selected images restored");
    note(getPrio("A", "P1") === "present" && getPrio("A", "P2") === "missing" && getPrio("A", "P3") === "unclear",
      "ケース移動後に優先項目が消えた: " + [getPrio("A", "P1"), getPrio("A", "P2"), getPrio("A", "P3")].join(","));
    note(getPrio("B", "P1") === "missing" && getPrio("B", "P3") === "unclear",
      "ケース移動後にBの優先項目が消えた");
    // 2枚目の入力も残っている
    byId("abThumbsA").querySelectorAll("img")[1].click();
    byId("abThumbsB").querySelectorAll("img")[1].click();
    await waitFor(() => byId("abRevA_notes").value === "A2" && byId("abRevB_notes").value === "B2",
      "case1 second images restored");
    note(getPrio("A", "P1") === "present" && getPrio("A", "P3") === "present",
      "ケース移動後に2枚目の優先項目が消えた");
    note(Object.keys(store().reviewDrafts || {}).length === 5,
      "画像ごとの下書きが5件でない: " + Object.keys(store().reviewDrafts || {}).length);
    return { pass: problems.length === 0, problems, drafts: Object.keys(store().reviewDrafts || {}).length };
  })();
}

// ---------------------------------------------------------------------------
// シナリオ6, 8-11: 再読み込み復元 -> 保存 -> 書き出しの一致
// ---------------------------------------------------------------------------
function phaseReloadSaveExport(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench restored");

    // 6. 再読み込み後も全画像の入力が復元される
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    await waitFor(() => byId("abThumbsA").querySelectorAll("img").length === 2, "thumbs restored");
    // 再開時は最後の画像が選ばれる(既存挙動)。2枚目 -> 1枚目 -> 2枚目 の順に全画像を確かめる。
    await waitFor(() => byId("abRevA_notes").value === "A2" && byId("abRevB_notes").value === "B2",
      "second images restored after reload");
    note(getPrio("A", "P1") === "present" && getPrio("A", "P2") === "present" && getPrio("A", "P3") === "present",
      "再読み込みでAの2枚目の優先項目が復元されない");
    note(getPrio("B", "P1") === "unclear" && getPrio("B", "P3") === "unclear",
      "再読み込みでBの2枚目の優先項目が復元されない");
    byId("abThumbsA").querySelectorAll("img")[0].click();
    byId("abThumbsB").querySelectorAll("img")[0].click();
    await waitFor(() => byId("abRevA_notes").value === "A1" && byId("abRevB_notes").value === "B1",
      "first images restored after reload");
    note(byId("abRevA_verdict").value === "hold" && byId("abRevA_aestheticSatisfaction").value === "2",
      "再読み込みで1枚目の判定・スコアが復元されない");
    note(getPrio("A", "P1") === "present" && getPrio("A", "P2") === "missing" && getPrio("A", "P3") === "unclear",
      "再読み込みでAの1枚目の優先項目が復元されない");
    note(getPrio("B", "P1") === "missing" && getPrio("B", "P2") === "missing" && getPrio("B", "P3") === "unclear",
      "再読み込みでBの1枚目の優先項目が復元されない");
    byId("abThumbsA").querySelectorAll("img")[1].click();
    byId("abThumbsB").querySelectorAll("img")[1].click();
    await waitFor(() => byId("abRevA_notes").value === "A2" && byId("abRevB_notes").value === "B2",
      "back to second images");

    // 8. 比較の入力も再読み込みをまたいで残るので、そのまま保存できる
    note(byId("abPreference").value === "A",
      "再読み込みで preference が消えた: " + byId("abPreference").value);
    setVal("abCompareNotes", "合成の比較コメント");
    await waitFor(() => !byId("abSaveNext").disabled, "save enabled after reload");
    byId("abSaveNext").click();
    await waitFor(() => store().reviews.length >= 4, "saved");
    const s = store();
    note(s.reviews.length === 4, "レビューが4件でない: " + s.reviews.length);
    note(s.comparisons.length === 1, "比較が1件でない: " + s.comparisons.length);
    note(s.reviews.every((r) => Array.isArray(r.priorityChecks) && r.priorityChecks.length === 3),
      "保存行に priorityChecks が3件ずつ入っていない");

    // 9-11. 書き出し
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "advanced");
    const rows = await exportRows("abExportReviews");
    const c1 = rows.filter((r) => r.experiment.sourceNo === 1);
    note(c1.length === 2, "ケース1のレビュー行が2本でない: " + c1.length);
    const all = c1.reduce((acc, r) => acc.concat(r.images), []);
    note(all.length === 4, "書き出しの画像数が4でない: " + all.length);
    note(all.every((im) => !!im.evaluation.verdict && !!im.evaluation.aestheticSatisfaction
      && !!im.evaluation.intentMatch), "書き出しの評価が欠けている");
    note(all.every((im) => Array.isArray(im.evaluation.priorityChecks)
      && im.evaluation.priorityChecks.length === 3), "priorityChecks の件数が画像数と一致しない");
    note(all.every((im) => im.evaluation.priorityChecks.every((pc) =>
      typeof pc.itemId === "string" && ["present", "missing", "unclear"].indexOf(pc.status) >= 0)),
      "priorityChecks の形が {itemId,status} でない");

    const rowA = c1.filter((r) => r.experiment.arm === "A")[0];
    const rowB = c1.filter((r) => r.experiment.arm === "B")[0];
    const a1 = rowA.images[0].evaluation, a2 = rowA.images[1].evaluation;
    const b1 = rowB.images[0].evaluation, b2 = rowB.images[1].evaluation;
    // 10. missing だけを数える
    note(a1.missingPriorityCount === 1, "A1 の missingPriorityCount が1でない: " + a1.missingPriorityCount);
    note(a2.missingPriorityCount === 0, "A2 の missingPriorityCount が0でない: " + a2.missingPriorityCount);
    note(b1.missingPriorityCount === 2, "B1 の missingPriorityCount が2でない: " + b1.missingPriorityCount);
    // 11. unclear は missing へ換算しない
    note(b2.priorityChecks.every((pc) => pc.status === "unclear") && b2.missingPriorityCount === 0,
      "unclear が missing へ数えられている: " + b2.missingPriorityCount);
    note(a1.priorityChecks.filter((pc) => pc.status === "unclear").length === 1
      && a1.missingPriorityCount === 1, "unclear 混在時の集計が合わない");
    // 既存キーは変わっていない
    note(rowA.schemaVersion === "persona-prompt-review.v2", "レビューJSONLのスキーマが変わっている");
    note(rowA.source.prompt === a.promptA1, "書き出しの本文が変わっている");
    note(typeof a1.aestheticSatisfaction === "string", "スコアが v2 の文字列形でない");
    note(rowA.experiment.adoptionDecision === "not-applicable", "採用判定外でない");
    note(rowA.experiment.insertText === "" && rowA.experiment.insertOffset === null,
      "1文挿入型でないのに insertText/insertOffset が出ている");
    // 書き出し名と記録IDは experimentId 由来の slug。旧実験名を引かない。
    note(/書き出しました: fixture-priority-reviews_\d{8}-\d{6}\.jsonl/.test(lastExportStatus),
      "新形式のレビュー書き出し名になっていない: " + lastExportStatus);
    note(lastExportStatus.indexOf("facial-fusion-ab") < 0, "新形式なのに旧実験名が出ている: " + lastExportStatus);
    note(rowA.reviewId === "fixture-priority-rev-p1-A" && rowB.reviewId === "fixture-priority-rev-p1-B",
      "新形式の記録IDになっていない: " + rowA.reviewId + " / " + rowB.reviewId);
    note(rows.every((r) => r.reviewId.indexOf("ffrev-") !== 0), "新形式なのに ffrev- が残っている");

    const cmpRows = await exportRows("abExportComparisons");
    note(cmpRows.length === 1 && !("priorityChecks" in cmpRows[0]),
      "比較JSONLの既存キーが変わっている");
    note(cmpRows[0].adoptionDecision === "not-applicable", "比較が採用判定外でない");
    note(/書き出しました: fixture-priority-comparisons_\d{8}-\d{6}\.jsonl/.test(lastExportStatus),
      "新形式の比較書き出し名になっていない: " + lastExportStatus);
    byId("abStatus").textContent = "";
    byId("abExportCopyList").click();
    await waitS(/書き出しました/, "copy list");
    note(/書き出しました: fixture-priority-image-copy-list_\d{8}-\d{6}\.tsv/.test(st()),
      "新形式のコピーリスト名になっていない: " + st());

    return { pass: problems.length === 0, problems, exported: all.length, reviewId: rowA.reviewId };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// シナリオ13: 画面幅ごとの横溢れ・A/B整列・折返し
// ---------------------------------------------------------------------------
function phaseLayout(spec) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await delay(500);
    const label = a.label;
    const vw = document.documentElement.clientWidth;
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note(overflow <= 1, label + " で横溢れしている: " + overflow + "px");
    const wide = [];
    byId("abView").querySelectorAll("*").forEach((n) => {
      if (n.scrollWidth > document.documentElement.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, label + " で画面幅より広い要素がある: " + wide.slice(0, 5).join(", "));

    // 長い項目でも折り返す(1行に収まりきらず横へはみ出さない)
    const rows = prioRows("A");
    note(rows.length > 0, label + " で優先項目が出ていない");
    rows.forEach((r, i) => {
      const lab = r.querySelector(".ab-priority-label");
      note(lab.scrollWidth <= lab.clientWidth + 1,
        label + " の項目" + (i + 1) + " が折り返されず横へはみ出している: "
        + lab.scrollWidth + " > " + lab.clientWidth);
      const sel = r.querySelector("select").getBoundingClientRect();
      note(sel.height >= 44, label + " の項目" + (i + 1) + " の選択欄が44px未満: " + Math.round(sel.height));
      note(parseFloat(getComputedStyle(r.querySelector("select")).fontSize) >= 16,
        label + " の項目" + (i + 1) + " がiOSズームを招く文字サイズ");
    });

    // A/B の整列: 上端・画像領域・評価欄・カード下端
    if (vw >= 720) {
      const sideA = document.querySelector('[data-ab-side="A"]').getBoundingClientRect();
      const sideB = document.querySelector('[data-ab-side="B"]').getBoundingClientRect();
      const copyA = byId("abCopyA").getBoundingClientRect();
      const copyB = byId("abCopyB").getBoundingClientRect();
      const bigA = byId("abBigA").getBoundingClientRect();
      const bigB = byId("abBigB").getBoundingClientRect();
      const revA = byId("abReviewA").getBoundingClientRect();
      const revB = byId("abReviewB").getBoundingClientRect();
      note(Math.abs(sideA.top - sideB.top) <= 1, label + " でカード上端がずれている");
      note(Math.abs(copyA.top - copyB.top) <= 1, label + " で主要操作の上端がずれている");
      note(Math.abs(bigA.top - bigB.top) <= 1,
        label + " で画像領域の上端がずれている: " + JSON.stringify({ A: bigA.top, B: bigB.top }));
      note(Math.abs(revA.top - revB.top) <= 1,
        label + " で評価欄の上端がずれている: " + JSON.stringify({ A: revA.top, B: revB.top }));
      note(Math.abs(sideA.bottom - sideB.bottom) <= 1,
        label + " でカード下端がずれている: " + JSON.stringify({ A: sideA.bottom, B: sideB.bottom }));
    }
    // 主要操作は44px以上
    ["abPrev", "abNext", "abJumpIncomplete", "abSaveNext", "abCopyA", "abCopyB"].forEach((id) => {
      const r = byId(id).getBoundingClientRect();
      note(r.width > 0 && r.height >= 44, label + " の " + id + " が44px未満");
    });
    return { pass: problems.length === 0, problems, label, overflow, vw, items: rows.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 意味の壊れた優先項目パッケージは、作業台へ反映せず日本語で理由を出す
// ---------------------------------------------------------------------------
function phaseRejectInvalid(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => { problems.push("拒否すべきパッケージで確認ダイアログが出た"); return false; };
    const before = {
      prompt: byId("abPromptA").value,
      items: prioRows("A").length,
      images: store().images.length,
      reviews: store().reviews.length,
      pkgId: store().pkg.experiment.experimentId,
      defSha: store().pkg.definitionSha256
    };
    const seen = [];
    for (const bad of a.invalid) {
      const text = await loadAndExpectRejected(bad.pkg, "invalid.json", bad.label);
      seen.push(bad.label + " => " + text.slice(0, 90));
      note(/使えません/.test(text), bad.label + " が拒否されなかった: " + text);
      note(text.indexOf(bad.field) >= 0, bad.label + " の理由に " + bad.field + " が出ていない: " + text);
      // 英語のスタックや undefined ではなく、日本語の説明であること
      note(/[ぁ-んァ-ヶ一-龥]/.test(text.replace(/^[^:]*:/, "")),
        bad.label + " の理由が日本語でない: " + text);
      note(text.indexOf("undefined") < 0 || bad.field === "requiredImagesPerArm",
        bad.label + " の理由に undefined が出ている: " + text);
      // 作業台は前のパッケージのまま
      note(byId("abWorkbench").hidden === false, bad.label + " で作業台が消えた");
      note(byId("abPromptA").value === before.prompt, bad.label + " で本文が差し替わった");
      note(prioRows("A").length === before.items, bad.label + " で優先項目が差し替わった");
      const now = store();
      note(now.pkg.experiment.experimentId === before.pkgId && now.pkg.definitionSha256 === before.defSha,
        bad.label + " で保存済みパッケージが差し替わった");
      note(now.images.length === before.images && now.reviews.length === before.reviews,
        bad.label + " で記録が変わった");
    }
    return { pass: problems.length === 0, problems, count: a.invalid.length, seen };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// エラー状態: 改ざんパッケージを拒否しても画面が壊れない
// ---------------------------------------------------------------------------
function phaseErrorState(arg) {
  return (async (a) => {
    __PRELUDE__
    const shown = byId("abPromptA").value;
    loadPkg(a.tampered, "tampered.json");
    await waitFor(() => /使えません/.test(byId("abPackageStatus").textContent), "tampered rejected");
    note(byId("abPromptA").value === shown, "拒否したのに本文が差し替わった");
    note(byId("abWorkbench").hidden === false, "拒否で作業台が消えた");
    note(prioRows("A").length > 0, "拒否で優先項目が消えた");
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note(overflow <= 1, "エラー表示で横溢れしている: " + overflow);
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const legacyPkg = buildLegacyPackage();
  const priorityPkg = buildPriorityPackage();
  const tampered = JSON.parse(JSON.stringify(priorityPkg));
  tampered.cases[0].arms.B.prompt += "改ざん";

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fd-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fd-dl-"));
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
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allow", downloadPath: downloadDir
    });
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

    const legacy = await run(phaseLegacy, "legacy package unchanged", legacyPkg);
    const loaded = await run(phasePriorityLoad, "priority package gating", priorityPkg);
    const retained = await run(phaseRetention, "input retention across switches");

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    const exported = await run(phaseReloadSaveExport, "reload restore, save, export", {
      promptA1: priorityPkg.cases[0].arms.A.prompt
    });

    // 保存済みケース1へ戻して、A/B 2枚ずつ・優先項目ありの状態でレイアウトを見る
    await run(function backToCase1() {
      return (async () => {
        __PRELUDE__
        byId("abPrev").click();
        await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
        await waitFor(() => byId("abBigA").hidden === false && byId("abBigB").hidden === false, "both previews");
        return { pass: problems.length === 0, problems };
      })();
    }, "back to case 1");

    const layoutSpecs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320 portrait", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375 portrait", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390 portrait", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430 portrait", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true },
    ];
    const layoutResults = [];
    for (const spec of layoutSpecs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layoutResults.push(await run(phaseLayout, "3 items / " + spec.label, spec));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(500);

    // 5項目・長文ラベルのケースでも同じ基準で見る
    await run(function toCase2() {
      return (async () => {
        __PRELUDE__
        byId("abNext").click();
        await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "case 2");
        if (byId("abThumbsA").querySelectorAll("img").length < 2) {
          await pickImage("A", "c2-a2.png", 52);
        }
        if (byId("abThumbsB").querySelectorAll("img").length < 2) {
          await pickImage("B", "c2-b1.png", 53);
          await pickImage("B", "c2-b2.png", 54);
        }
        await waitFor(() => byId("abBigA").hidden === false && byId("abBigB").hidden === false, "both previews");
        note(prioRows("A").length === 5 && prioRows("B").length === 5,
          "ケース2の項目数が5でない: " + prioRows("A").length + "/" + prioRows("B").length);
        return { pass: problems.length === 0, problems };
      })();
    }, "prepare case 2 (5 items incl. long label)");

    for (const spec of layoutSpecs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layoutResults.push(await run(phaseLayout, "5 items / " + spec.label, spec));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(500);

    const rejected = await run(phaseRejectInvalid, "invalid priority packages refused",
      { invalid: buildInvalidPackages(priorityPkg) });
    await run(phaseErrorState, "tampered package error state", { tampered });

    console.log("R3-FD PRIORITY CHECK BROWSER ACCEPTANCE PASSED");
    console.log(`  legacy package unchanged: no heading, one-sided save intact, ${legacy.legacyReviews} review with no extra evaluation keys`);
    console.log(`  priority package gated: ${loaded.images} images (2 per arm, 3rd refused), unanswered items block completion`);
    console.log(`  inputs survived image switch, A/B switch and case moves (${retained.drafts} per-image drafts)`);
    console.log(`  reload restored every image's inputs; save wrote priorityChecks on all 4 reviews`);
    console.log(`  export matched: ${exported.exported} images, ${exported.exported} evaluations, ${exported.exported} priorityChecks sets; unclear never counted as missing`);
    console.log(`  layout (${layoutResults.length} passes): ${layoutResults.map((r) => `${r.vw}px/${r.items}items overflow ${r.overflow}px`).join(" | ")}`);
    console.log(`  legacy export names kept: ${legacy.legacyReviewId} / facial-fusion-ab-*`);
    console.log(`  new export names derived from experimentId: ${exported.reviewId} / fixture-priority-*`);
    console.log(`  ${rejected.count} semantically invalid priority packages refused with a Japanese reason, workbench untouched`);
    console.log(`  tampered package refused without breaking the workbench`);
  } finally {
    if (client) client.close();
    await closeChrome(chrome);
    await closeServer(server);
    await removeDirWithRetry(userDataDir);
    await removeDirWithRetry(downloadDir);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  if (error && error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
  process.exit(1);
});
