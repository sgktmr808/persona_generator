#!/usr/bin/env node
// [R3-FF] 追加レビュー(再標本)のラウンドで、提出済みの画像と評価が失われないことの
//  **実ブラウザ**受入検査。
//
//  実際に起きた不具合の再現と回帰:
//   1. 初回レビューを書き出した後、同じケースへ画像を足す運用で、
//      初回の画像を「外す」と最終書き出しから消えてしまい、初回の評価も届かなかった。
//   2. 外したあとに足した画像の順位が 5・6 になり、提出物の順位が 1..N で揃わなかった。
//
//  期待する挙動:
//   - 書き出し済み(=提出済み)の画像は外せない。ボタンも押せない表示になる。
//   - 未書き出しの画像は従来どおり外せる。
//   - 外して足しても順位は 1..N のまま詰まる(3・4 になり 5・6 にならない)。
//   - 最終書き出しに初回分と追加分の両方が入る。評価も初回のまま残る。
//   - デスクトップと iPhone の主要幅で崩れない。
//
//  合成フィクスチャだけを使う。実験の実データ・本文・パッケージは扱わない。
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
function sha(text) { return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"); }
function definitionText(pkg) {
  return JSON.stringify({ experiment: pkg.experiment, policy: pkg.policy, exportTargets: pkg.exportTargets, cases: pkg.cases });
}
// 各面2枚必須・最大4枚。再標本ラウンドと同じ形の合成パッケージ。
function buildPackage() {
  const cases = [1, 2].map((n) => {
    const a = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 末尾`;
    const b = "【合成の追加ブロック】\n" + a;
    const settings = { schema: "t9_gen_settings.v1", salt: "rs-" + n };
    return {
      sourceNo: n, baselineGenerationId: "gen-rs-p" + n, role: "合成", species: "", reason: "合成",
      batchId: "rs-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      priorityItems: [1, 2, 3].map((i) => ({ itemId: "P" + i, label: `合成の重要要素 ${n}-${i}`, clauseSha256: sha(`合成の重要要素 ${n}-${i}`) })),
      arms: {
        A: { generationId: `rs-p${n}-A`, role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false, diffSummary: "この面の本文を使ってください。" },
        B: { generationId: `rs-p${n}-B`, role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, diffSummary: "この面の本文を使ってください。" }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-11T00:00:00.000Z", generatedBy: "fixture-resample",
    experiment: {
      experimentId: "fixture-resample", hypothesis: "合成", insertionPoint: "合成",
      insertText: "", insertTextSha256: "", holdConstant: ["model"], evaluationFocus: ["合成"],
      automaticProductionUpdate: false, seedSupported: false
    },
    policy: {
      arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
      maxImagesPerArm: 4, requiredImagesPerArm: 2, priorityChecksRequired: true,
      priorityStatuses: ["present", "missing", "unclear"],
      compareNotesPlaceholder: "合成の比較案内",
      imageNotesPlaceholder: "合成の画像コメント案内",
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-resample-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 40000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abFlowState")||{}).textContent||"")
      + " / " + ((document.getElementById("abStatus")||{}).textContent||""));
  };
  const byId = (id) => document.getElementById(id);
  const problems = [];
  const note = (c, m) => { if (!c) problems.push(m); };
  const setVal = (id, v) => {
    const n = byId(id); n.value = String(v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const st = () => (byId("abStatus") || {}).textContent || "";
  const waitS = (re, label) => waitFor(() => re.test(st()), label);
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
    const n = byId("abFile" + arm); n.files = dt.files;
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitS(/画像を .* 枚置きました|登録できませんでした|上限/, "pick " + arm + " " + name);
  };
  const prioIds = (arm) => Array.prototype.map.call(
    byId("abRev" + arm + "_priority").querySelectorAll("[data-ab-priority-id]"),
    (r) => r.getAttribute("data-ab-priority-id"));
  const setPrio = (arm, id, v) => {
    const r = byId("abRev" + arm + "_priority").querySelector('[data-ab-priority-id="' + id + '"]');
    r.querySelector("select").value = v;
    r.querySelector("select").dispatchEvent(new Event("change", { bubbles: true }));
  };
  const evalImage = (arm, idx, verdict, aes, intent, notes) => {
    byId("abThumbs" + arm).querySelectorAll("img")[idx].click();
    setVal("abRev" + arm + "_verdict", verdict);
    setVal("abRev" + arm + "_aestheticSatisfaction", String(aes));
    setVal("abRev" + arm + "_intentMatch", String(intent));
    setVal("abRev" + arm + "_notes", notes);
    prioIds(arm).forEach((id) => setPrio(arm, id, "present"));
  };
  const liveRanks = (no, arm) => {
    const s = store();
    const dead = new Set(s.invalidations.map((v) => v.imageId));
    return s.images.filter((r) => r.caseKey === "p" + no && r.arm === arm && !dead.has(r.imageId))
      .map((r) => r.rank).sort((a, b) => a - b);
  };
  const grabExport = async (id) => {
    const orig = URL.createObjectURL;
    let cap = null;
    URL.createObjectURL = function (b) { cap = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId(id).click();
    await waitS(/書き出しました/, "export " + id);
    const text = await cap.text();
    URL.createObjectURL = orig;
    return text;
  };
`;

// ---------------------------------------------------------------------------
// 第1ラウンド: 各面2枚を評価して保存 -> レビューJSONLを書き出す(=提出)
// ---------------------------------------------------------------------------
function phaseRound1(pkg) {
  return (async (p) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(p, null, 2) + "\n"], "resample.json", { type: "application/json" }));
    const inp = byId("abFileInput"); inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    await pickImage("A", "r1-a1.png", 11);
    await pickImage("A", "r1-a2.png", 12);
    await pickImage("B", "r1-b1.png", 13);
    await pickImage("B", "r1-b2.png", 14);
    note(JSON.stringify(liveRanks(1, "A")) === "[1,2]", "初回の rank が 1,2 でない: " + liveRanks(1, "A"));

    evalImage("A", 0, "hold", 3, 2, "初回A1");
    evalImage("A", 1, "accept", 4, 4, "初回A2");
    evalImage("B", 0, "accept", 5, 5, "初回B1");
    evalImage("B", 1, "hold", 2, 3, "初回B2");
    await delay(250);
    byId("abThumbsA").querySelectorAll("img")[0].click();
    byId("abThumbsB").querySelectorAll("img")[0].click();
    setVal("abPreference", "B");
    setVal("abCompareNotes", "初回の比較");
    await waitFor(() => !byId("abSaveNext").disabled, "save enabled");
    byId("abSaveNext").click();
    await delay(700);

    // 提出（レビューJSONLの書き出し）
    const text = await grabExport("abExportReviews");
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    out_rows = rows;
    const c1 = rows.filter((r) => r.experiment.sourceNo === 1);
    out_initialImages = c1.reduce((a, r) => a.concat(r.images.map((im) => ({
      arm: r.experiment.arm, imageId: im.imageId, rank: im.rank, sha: im.metadata.sha256,
      verdict: im.evaluation.verdict, aes: im.evaluation.aestheticSatisfaction,
      intent: im.evaluation.intentMatch, notes: im.notes
    }))), []);
    note(out_initialImages.length === 4, "初回の書き出しが4枚でない: " + out_initialImages.length);
    note(store().exportedImageIds.length === 4, "書き出し済みとして記録されていない: " + store().exportedImageIds.length);
    return { pass: problems.length === 0, problems, initialImages: out_initialImages };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 第2ラウンド: 提出済み画像は外せない / 追加は rank 3,4 / 書き出しに初回分も残る
// ---------------------------------------------------------------------------
function phaseRound2(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    if (!/ケース 1 \/ 2/.test(byId("abCaseCounter").textContent)) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    }
    await delay(400);

    // 1. 提出済みの画像は外せない
    let confirmed = 0;
    window.confirm = () => { confirmed += 1; return true; };
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await delay(200);
    note(byId("abRemoveA").disabled === true, "提出済み画像の「外す」が押せる");
    note(/書き出し済み/.test(byId("abRemoveA").textContent),
      "提出済みだと分かる表示になっていない: " + byId("abRemoveA").textContent);
    byId("abStatus").textContent = "";
    byId("abRemoveA").disabled = false;
    byId("abRemoveA").click();
    await waitS(/提出した記録なので外せません/, "protected");
    note(confirmed === 0, "提出済み画像で確認ダイアログが出た");
    note(store().invalidations.length === 0, "提出済み画像が無効化された");
    note(liveRanks(1, "A").length === 2, "提出済み画像が消えた");

    // 2. 追加は rank 3,4（5,6 にならない）
    await pickImage("A", "r2-a3.png", 21);
    await pickImage("A", "r2-a4.png", 22);
    await pickImage("B", "r2-b3.png", 23);
    await pickImage("B", "r2-b4.png", 24);
    out_ranksA = liveRanks(1, "A"); out_ranksB = liveRanks(1, "B");
    note(JSON.stringify(out_ranksA) === "[1,2,3,4]", "A の rank が 1..4 でない: [" + out_ranksA + "]");
    note(JSON.stringify(out_ranksB) === "[1,2,3,4]", "B の rank が 1..4 でない: [" + out_ranksB + "]");

    // 3. 初回の評価がそのまま残っている
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await waitFor(() => byId("abRevA_notes").value === "初回A1", "初回A1の評価が残っていない");
    note(byId("abRevA_verdict").value === "hold" && byId("abRevA_aestheticSatisfaction").value === "3",
      "初回A1の判定・スコアが変わっている");

    // 4. 追加分を評価して保存
    evalImage("A", 2, "hold", 3, 3, "追加A3");
    evalImage("A", 3, "accept", 4, 3, "追加A4");
    evalImage("B", 2, "hold", 4, 4, "追加B3");
    evalImage("B", 3, "accept", 5, 4, "追加B4");
    await delay(250);
    byId("abThumbsA").querySelectorAll("img")[0].click();
    byId("abThumbsB").querySelectorAll("img")[0].click();
    setVal("abPreference", "tie");
    setVal("abCompareNotes", "追加後の比較");
    await waitFor(() => !byId("abSaveNext").disabled, "save enabled round2");
    byId("abSaveNext").click();
    await delay(700);

    // 5. 最終書き出しに初回分と追加分の両方が入る
    const text = await grabExport("abExportReviews");
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    const c1 = rows.filter((r) => r.experiment.sourceNo === 1);
    const all = c1.reduce((acc, r) => acc.concat(r.images.map((im) => ({
      arm: r.experiment.arm, imageId: im.imageId, rank: im.rank, sha: im.metadata.sha256,
      verdict: im.evaluation.verdict, aes: im.evaluation.aestheticSatisfaction,
      intent: im.evaluation.intentMatch, notes: im.notes
    }))), []);
    out_final = all;
    note(all.length === 8, "最終書き出しが8枚でない: " + all.length);
    for (const was of a.initialImages) {
      const now = all.find((x) => x.imageId === was.imageId);
      note(!!now, "初回画像が最終書き出しから消えている: " + was.notes);
      if (!now) continue;
      note(now.sha === was.sha, was.notes + ": 画像が差し替わっている");
      note(now.rank === was.rank, was.notes + ": rank が変わっている " + was.rank + " -> " + now.rank);
      note(now.verdict === was.verdict && now.aes === was.aes && now.intent === was.intent && now.notes === was.notes,
        was.notes + ": 評価が変わっている");
    }
    const ranksA = all.filter((x) => x.arm === "A").map((x) => x.rank).sort((x, y) => x - y);
    const ranksB = all.filter((x) => x.arm === "B").map((x) => x.rank).sort((x, y) => x - y);
    note(JSON.stringify(ranksA) === "[1,2,3,4]", "書き出しの A rank が 1..4 でない: [" + ranksA + "]");
    note(JSON.stringify(ranksB) === "[1,2,3,4]", "書き出しの B rank が 1..4 でない: [" + ranksB + "]");

    // コピーリストも 8 行(ケース1) + 0(ケース2は未登録)
    const tsv = await grabExport("abExportCopyList");
    const lines = tsv.trim().split("\n");
    note(lines.length === 1 + 8, "コピーリストが8行でない: " + (lines.length - 1));
    const targets = lines.slice(1).map((l) => l.split("\t")[5]);
    note(new Set(targets).size === targets.length,
      "コピーリストの targetPath が重複している: " + JSON.stringify(targets));
    out_copy = targets;
    return { pass: problems.length === 0, problems, ranksA: out_ranksA, ranksB: out_ranksB,
      finalCount: out_final.length, copy: out_copy.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 再読み込み後も維持されるか
// ---------------------------------------------------------------------------
function phaseReload(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    if (!/ケース 1 \/ 2/.test(byId("abCaseCounter").textContent)) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
    }
    await delay(500);
    note(JSON.stringify(liveRanks(1, "A")) === "[1,2,3,4]", "再読み込みで rank が変わった");
    note(store().exportedImageIds.length >= 4, "再読み込みで提出済みの記録が消えた");
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await delay(300);
    note(byId("abRemoveA").disabled === true, "再読み込み後に提出済み画像が外せる状態になっている");
    note(byId("abRevA_notes").value === "初回A1", "再読み込みで初回の評価が消えた");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 画面幅ごとの崩れ
// ---------------------------------------------------------------------------
function phaseLayout(spec) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await delay(500);
    const de = document.documentElement;
    const overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow <= 1, a.label + " で横溢れしている: " + overflow + "px");
    const wide = [];
    byId("abView").querySelectorAll("*").forEach((n) => {
      if (n.scrollWidth > de.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, a.label + " で画面幅より広い要素がある: " + wide.slice(0, 5).join(", "));
    note(byId("abThumbsA").querySelectorAll("img").length === 4, a.label + " で4枚のサムネイルが出ていない");
    const rm = byId("abRemoveA").getBoundingClientRect();
    note(rm.width > 0 && rm.height >= 44, a.label + " の「外す」ボタンが44px未満");
    const btn = byId("abRemoveA");
    note(btn.scrollWidth <= btn.clientWidth + 1, a.label + " で「外す」ボタンの文言が溢れている");
    return { pass: problems.length === 0, problems, label: a.label, vw: de.clientWidth, overflow };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const pkg = buildPackage();
  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3ff-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3ff-dl-"));
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

    const run = async (fn, label, arg, timeout = 240000) => {
      let source = fn.toString().replace("__PRELUDE__", PRELUDE);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      source = source.replace(/\bout_(\w+)\b/g, "globalThis.__out_$1");
      const evaluated = await client.send("Runtime.evaluate", {
        expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout,
      }, sessionId);
      if (evaluated.exceptionDetails) fail(`${label} threw`, evaluated.exceptionDetails);
      const value = evaluated.result && evaluated.result.value;
      if (!value || !value.pass) fail(`${label} failed`, value);
      return value;
    };

    const r1 = await run(phaseRound1, "round 1: evaluate and export", pkg);
    const r2 = await run(phaseRound2, "round 2: protected removal, ranks 3-4, full export",
      { initialImages: r1.initialImages });

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    await run(phaseReload, "reload keeps ranks, protection and evaluations");

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true },
    ];
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layout.push(await run(phaseLayout, spec.label + " layout", spec));
    }

    console.log("R3-FF RESAMPLE ROUND BROWSER ACCEPTANCE PASSED");
    console.log(`  round 1 exported 4 images and marked them submitted`);
    console.log(`  submitted images cannot be removed (button disabled, direct call refused, no invalidation)`);
    console.log(`  added images took ranks 3,4 — A [${r2.ranksA}] / B [${r2.ranksB}], never 5,6`);
    console.log(`  final export carried ${r2.finalCount} images: initial 4 unchanged (id/sha/rank/evaluation) + added 4`);
    console.log(`  copy list listed ${r2.copy} rows with unique target paths`);
    console.log(`  reload kept ranks, submitted-protection and the initial evaluations`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
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
