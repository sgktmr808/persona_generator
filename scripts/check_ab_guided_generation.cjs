#!/usr/bin/env node
// [R4D/R4E] 案内付き生成と評価順の**実ブラウザ**受入検査。
//  合成フィクスチャのみを使い、実験の実データ・本文・IDは一切含まない。
//
//  確かめること（R4E で加えた分を含む）:
//   宣言の無い従来パッケージは従来どおり(設定画面も通常の投入口もそのまま) ->
//   案内付きパッケージは**設定画面を出さず**、凍結された provider / model / Seed を
//     無操作で採用して作業台へ直行する ->
//   実行契約(キュー形式・件数・通し番号・ケース・面/順位・生成ID・本文ハッシュ・並び・
//     キューSHA・評価順・生成条件)を1項目ずつ壊すと**1つずつ読み込みを拒否**し、
//     既存のパッケージと記録は1バイトも変わらない ->
//   本文コピーは Clipboard 成功で本文ちょうど、Clipboard 不在・拒否のどちらでも
//     読み取り専用の本文欄が開いて全選択される ->
//   1枚だけ・登録先厳密・重複拒否・技術的失敗でキューは進まない ->
//   IndexedDB の保存失敗では**画像数もキュー位置も動かない** ->
//   localStorage の保存失敗では行・生成条件・実体をすべて巻き戻す ->
//   再読み込みで実体を失った枠は「登録済み」に数えない ->
//   重複キー・手順外の画像・条件不一致・通し番号不一致・SHA欠落・SHA重複では
//     N/N にならず評価も始められない ->
//   評価は evaluationOrder 順で進み、その間は画像の追加・削除・差し替えが全て閉じる ->
//   技術的不良だけは理由コード付きで**その枠だけ**開き、直したら同じ評価位置へ戻る ->
//   デスクトップとiPhone各幅で横溢れ0・44px操作領域・手動コピー欄が使える。
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
// definitionSha256 / integrity を組み直す。改変フィクスチャは**契約の検証**で落ちてほしいので、
// ハッシュ側では落ちないように必ず封をし直す。
function reseal(pkg) {
  const body = JSON.parse(JSON.stringify(pkg));
  delete body.definitionSha256;
  delete body.integrity;
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}
function clone(pkg) { return JSON.parse(JSON.stringify(pkg)); }

// ---------------------------------------------------------------------------
// 合成フィクスチャ。実験の実データ・本文・ID・語彙は一切持ち込まない。
// スロット役割と生成順を**混在**させ、A先行/B先行の両方を含める。
// ---------------------------------------------------------------------------
const CASES = [
  { n: 1, slotRoles: { A: "control",   B: "treatment" }, generationOrder: ["control", "treatment"], evaluationOrder: 3 },
  { n: 2, slotRoles: { A: "treatment", B: "control"   }, generationOrder: ["control", "treatment"], evaluationOrder: 1 },
  { n: 3, slotRoles: { A: "control",   B: "treatment" }, generationOrder: ["treatment", "control"], evaluationOrder: 4 },
  { n: 4, slotRoles: { A: "treatment", B: "control"   }, generationOrder: ["treatment", "control"], evaluationOrder: 2 }
];
const QUEUE_KEYS = ["sequence", "caseId", "sourceNo", "slot", "rank", "armGenerationId", "promptSha256"];
function normalizedQueueText(items) {
  return JSON.stringify(items.map((i) => {
    const out = {};
    QUEUE_KEYS.forEach((k) => { out[k] = i[k]; });
    return out;
  }));
}
function promptFor(n, slot) {
  // 長い日本語本文。折返し・手動コピー欄の検査も兼ねる。
  return `合成プロンプト ${n} 行目A\n合成の指示 ${slot} 面。`
    + `これは受入検査のための合成本文であり、実験の語彙は含まない。長い一文の折返しと`
    + `読み取り専用欄での表示を確かめるために、句読点を挟みながら十分な長さにしてある。`;
}
function buildQueue(cases) {
  const items = []; let seq = 0;
  cases.forEach((c) => {
    const slotForRole = {}; slotForRole[c.slotRoles.A] = "A"; slotForRole[c.slotRoles.B] = "B";
    c.generationOrder.map((r) => slotForRole[r]).forEach((slot) => {
      [1, 2].forEach((rank) => {
        seq += 1;
        items.push({ sequence: seq, caseId: "FX-" + String(c.n).padStart(2, "0"), sourceNo: c.n,
          slot, rank, armGenerationId: "fx-p" + c.n + "-" + slot, promptSha256: sha(promptFor(c.n, slot)) });
      });
    });
  });
  return items;
}

function buildGuidedPackage() {
  const cases = CASES.map((c) => {
    const a = promptFor(c.n, "A"), b = promptFor(c.n, "B");
    const settings = { schema: "t9_gen_settings.v1", salt: "fx-" + c.n, controls: { density: c.n } };
    return {
      sourceNo: c.n, caseId: "FX-" + String(c.n).padStart(2, "0"),
      baselineGenerationId: "gen-fx-p" + String(c.n).padStart(3, "0"),
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: "fx-batch", no: c.n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      slotRoles: c.slotRoles, generationOrder: c.generationOrder, evaluationOrder: c.evaluationOrder,
      imagesPerArm: 2,
      focusRubric: { targetLabel: "合成の合焦対象イ", separationRequired: true },
      arms: {
        A: { generationId: "fx-p" + c.n + "-A", role: c.slotRoles.A, prompt: a, promptSha256: sha(a),
             treatmentApplied: c.slotRoles.A === "treatment", diffSummary: "合成" },
        B: { generationId: "fx-p" + c.n + "-B", role: c.slotRoles.B, prompt: b, promptSha256: sha(b),
             treatmentApplied: c.slotRoles.B === "treatment", diffSummary: "合成" }
      }
    };
  });
  const items = buildQueue(CASES);
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-14T00:00:00.000Z", generatedBy: "fixture-guided",
    experiment: {
      experimentId: "fixture-guided", hypothesis: "合成",
      generationConditions: { provider: "openai", model: "合成モデルUI", seedSupport: "unsupported", imageSeed: null },
      generationExecution: {
        schemaVersion: "fixture.generation-execution.v1",
        derivedFrom: "cases[].generationOrder + cases[].slotRoles",
        itemCount: items.length,
        normalizedQueueSha256: sha(normalizedQueueText(items)),
        exposesRoleSemantics: false,
        items
      },
      automaticProductionUpdate: false, seedSupported: false
    },
    policy: {
      arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
      maxImagesPerArm: 2, requiredImagesPerArm: 2,
      focusRubricRequired: true, focusRubricSchema: "focusAssessment.v1",
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-guided-ab.v1" },
    cases
  };
  return reseal(body);
}

// generationExecution を持たない従来型（互換確認用）
function buildLegacyPackage() {
  const cases = [1, 2].map((n) => {
    const a = `合成プロンプト ${n} 行目A\n合成の指示 A 面。`;
    const b = `合成プロンプト ${n} 行目A\n合成の指示 B 面。`;
    const settings = { schema: "t9_gen_settings.v1", salt: "lg-" + n, controls: { density: n } };
    return {
      sourceNo: n, caseId: "LG-" + String(n).padStart(2, "0"),
      baselineGenerationId: "gen-lg-p" + String(n).padStart(3, "0"),
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: "lg-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: "lg-p" + n + "-A", role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false, diffSummary: "合成" },
        B: { generationId: "lg-p" + n + "-B", role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, diffSummary: "合成" }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-14T00:00:00.000Z", generatedBy: "fixture-legacy-guided",
    experiment: { experimentId: "fixture-legacy-guided", hypothesis: "合成", automaticProductionUpdate: false, seedSupported: false },
    policy: {
      arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
      maxImagesPerArm: 2, requiredImagesPerArm: 2,
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-legacy-guided-ab.v1" },
    cases
  };
  return reseal(body);
}

// ---------------------------------------------------------------------------
// 否定フィクスチャ。**1回に1箇所だけ**壊し、必ず封をし直す。
// ---------------------------------------------------------------------------
function buildRejectFixtures(base) {
  const out = [];
  const add = (label, expectField, mutate) => {
    const p = clone(base);
    mutate(p);
    out.push({ label, expectField, pkg: reseal(p), name: "reject-" + out.length + ".json" });
  };
  add("キュー形式が未知", "generationExecution.schemaVersion",
    (p) => { p.experiment.generationExecution.schemaVersion = "unknown-queue-format.v9"; });
  add("itemCount が実件数と違う", "generationExecution.itemCount",
    (p) => { p.experiment.generationExecution.itemCount = 15; });
  add("通し番号が重複", "items[5].sequence",
    (p) => { p.experiment.generationExecution.items[5].sequence = 5; });
  add("ケースIDが sourceNo と食い違う", "items[2].caseId",
    (p) => { p.experiment.generationExecution.items[2].caseId = "FX-03"; });
  add("順位が範囲外", "items[3].rank",
    (p) => { p.experiment.generationExecution.items[3].rank = 3; });
  add("面が A/B でない", "items[1].slot",
    (p) => { p.experiment.generationExecution.items[1].slot = "C"; });
  add("生成IDがパッケージと違う", "items[6].armGenerationId",
    (p) => { p.experiment.generationExecution.items[6].armGenerationId = "fx-p9-A"; });
  add("本文ハッシュがパッケージと違う", "items[7].promptSha256",
    (p) => { p.experiment.generationExecution.items[7].promptSha256 = sha("別の本文"); });
  add("並びが凍結生成順と違う", "items[0]", (p) => {
    // FX-01 の2面を入れ替える。通し番号・キー一意・ハッシュはすべて整合させ、
    // 「凍結 generationOrder + slotRoles からの再導出」だけが食い違う状態にする。
    const g = p.experiment.generationExecution;
    const head = g.items.slice(0, 4);
    const swapped = [head[2], head[3], head[0], head[1]].map((it, i) => {
      const copy = JSON.parse(JSON.stringify(it));
      copy.sequence = i + 1;
      return copy;
    });
    g.items = swapped.concat(g.items.slice(4));
    g.normalizedQueueSha256 = sha(normalizedQueueText(g.items));
  });
  add("キューSHAが一致しない", "generationExecution.normalizedQueueSha256",
    (p) => { p.experiment.generationExecution.normalizedQueueSha256 = sha("別のキュー"); });
  add("評価順が重複", "cases[1].evaluationOrder",
    (p) => { p.cases[1].evaluationOrder = p.cases[0].evaluationOrder; });
  add("評価順が範囲外", "cases[2].evaluationOrder",
    (p) => { p.cases[2].evaluationOrder = 9; });
  add("固定の生成条件に model が無い", "generationConditions.model",
    (p) => { p.experiment.generationConditions.model = ""; });
  add("Seed対応なのに Seed 値が無い", "generationConditions.imageSeed",
    (p) => { p.experiment.generationConditions.seedSupport = "supported"; });
  return out;
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abGuidedMsg")||{}).textContent||"")
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
    ctx.fillRect(seed % 20, seed % 10, 3, 3);
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
  const STORE_KEY = "personaGenerator.abExperiment.v1";
  const store = () => JSON.parse(localStorage.getItem(STORE_KEY));
  const rawStore = () => localStorage.getItem(STORE_KEY);
  const loadPkg = (pkg, name) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(pkg, null, 2) + "\\n"], name, { type: "application/json" }));
    const input = byId("abFileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const loadAndExpectRejected = async (pkg, name, label) => {
    byId("abPackageStatus").textContent = "";
    loadPkg(pkg, name);
    await waitFor(() => /使えません|読み込みました|読み直しました|中止しました|記録はそのまま/.test(byId("abPackageStatus").textContent),
      "verdict for " + label);
    return byId("abPackageStatus").textContent;
  };
  // IndexedDB の実体を直接見る/消す(記録だけ残って実体を失った状態を作るため)
  const IMG_DB = "personaGeneratorAbImages", IMG_STORE = "abImagesV1";
  const withStore = (mode, fn) => new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(IMG_DB, 1); } catch (_) { resolve(null); return; }
    req.onerror = () => resolve(null);
    req.onsuccess = (e) => {
      const d = e.target.result;
      let tx;
      try { tx = d.transaction([IMG_STORE], mode); } catch (_) { d.close(); resolve(null); return; }
      const r = fn(tx.objectStore(IMG_STORE));
      tx.oncomplete = () => { d.close(); resolve(r && r.result !== undefined ? r.result : true); };
      tx.onerror = () => { d.close(); resolve(null); };
    };
  });
  const blobCount = () => withStore("readonly", (s) => s.count());
  const deleteBlob = (imageId) => withStore("readwrite", (s) => s.delete(imageId));
`;
const GUIDED_HELPERS = `
  const gTarget = () => (byId("abGuidedTarget")||{}).textContent || "";
  const gProgress = () => (byId("abGuidedProgress")||{}).textContent || "";
  const gPhase = () => (byId("abGuidedPhase")||{}).textContent || "";
  const gCond = () => (byId("abGuidedCond")||{}).textContent || "";
  const gMsg = () => (byId("abGuidedMsg")||{}).textContent || "";
  const gCardVisible = () => { const n = byId("abGuided"); return !!n && n.hidden === false; };
  const gDropVisible = () => { const n = byId("abGuidedDrop"); return !!n && n.hidden === false; };
  const setupVisible = () => { const n = byId("abSetup"); return !!n && n.hidden === false; };
  const armDropHidden = (arm) => { const n = byId("abDrop"+arm); return !n || n.hidden === true; };
  const armInputDisabled = (arm) => { const n = byId("abFile"+arm); return !n || n.disabled === true; };
  const removeHidden = (arm) => { const n = byId("abRemove"+arm); return !n || (n.hidden === true && n.disabled === true); };
  const startReviewVisible = () => { const n = byId("abGuidedDone"); return !!n && n.hidden === false; };
  const repairVisible = () => { const n = byId("abGuidedRepair"); return !!n && n.hidden === false; };
  const repairOpenVisible = () => { const n = byId("abGuidedRepairOpen"); return !!n && n.hidden === false; };
  const promptBox = () => byId("abGuidedPrompt");
  const promptWrapOpen = () => { const n = byId("abGuidedPromptWrap"); return !!n && n.open === true; };
  const copyHintVisible = () => { const n = byId("abGuidedCopyHint"); return !!n && n.hidden === false; };
  const imagesOf = () => (store().images || []);
  const activeImages = () => {
    const d = store();
    const dead = {};
    (d.invalidations||[]).forEach((v) => { dead[v.imageId] = true; });
    return (d.images||[]).filter((r) => !dead[r.imageId]);
  };
  const guidedPut = async (name, seed, expectChange) => {
    const before = imagesOf().length;
    byId("abGuidedMsg").textContent = "";
    const n = byId("abGuidedFile");
    n.files = await files(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => imagesOf().length !== before || gMsg() !== "", "guided put " + name);
    await delay(80);
  };
  const guidedPutMany = async (names, seed) => {
    const n = byId("abGuidedFile");
    const dt = new DataTransfer();
    for (let i = 0; i < names.length; i++) {
      const blob = await makePng(seed + i);
      dt.items.add(new File([blob], names[i], { type: "image/png" }));
    }
    byId("abGuidedMsg").textContent = "";
    n.files = dt.files;
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => gMsg() !== "", "guided put many");
    await delay(80);
  };
  const repairPut = async (name, seed) => {
    const n = byId("abGuidedRepairFile");
    byId("abGuidedMsg").textContent = "";
    n.files = await files(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => gMsg() !== "", "repair put " + name);
    await delay(120);
  };
  // 目標表示から case / slot / rank を読む(内部IDは画面に出さない)
  const parseTarget = () => {
    const m = gTarget().match(/ケース\\s*([A-Z]+-\\d+)・([AB])・(\\d+)枚目/);
    return m ? { caseId: m[1], slot: m[2], rank: Number(m[3]) } : null;
  };
  const seqOf = () => { const m = gTarget().match(/画像生成\\s*(\\d+)\\s*\\//); return m ? Number(m[1]) : null; };
  const expectedPrompt = (n, slot) =>
    "合成プロンプト " + n + " 行目A\\n合成の指示 " + slot + " 面。"
    + "これは受入検査のための合成本文であり、実験の語彙は含まない。長い一文の折返しと"
    + "読み取り専用欄での表示を確かめるために、句読点を挟みながら十分な長さにしてある。";
`;

// ---------------------------------------------------------------------------
// 1: 従来型パッケージは案内カードが出ず、従来どおり動く（設定画面もそのまま）
// ---------------------------------------------------------------------------
function phaseLegacy(pkg) {
  return (async (p) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    loadPkg(p, "legacy.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "legacy loaded");
    // 宣言の無いパッケージは従来どおり「どこで作りますか」を出す。
    await waitFor(() => setupVisible(), "legacy setup screen");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    note(!gCardVisible(), "宣言の無いパッケージで案内カードが出ている");
    note(!armDropHidden("A") && !armDropHidden("B"), "宣言が無いのに通常の投入口が塞がれている");
    note(!armInputDisabled("A"), "宣言が無いのに A の入力が無効化されている");
    note(byId("abEditCondition").hidden === false, "宣言が無いのに生成条件の変更が消えている");
    // 従来どおり2枚ずつ置いて保存できる
    await pickImage("A", "lg-a1.png", 11); await pickImage("A", "lg-a2.png", 12);
    await pickImage("B", "lg-b1.png", 13); await pickImage("B", "lg-b2.png", 14);
    note(byId("abReviewA").hidden === false, "宣言が無いのに評価欄が隠れている");
    note(byId("abRemoveA").hidden === false, "宣言が無いのに画像を外す導線が消えている");
    const saved = store();
    note(saved.phase === null || saved.phase === undefined,
      "宣言が無いのに phase が入っている: " + saved.phase);
    note(saved.defaultCondition && saved.defaultCondition.model === "ChatGPT Images UI",
      "従来の生成条件が保存されていない");
    return { pass: problems.length === 0, problems, images: imagesOf().length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 2: 案内付きパッケージは無操作で固定条件を採用して作業台へ直行する
// ---------------------------------------------------------------------------
function phaseAutoAdopt(pkg) {
  return (async (p) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(p, "guided.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "guided loaded");
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench without setup");
    // 「ChatGPTで作る」も provider / model / Seed も一切触っていない。
    note(!setupVisible(), "案内付きパッケージで設定画面が出ている");
    const c = store().defaultCondition;
    note(!!c, "固定の生成条件が自動採用されていない");
    note(c && c.provider === "openai", "provider が固定値でない: " + (c && c.provider));
    note(c && c.model === "合成モデルUI", "model が固定値でない: " + (c && c.model));
    note(c && c.seedSupport === "unsupported", "seedSupport が固定値でない: " + (c && c.seedSupport));
    note(c && c.imageSeed === null, "imageSeed が固定値でない: " + JSON.stringify(c && c.imageSeed));
    note(gCardVisible(), "案内カードが出ていない");
    note(/生成中/.test(gPhase()), "フェーズ表示が生成中でない: " + gPhase());
    note(/合成モデルUI/.test(gCond()) && /固定/.test(gCond()), "固定の生成条件が読めない: " + gCond());
    note(byId("abEditCondition").hidden === true && byId("abEditCondition").disabled === true,
      "案内付きなのに生成条件を変更できる");
    note(armDropHidden("A") && armDropHidden("B"), "生成中に通常の投入口が塞がれていない");
    note(armInputDisabled("A") && armInputDisabled("B"), "生成中に通常の入力が無効化されていない");
    note(removeHidden("A") && removeHidden("B"), "生成中に画像を外す導線が開いている");
    note(byId("abReviewA").hidden === true, "生成中に評価欄が出ている");
    note(byId("abVerdictCard").hidden === true, "生成中に比較カードが出ている");
    note(byId("abSaveNext").disabled === true, "生成中に保存が押せる");
    note(imagesOf().length === 0, "読み込み直後に画像がある");
    // 役割語が画面に出ていない
    const cardText = byId("abGuided").textContent;
    note(!/control|treatment|対照|処理群/.test(cardText), "案内カードに役割が出ている: " + cardText.slice(0,120));
    // 最初の1手順だけを提示する
    const first = parseTarget();
    note(first && first.caseId === "FX-01" && first.slot === "A" && first.rank === 1,
      "最初の目標が違う: " + JSON.stringify(first));
    note(seqOf() === 1, "通し番号が1でない: " + seqOf());
    note(/0 \/ 16 枚 登録済み/.test(gProgress()), "進捗表示が違う: " + gProgress());
    // 1手順目を登録して、記録が残った状態にする(以降の拒否検査で「記録が無事」を見るため)
    await guidedPut("g1.png", 100);
    note(imagesOf().length === 1, "1手順目が登録されていない: " + imagesOf().length);
    const row = imagesOf()[0];
    note(row.sourceNo === 1 && row.arm === "A" && row.rank === 1 && row.guidedSequence === 1,
      "1手順目の登録先が違う: " + JSON.stringify(row));
    const cond = (store().conditions || [])[0];
    note(cond && cond.model === "合成モデルUI" && cond.provider === "openai"
      && cond.seedSupport === "unsupported" && cond.imageSeed === null,
      "ケースの生成条件行が固定値から作られていない: " + JSON.stringify(cond));
    return { pass: problems.length === 0, problems, condition: c };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 3: 実行契約の改変は1つずつ拒否され、既存のパッケージと記録は変わらない
// ---------------------------------------------------------------------------
function phaseRejectContracts(fixtures) {
  return (async (list) => {
    __PRELUDE__
    window.confirm = () => { problems.push("拒否されるはずのパッケージで確認ダイアログが出た"); return false; };
    const before = rawStore();
    const beforeExp = store().pkg.experiment.experimentId;
    const results = [];
    for (const f of list) {
      const verdict = await loadAndExpectRejected(f.pkg, f.name, f.label);
      note(/使えません/.test(verdict), f.label + " が拒否されていない: " + verdict);
      note(verdict.indexOf(f.expectField) >= 0,
        f.label + " の指摘箇所が " + f.expectField + " でない: " + verdict);
      note(rawStore() === before, f.label + " の拒否で保存内容が変わった");
      note(store().pkg.experiment.experimentId === beforeExp, f.label + " の拒否でパッケージが差し替わった");
      results.push(f.label);
    }
    note(byId("abWorkbench").hidden === false, "拒否のあとで作業台が閉じた");
    note(imagesOf().length === 1, "拒否のあとで画像が変わった: " + imagesOf().length);
    return { pass: problems.length === 0, problems, rejected: results.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 4: 本文コピー — Clipboard 成功 / 不在 / 拒否
// ---------------------------------------------------------------------------
function phaseCopyFallback() {
  return (async () => {
    __PRELUDE__
    const target = parseTarget();
    note(target && target.caseId === "FX-01" && target.slot === "A" && target.rank === 2,
      "コピー検査の起点が違う: " + JSON.stringify(target));
    const want = expectedPrompt(1, "A");
    const box = promptBox();
    note(!!box, "手動コピー用の本文欄が無い");
    note(box.readOnly === true, "本文欄が編集可能になっている");
    note(box.value === want, "本文欄の中身が今の手順の本文と違う");

    const realClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      || Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const realExec = document.execCommand;

    // (1) Clipboard API 成功 —— 本文ちょうどが渡る
    let copied = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: (t) => { copied = t; return Promise.resolve(); } }
    });
    byId("abGuidedCopy").click();
    await waitFor(() => copied !== null, "clipboard success");
    await delay(120);
    note(copied === want, "Clipboard へ渡した本文が今の手順と違う");
    note(/コピーしました/.test(gMsg()), "成功時の案内が出ない: " + gMsg());
    note(!copyHintVisible(), "成功なのに手動コピーの案内が出ている");

    // (2) Clipboard API が無い —— 従来コピーも失敗させ、本文欄が開いて全選択される
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
    byId("abGuidedCopy").click();
    await waitFor(() => copyHintVisible(), "clipboard-absent fallback");
    note(promptWrapOpen(), "Clipboard 不在で本文欄が開かない");
    note(promptBox().value === want, "Clipboard 不在の本文欄が今の手順と違う");
    note(promptBox().selectionStart === 0 && promptBox().selectionEnd === want.length,
      "Clipboard 不在で全選択されていない: " + promptBox().selectionStart + "-" + promptBox().selectionEnd);
    note(document.activeElement === promptBox(), "Clipboard 不在で本文欄に移動していない");
    note(/コピー/.test((byId("abGuidedCopyHint")||{}).textContent||""), "手動コピーの手順が案内されていない");
    note(promptBox().readOnly === true, "手動コピー時に本文欄が編集可能になっている");

    // (3) Clipboard API が拒否 —— 同じ退避経路
    byId("abGuidedCopyHint").hidden = true;
    byId("abGuidedPromptWrap").open = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) }
    });
    byId("abGuidedCopy").click();
    await waitFor(() => copyHintVisible(), "clipboard-rejected fallback");
    note(promptWrapOpen(), "Clipboard 拒否で本文欄が開かない");
    note(promptBox().selectionEnd === want.length, "Clipboard 拒否で全選択されていない");
    note(promptBox().value === want, "Clipboard 拒否の本文欄が今の手順と違う");

    // 復旧
    document.execCommand = realExec;
    if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
    else delete navigator.clipboard;
    note(imagesOf().length === 1, "コピー検査で画像が増減した: " + imagesOf().length);
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
// 5: 保存失敗 — IndexedDB / localStorage
// ---------------------------------------------------------------------------
function phaseStorageFailures() {
  return (async () => {
    __PRELUDE__
    const beforeTarget = JSON.stringify(parseTarget());
    const beforeImages = imagesOf().length;
    const beforeConds = (store().conditions || []).length;
    const beforeBlobs = await blobCount();

    // (1) IndexedDB へ実体を書けない —— 記録も増やさず、キューも進めない
    const realIdb = Object.getOwnPropertyDescriptor(window, "indexedDB");
    Object.defineProperty(window, "indexedDB", {
      configurable: true, value: { open: () => { throw new Error("blocked"); } }
    });
    await guidedPut("idb-fail.png", 210);
    Object.defineProperty(window, "indexedDB", realIdb);
    note(/端末へ保存できなかった/.test(gMsg()), "IndexedDB 失敗の案内が出ていない: " + gMsg());
    note(imagesOf().length === beforeImages, "IndexedDB 失敗で画像記録が増えた: " + imagesOf().length);
    note(JSON.stringify(parseTarget()) === beforeTarget, "IndexedDB 失敗でキューが進んだ: " + gTarget());
    note((await blobCount()) === beforeBlobs, "IndexedDB 失敗で実体が増えた");
    note(byId("abGuidedThumbWrap").hidden === true || !gMsg().match(/登録しました/),
      "IndexedDB 失敗なのに成功表示が出ている");

    // (2) localStorage へ書けない —— 行・生成条件・実体をすべて巻き戻す
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error("QuotaExceededError"); };
    await guidedPut("ls-fail.png", 220);
    Storage.prototype.setItem = realSet;
    note(/保存領域へ記録できなかった/.test(gMsg()), "localStorage 失敗の案内が出ていない: " + gMsg());
    note(JSON.stringify(parseTarget()) === beforeTarget, "localStorage 失敗でキューが進んだ: " + gTarget());
    note((await blobCount()) === beforeBlobs, "localStorage 失敗で書いた実体が残っている");
    // 保存を戻したうえで書き込ませ、**メモリ側も**巻き戻っていることを確かめる
    byId("abGuidedRetry").click();
    await waitFor(() => (store().guidedRetries || []).length >= 1, "retry persisted");
    note(imagesOf().length === beforeImages, "localStorage 失敗の行がメモリに残っていた: " + imagesOf().length);
    note((store().conditions || []).length === beforeConds,
      "localStorage 失敗の生成条件がメモリに残っていた: " + (store().conditions || []).length);
    note(JSON.stringify(parseTarget()) === beforeTarget, "巻き戻し後にキュー位置が動いた: " + gTarget());
    return { pass: problems.length === 0, problems, retries: (store().guidedRetries || []).length };
  })();
}

// ---------------------------------------------------------------------------
// 6: 残りの手順を順番どおりに登録。重複・複数選択・技術的失敗・N-1/N の閾も見る
// ---------------------------------------------------------------------------
function phaseRegisterRest() {
  return (async () => {
    __PRELUDE__
    const expected = [
      ["FX-01","A",1],["FX-01","A",2],["FX-01","B",1],["FX-01","B",2],
      ["FX-02","B",1],["FX-02","B",2],["FX-02","A",1],["FX-02","A",2],
      ["FX-03","B",1],["FX-03","B",2],["FX-03","A",1],["FX-03","A",2],
      ["FX-04","A",1],["FX-04","A",2],["FX-04","B",1],["FX-04","B",2]
    ];
    // 複数選択は拒否される
    await guidedPutMany(["m1.png","m2.png"], 900);
    note(/1枚だけ/.test(gMsg()), "複数選択が拒否されていない: " + gMsg());
    note(imagesOf().length === 1, "複数選択で画像が登録された: " + imagesOf().length);

    for (let i = 1; i < expected.length; i++) {
      const t = parseTarget();
      note(t && t.caseId === expected[i][0] && t.slot === expected[i][1] && t.rank === expected[i][2],
        "ステップ" + (i+1) + " の目標が違う: " + JSON.stringify(t) + " 期待 " + JSON.stringify(expected[i]));
      // 本文欄は手順と同時に入れ替わる
      note(promptBox().value === expectedPrompt(Number(expected[i][0].slice(3)), expected[i][1]),
        "ステップ" + (i+1) + " の本文欄が手順と一致しない");
      await guidedPut("g" + (i+1) + ".png", 100 + i);
      const imgs = imagesOf();
      note(imgs.length === i + 1, "ステップ" + (i+1) + " で画像数が " + imgs.length);
      const last = imgs[imgs.length - 1];
      note(last.sourceNo === Number(expected[i][0].slice(3)) && last.arm === expected[i][1]
        && last.rank === expected[i][2] && last.guidedSequence === i + 1,
        "ステップ" + (i+1) + " の登録先が違う: " + JSON.stringify({no:last.sourceNo,arm:last.arm,rank:last.rank,seq:last.guidedSequence}));
      if (i === 3) {
        // 重複SHA-256は別エントリでも拒否される
        const n = byId("abGuidedFile");
        const blob = await makePng(100);            // ステップ1と同じ内容
        const dt = new DataTransfer(); dt.items.add(new File([blob], "dup.png", { type: "image/png" }));
        byId("abGuidedMsg").textContent = "";
        n.files = dt.files; n.dispatchEvent(new Event("change", { bubbles: true }));
        await waitFor(() => gMsg() !== "", "duplicate verdict");
        note(/同じ画像が既に/.test(gMsg()), "重複画像が拒否されていない: " + gMsg());
        note(imagesOf().length === 4, "重複で画像が増えた: " + imagesOf().length);
      }
      if (i === 5) {
        // 技術的失敗を記録してもキューは進まない
        const before = parseTarget();
        const beforeRetries = (store().guidedRetries||[]).length;
        byId("abGuidedRetry").click();
        await waitFor(() => (store().guidedRetries||[]).length === beforeRetries + 1, "retry recorded");
        note(JSON.stringify(before) === JSON.stringify(parseTarget()), "失敗記録でキューが進んだ");
        note(imagesOf().length === 6, "失敗記録で画像レコードが作られた: " + imagesOf().length);
      }
      if (i === expected.length - 2) {
        note(!startReviewVisible(), (i+1) + "/16 なのに評価開始が出ている");
      }
    }
    note(/16 \/ 16 枚 登録済み/.test(gProgress()), "完了進捗が違う: " + gProgress());
    note(/16 \/ 16 生成画像登録完了/.test(gTarget()), "完了表示が違う: " + gTarget());
    note(startReviewVisible(), "48/48相当なのに評価開始が出ない");
    note(!gDropVisible(), "完了後も投入口が出ている");
    note(byId("abGuidedPromptWrap").hidden === true, "完了後も本文欄が残っている");
    return { pass: problems.length === 0, problems, images: imagesOf().length,
      retries: (store().guidedRetries||[]).length };
  })();
}

// ---------------------------------------------------------------------------
// 7: 再読み込みで進捗と再開位置が復元される
// ---------------------------------------------------------------------------
function phaseReloadResume(expectRetries) {
  return (async (want) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after reload");
    note(!setupVisible(), "再読み込み後に設定画面が出ている");
    note(gCardVisible(), "再読み込み後に案内カードが出ていない");
    await waitFor(() => /16 \/ 16 枚 登録済み/.test(gProgress()), "progress restored");
    note(startReviewVisible(), "再読み込みで評価開始が消えた");
    note((store().guidedRetries||[]).length === want, "再読み込みで失敗記録が変わった: "
      + (store().guidedRetries||[]).length);
    note(store().defaultCondition && store().defaultCondition.model === "合成モデルUI",
      "再読み込みで固定の生成条件が失われた");
    return { pass: problems.length === 0, problems, raw: rawStore() };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 8: 完了判定の否定検査 —— 記録を1箇所だけ壊して再読み込みする
// ---------------------------------------------------------------------------
function phaseMutateStore(spec) {
  return (async (s) => {
    __PRELUDE__
    localStorage.setItem(STORE_KEY, s.good);
    const d = JSON.parse(s.good);
    const first = d.images[0];
    const copyRow = () => JSON.parse(JSON.stringify(first));
    if (s.kind === "dupKey") {
      const r = copyRow(); r.imageId = first.imageId + "-dup";
      r.metadata = Object.assign({}, first.metadata, { sha256: first.metadata.sha256.replace(/^./, "a") });
      d.images.push(r);
    } else if (s.kind === "extra") {
      const r = copyRow(); r.imageId = first.imageId + "-extra"; r.rank = 3; r.guidedSequence = 99;
      r.metadata = Object.assign({}, first.metadata, { sha256: first.metadata.sha256.replace(/^./, "b") });
      d.images.push(r);
    } else if (s.kind === "wrongCondition") {
      d.conditions[0].model = "別のモデル";
    } else if (s.kind === "wrongSequence") {
      d.images[0].guidedSequence = 99;
    } else if (s.kind === "missingSha") {
      delete d.images[0].metadata.sha256;
    } else if (s.kind === "dupSha") {
      d.images[1].metadata.sha256 = d.images[0].metadata.sha256;
    } else if (s.kind === "restore") {
      // そのまま書き戻すだけ
    } else {
      problems.push("unknown mutation: " + s.kind);
    }
    localStorage.setItem(STORE_KEY, JSON.stringify(d));
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}
function phaseCheckIncomplete(spec) {
  return (async (s) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await delay(500);
    if (s.expectComplete) {
      await waitFor(() => startReviewVisible(), "complete again");
      note(/16 \/ 16 枚 登録済み/.test(gProgress()), "復元後の進捗が違う: " + gProgress());
      return { pass: problems.length === 0, problems };
    }
    note(!startReviewVisible(), s.kind + ": 壊れているのに評価開始が出ている");
    note(!/16 \/ 16 生成画像登録完了/.test(gTarget()), s.kind + ": 壊れているのに完了表示が出ている");
    const seen = gProgress() + " / " + gTarget() + " / " + gCond() + " / " + gMsg();
    note(new RegExp(s.expect).test(seen), s.kind + ": 期待した指摘が出ていない(" + s.expect + "): " + seen);
    // 評価を始めようとしても弾かれる
    if (byId("abGuidedStartReview")) {
      byId("abGuidedMsg").textContent = "";
      byId("abGuidedStartReview").click();
      await delay(150);
      note(store().phase !== "evaluation", s.kind + ": 壊れているのに評価フェーズへ入った");
    }
    return { pass: problems.length === 0, problems, progress: gProgress() };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 9: 評価フェーズ —— evaluationOrder で進み、画像操作は全て閉じる
// ---------------------------------------------------------------------------
function phaseEvaluationOrder() {
  return (async () => {
    __PRELUDE__
    byId("abGuidedStartReview").click();
    await waitFor(() => /評価中/.test(gPhase()), "evaluation phase");
    await delay(300);
    note(byId("abReviewA").hidden === false, "評価中なのに評価欄が出ていない");
    // R4E: 評価中も通常の画像操作は開かない
    note(armDropHidden("A") && armDropHidden("B"), "評価中に通常の投入口が開いている");
    note(armInputDisabled("A") && armInputDisabled("B"), "評価中に通常の入力が有効になっている");
    note(removeHidden("A") && removeHidden("B"), "評価中に画像を外す導線が開いている");
    note(byId("abEditCondition").hidden === true, "評価中に生成条件を変更できる");
    note(!gDropVisible(), "評価中に案内の投入口が開いている");
    note(repairOpenVisible(), "評価中に技術的な再登録の導線が無い");

    // 通常の投入口へ直接ファイルを流し込んでも増えない
    const beforeImages = imagesOf().length;
    byId("abStatus").textContent = "";
    const n = byId("abFileA");
    n.files = await files("sneak.png", 777);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(400);
    note(imagesOf().length === beforeImages, "評価中に通常経路から画像が増えた: " + imagesOf().length);
    // 外す操作も通らない
    byId("abStatus").textContent = "";
    byId("abRemoveA").click();
    await delay(200);
    note(imagesOf().length === beforeImages && (store().invalidations||[]).length === 0,
      "評価中に画像を外せた");

    // evaluationOrder: FX-02(1) -> FX-04(2) -> FX-01(3) -> FX-03(4)
    const order = ["FX-02", "FX-04", "FX-01", "FX-03"];
    const caseNow = () => (byId("abCaseState")||{}).textContent + " " + (byId("abCaseCounter")||{}).textContent
      + " " + gTarget();
    note(/FX-02/.test(caseNow()), "評価順1番目が FX-02 でない: " + caseNow());
    note(/評価順 1 \/ 4/.test(gProgress()), "評価順の進捗表示が違う: " + gProgress());
    for (let i = 1; i < order.length; i++) {
      byId("abNext").click();
      await delay(320);
      note(new RegExp(order[i]).test(caseNow()), "評価順" + (i+1) + "番目が " + order[i] + " でない: " + caseNow());
      note(new RegExp("評価順 " + (i+1) + " / 4").test(gProgress()), "評価順表示が違う: " + gProgress());
    }
    // 逆方向もパッケージ順でなく評価順
    byId("abPrev").click(); await delay(320);
    note(/FX-01/.test(caseNow()), "戻りが評価順になっていない: " + caseNow());
    // 未完了へ も評価順
    byId("abJumpIncomplete").click(); await delay(320);
    note(/FX-03|FX-02|FX-04/.test(caseNow()), "未完了への移動が評価順で動いていない: " + caseNow());
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
// 10: 実体が消えた枠 —— 完了に数えず、技術的不良としてだけ同じ枠へ直せる
// ---------------------------------------------------------------------------
function phaseDropBlob() {
  return (async () => {
    __PRELUDE__
    const rows = activeImages();
    const target = rows.filter((r) => r.sourceNo === 1 && r.arm === "A" && r.rank === 1)[0];
    note(!!target, "実体を消す対象が見つからない");
    await deleteBlob(target.imageId);
    return { pass: problems.length === 0, problems, imageId: target.imageId };
  })();
}
function phaseRepair() {
  return (async () => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await waitFor(() => /評価中/.test(gPhase()), "still evaluation phase");
    await delay(500);
    // 評価位置は評価順の先頭のまま
    note(/評価順 1 \/ 4/.test(gProgress()), "再読み込み後の評価位置が違う: " + gProgress());
    // 実体を失った枠は完了に数えない
    note(/実体がこの端末に見つからない/.test(gMsg() + gCond()),
      "実体欠落が指摘されていない: " + gMsg() + " / " + gCond());
    note(/FX-01・A・1枚目/.test(gMsg() + gCond()), "欠けている枠が特定されていない: " + gMsg() + " / " + gCond());
    note(repairOpenVisible(), "技術的な再登録の導線が出ていない");
    const beforeImages = imagesOf().length;

    byId("abGuidedRepairOpen").click();
    await waitFor(() => repairVisible(), "repair panel");
    note(/FX-01・A・1枚目/.test((byId("abGuidedRepairTarget")||{}).textContent||""),
      "復旧対象が違う: " + (byId("abGuidedRepairTarget")||{}).textContent);
    note(byId("abGuidedRepairReason").value === "missing_blob",
      "既定の理由コードが違う: " + byId("abGuidedRepairReason").value);
    // 美的理由は選べない(選択肢は技術的なものだけ)
    const reasons = Array.prototype.map.call(byId("abGuidedRepairReason").options, (o) => o.value);
    note(reasons.length === 2 && reasons.indexOf("missing_blob") >= 0 && reasons.indexOf("corrupt_file") >= 0,
      "理由コードに技術以外が混じっている: " + reasons.join(","));
    // 理由を空にすると受け付けない
    byId("abGuidedRepairReason").value = "";
    await repairPut("repair-nope.png", 555);
    note(/理由を選んで/.test(gMsg()), "理由なしの再登録が拒否されていない: " + gMsg());
    note(imagesOf().length === beforeImages, "理由なしで画像が増えた: " + imagesOf().length);

    byId("abGuidedRepairReason").value = "missing_blob";
    setVal("abGuidedRepairNote", "受入検査での欠落再現");
    await repairPut("repair-ok.png", 556);
    await waitFor(() => imagesOf().length === beforeImages + 1, "repair registered");
    const repairs = store().guidedRepairs || [];
    note(repairs.length === 1, "復旧記録が1件でない: " + repairs.length);
    note(repairs[0] && repairs[0].reasonCode === "missing_blob" && repairs[0].sourceNo === 1
      && repairs[0].slot === "A" && repairs[0].rank === 1 && repairs[0].note === "受入検査での欠落再現",
      "復旧記録の中身が違う: " + JSON.stringify(repairs[0]));
    const dead = (store().invalidations||[]).filter((v) => v.imageId === repairs[0].replacedImageId);
    note(dead.length === 1, "壊れていた画像が無効化されていない");
    const fresh = activeImages().filter((r) => r.sourceNo === 1 && r.arm === "A" && r.rank === 1);
    note(fresh.length === 1 && fresh[0].imageId === repairs[0].newImageId,
      "同じ枠へ1枚だけ入っていない: " + fresh.length);
    note(fresh[0] && fresh[0].guidedSequence === 1, "復旧した行の通し番号が違う: " + (fresh[0]||{}).guidedSequence);
    // 直したら完了に戻り、評価位置も動かない
    await waitFor(() => !/実体がこの端末に見つからない/.test(gMsg() + gCond()), "repaired");
    note(/評価順 1 \/ 4/.test(gProgress()), "復旧後に評価位置が動いた: " + gProgress());
    note(/評価中/.test(gPhase()), "復旧で生成フェーズへ戻った: " + gPhase());
    note(!repairVisible(), "復旧後も再登録欄が開いたまま");
    note(armDropHidden("A") && armInputDisabled("A"), "復旧後に通常の投入口が開いた");
    return { pass: problems.length === 0, problems, images: imagesOf().length };
  })();
}

// ---------------------------------------------------------------------------
// 11: 画面幅ごとの表示
// ---------------------------------------------------------------------------
function phaseLayout(spec) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await delay(400);
    const label = a.label;
    const de = document.documentElement;
    const overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow <= 1, label + " で横溢れ: " + overflow + "px");
    const wide = [];
    byId("abView").querySelectorAll("*").forEach((n) => {
      if (n.scrollWidth > de.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, label + " で幅超過要素: " + wide.slice(0,4).join(", "));
    const card = byId("abGuided");
    note(card && card.hidden === false, label + " で案内カードが出ていない");
    // 主要操作は44px以上・文字は折り返す
    ["abGuidedCopy","abGuidedDrop","abGuidedRetry","abGuidedInspect"].forEach((id) => {
      const n = byId(id); if (!n || n.hidden) return;
      const r = n.getBoundingClientRect();
      note(r.height >= 44, label + " の " + id + " が44px未満: " + Math.round(r.height));
      note(r.width <= de.clientWidth + 1, label + " の " + id + " が画面幅を超えている");
    });
    const tgt = byId("abGuidedTarget");
    note(tgt.scrollWidth <= tgt.clientWidth + 1, label + " で目標表示が折り返されず溢れている");
    // [R4E] 手動コピー欄: 16px以上・編集不可・開いても横溢れ0
    const wrap = byId("abGuidedPromptWrap");
    note(wrap && wrap.hidden === false, label + " で手動コピー欄が出ていない");
    const sm = wrap.querySelector("summary").getBoundingClientRect();
    note(sm.height >= 44, label + " の手動コピー見出しが44px未満: " + Math.round(sm.height));
    wrap.open = true;
    await delay(200);
    const box = byId("abGuidedPrompt");
    const fs = parseFloat(getComputedStyle(box).fontSize);
    note(fs >= 16, label + " の本文欄が16px未満: " + fs);
    note(box.readOnly === true, label + " の本文欄が編集可能");
    note(box.scrollWidth <= box.clientWidth + 1, label + " の本文欄が横に溢れている");
    const overflow2 = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow2 <= 1, label + " で本文欄を開くと横溢れ: " + overflow2 + "px");
    const br = box.getBoundingClientRect();
    note(br.width <= de.clientWidth + 1, label + " の本文欄が画面幅を超えている");
    wrap.open = false;
    return { pass: problems.length === 0, problems, label, overflow, vw: de.clientWidth, fontSize: fs };
  })(__ARG__);
}

// レイアウト測定のために生成フェーズの先頭へ戻す
function phaseResetForLayout(pkg) {
  return (async (pk) => {
    __PRELUDE__
    window.confirm = () => true;
    byId("abTab").click();
    await delay(200);
    byId("abClear").click();
    await waitFor(() => {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return true;
      const d = JSON.parse(raw);
      return !d.images || d.images.length === 0;
    }, "records cleared");
    loadPkg(pk, "guided2.json");
    await waitFor(() => /読み込みました|読み直しました/.test(byId("abPackageStatus").textContent), "reload guided");
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench for layout");
    note(!setupVisible(), "記録削除のあとに設定画面が出ている");
    note(gCardVisible(), "レイアウト用の再読込で案内カードが出ていない");
    await guidedPut("layout-1.png", 700);
    note(/生成中/.test(gPhase()), "レイアウト測定時に生成フェーズでない: " + gPhase());
    note(imagesOf().length === 1, "レイアウト用の1枚が登録されていない");
    return { pass: problems.length === 0, problems, images: imagesOf().length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const legacyPkg = buildLegacyPackage();
  const guidedPkg = buildGuidedPackage();
  const rejectFixtures = buildRejectFixtures(guidedPkg);

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4e-guided-"));
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

    const FULL = PRELUDE + GUIDED_HELPERS;
    const run = async (fn, label, arg, timeout = 240000) => {
      process.stderr.write("  [phase] " + label + " ...\n");
      let source = fn.toString().replace("__PRELUDE__", FULL);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      const ev = await client.send("Runtime.evaluate",
        { expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout }, sessionId);
      process.stderr.write("  [phase] " + label + " done\n");
      if (ev.exceptionDetails) fail(`${label} threw`, ev.exceptionDetails);
      const v = ev.result && ev.result.value;
      if (!v || !v.pass) fail(`${label} failed`, v);
      return v;
    };
    const reload = async () => {
      await client.send("Page.reload", { ignoreCache: false }, sessionId);
      await wait(2200);
    };

    const legacy = await run(phaseLegacy, "legacy package unchanged", legacyPkg);
    const adopted = await run(phaseAutoAdopt, "guided package adopts frozen conditions with no setup", guidedPkg);
    const rejected = await run(phaseRejectContracts, "guided contract tampering refused one at a time",
      rejectFixtures.map((f) => ({ label: f.label, expectField: f.expectField, pkg: f.pkg, name: f.name })));
    await run(phaseCopyFallback, "clipboard success / absence / rejection");
    const storage = await run(phaseStorageFailures, "IndexedDB and localStorage failures do not advance");
    const registered = await run(phaseRegisterRest, "remaining queue entries registered in exact order");

    await reload();
    const resumed = await run(phaseReloadResume, "reload resumes progress", registered.retries);

    // 完了判定の否定検査。毎回、健全な保存内容へ戻してから1箇所だけ壊す。
    const NEGATIVES = [
      { kind: "dupKey", expect: "15 / 16" },
      { kind: "extra", expect: "手順外 1 件" },
      { kind: "wrongCondition", expect: "12 / 16" },
      { kind: "wrongSequence", expect: "15 / 16" },
      { kind: "missingSha", expect: "15 / 16" },
      { kind: "dupSha", expect: "14 / 16" }
    ];
    const negativeResults = [];
    for (const neg of NEGATIVES) {
      await run(phaseMutateStore, "mutate / " + neg.kind, { kind: neg.kind, good: resumed.raw });
      await reload();
      const r = await run(phaseCheckIncomplete, "completion refused / " + neg.kind,
        { kind: neg.kind, expect: neg.expect, expectComplete: false });
      negativeResults.push(neg.kind + " -> " + r.progress);
    }
    await run(phaseMutateStore, "restore healthy store", { kind: "restore", good: resumed.raw });
    await reload();
    await run(phaseCheckIncomplete, "healthy store complete again", { kind: "restore", expectComplete: true });

    await run(phaseEvaluationOrder, "evaluation order enforced and image set locked");
    await run(phaseDropBlob, "drop one stored blob");
    await reload();
    await run(phaseRepair, "missing blob refused and repaired through the technical path");

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    await run(phaseResetForLayout, "reset to generation phase for layout", guidedPkg);
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layout.push(await run(phaseLayout, "layout / " + spec.label, spec));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

    console.log("R4E GUIDED WORKFLOW BROWSER ACCEPTANCE PASSED");
    console.log(`  legacy package unchanged: setup screen kept, no guided card, ordinary drops open, phase null (${legacy.images} images placed the old way)`);
    console.log(`  guided package entered the workbench with zero setup interaction; frozen condition adopted automatically: ${adopted.condition.provider} / ${adopted.condition.model} / seed ${adopted.condition.seedSupport}`);
    console.log(`  guided contract tampering refused one mutation at a time (${rejected.rejected} negative fixtures); package and records unchanged after every rejection`);
    console.log(`  clipboard success copies the exact prompt; absence and rejection both reveal the selected read-only fallback field`);
    console.log(`  IndexedDB put failure and localStorage failure both left images, conditions, blobs and queue position unchanged (${storage.retries} retry recorded)`);
    console.log(`  queue derived from mixed slotRoles/generationOrder; 16/16 registered in exact order; duplicate SHA-256, multi-file and queue-bypass refused`);
    console.log(`  reload resumed progress, retries and the frozen condition`);
    console.log(`  completion refused for: ${negativeResults.join(" | ")}`);
    console.log(`  evaluation navigates FX-02 -> FX-04 -> FX-01 -> FX-03 (evaluationOrder) with every image add/remove control closed`);
    console.log(`  missing blob was not counted as complete and was repaired through the reason-coded technical path only`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px font ${l.fontSize}px`).join(" | ")}`);
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
