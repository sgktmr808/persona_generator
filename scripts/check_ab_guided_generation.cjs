#!/usr/bin/env node
// [R4D] 案内付き生成と評価順の**実ブラウザ**受入検査。
//  合成フィクスチャのみを使い、実験の実データ・本文・IDは一切含まない。
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
function promptFor(n, slot) {
  return `合成プロンプト ${n} 行目A\n合成の指示 ${slot} 面。`;
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
        schemaVersion: "op-e1.generation-execution.v1",
        derivedFrom: "cases[].generationOrder + cases[].slotRoles",
        itemCount: items.length,
        normalizedQueueSha256: sha(JSON.stringify(items)),
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
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
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
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}
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
  const store = () => JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
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
const GUIDED_HELPERS = `
  const gTarget = () => (byId("abGuidedTarget")||{}).textContent || "";
  const gProgress = () => (byId("abGuidedProgress")||{}).textContent || "";
  const gPhase = () => (byId("abGuidedPhase")||{}).textContent || "";
  const gMsg = () => (byId("abGuidedMsg")||{}).textContent || "";
  const gCardVisible = () => { const n = byId("abGuided"); return !!n && n.hidden === false; };
  const gDropVisible = () => { const n = byId("abGuidedDrop"); return !!n && n.hidden === false; };
  const armDropHidden = (arm) => { const n = byId("abDrop"+arm); return !n || n.hidden === true; };
  const armInputDisabled = (arm) => { const n = byId("abFile"+arm); return !n || n.disabled === true; };
  const startReviewVisible = () => { const n = byId("abGuidedDone"); return !!n && n.hidden === false; };
  const imagesOf = () => (store().images || []);
  const guidedPut = async (name, seed) => {
    const n = byId("abGuidedFile");
    n.files = await files(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(260);
  };
  const guidedPutMany = async (names, seed) => {
    const n = byId("abGuidedFile");
    const dt = new DataTransfer();
    for (let i = 0; i < names.length; i++) {
      const blob = await makePng(seed + i);
      dt.items.add(new File([blob], names[i], { type: "image/png" }));
    }
    n.files = dt.files;
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(260);
  };
  // 目標表示から case / slot / rank を読む(内部IDは画面に出さない)
  const parseTarget = () => {
    const m = gTarget().match(/ケース\\s*([A-Z]+-\\d+)・([AB])・(\\d+)枚目/);
    return m ? { caseId: m[1], slot: m[2], rank: Number(m[3]) } : null;
  };
  const seqOf = () => { const m = gTarget().match(/画像生成\\s*(\\d+)\\s*\\//); return m ? Number(m[1]) : null; };
`;

// ---------------------------------------------------------------------------
// 1: 従来型パッケージは案内カードが出ず、従来どおり動く
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
    note(!gCardVisible(), "宣言の無いパッケージで案内カードが出ている");
    note(!armDropHidden("A") && !armDropHidden("B"), "宣言が無いのに通常の投入口が塞がれている");
    note(!armInputDisabled("A"), "宣言が無いのに A の入力が無効化されている");
    // 従来どおり2枚ずつ置いて保存できる
    await pickImage("A", "lg-a1.png", 11); await pickImage("A", "lg-a2.png", 12);
    await pickImage("B", "lg-b1.png", 13); await pickImage("B", "lg-b2.png", 14);
    note(byId("abReviewA").hidden === false, "宣言が無いのに評価欄が隠れている");
    const saved = store();
    note(saved.phase === null || saved.phase === undefined,
      "宣言が無いのに phase が入っている: " + saved.phase);
    return { pass: problems.length === 0, problems, images: imagesOf().length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 2: 案内キューの導出・順番・登録先・重複・複数選択・迂回防止
// ---------------------------------------------------------------------------
function phaseGuidedQueue(pkg) {
  return (async (p) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(p, "guided.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "guided loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    note(gCardVisible(), "案内カードが出ていない");
    note(/生成中/.test(gPhase()), "フェーズ表示が生成中でない: " + gPhase());
    note(armDropHidden("A") && armDropHidden("B"), "生成中に通常の投入口が塞がれていない");
    note(armInputDisabled("A") && armInputDisabled("B"), "生成中に通常の入力が無効化されていない");
    note(byId("abReviewA").hidden === true, "生成中に評価欄が出ている");
    note(byId("abVerdictCard").hidden === true, "生成中に比較カードが出ている");
    note(byId("abSaveNext").disabled === true, "生成中に保存が押せる");
    note(/合成モデルUI/.test((byId("abGuidedCond")||{}).textContent||""), "固定の生成条件が出ていない");

    // 期待キュー: 混在マッピングから導出
    const expected = [
      ["FX-01","A",1],["FX-01","A",2],["FX-01","B",1],["FX-01","B",2],
      ["FX-02","B",1],["FX-02","B",2],["FX-02","A",1],["FX-02","A",2],
      ["FX-03","B",1],["FX-03","B",2],["FX-03","A",1],["FX-03","A",2],
      ["FX-04","A",1],["FX-04","A",2],["FX-04","B",1],["FX-04","B",2]
    ];
    const first = parseTarget();
    note(!!first, "目標表示を読めない: " + gTarget());
    note(first && first.caseId === "FX-01" && first.slot === "A" && first.rank === 1,
      "最初の目標が違う: " + JSON.stringify(first));
    note(seqOf() === 1, "通し番号が1でない: " + seqOf());
    note(/0 \/ 16 枚 登録済み/.test(gProgress()), "進捗表示が違う: " + gProgress());

    // 役割語が画面に出ていない
    const cardText = byId("abGuided").textContent;
    note(!/control|treatment|対照|処理群/.test(cardText), "案内カードに役割が出ている: " + cardText.slice(0,120));

    // 複数選択は拒否される
    await guidedPutMany(["m1.png","m2.png"], 900);
    note(/1枚だけ/.test(gMsg()), "複数選択が拒否されていない: " + gMsg());
    note(imagesOf().length === 0, "複数選択で画像が登録された");

    // 1枚ずつ、期待キュー順に登録され、登録先が厳密
    for (let i = 0; i < expected.length; i++) {
      const t = parseTarget();
      note(t && t.caseId === expected[i][0] && t.slot === expected[i][1] && t.rank === expected[i][2],
        "ステップ" + (i+1) + " の目標が違う: " + JSON.stringify(t) + " 期待 " + JSON.stringify(expected[i]));
      await guidedPut("g" + (i+1) + ".png", 100 + i);
      const imgs = imagesOf();
      note(imgs.length === i + 1, "ステップ" + (i+1) + " で画像数が " + imgs.length);
      const last = imgs[imgs.length - 1];
      note(last.sourceNo === Number(expected[i][0].slice(3)) && last.arm === expected[i][1] && last.rank === expected[i][2],
        "ステップ" + (i+1) + " の登録先が違う: " + JSON.stringify({no:last.sourceNo,arm:last.arm,rank:last.rank}));
      if (i === 3) {
        // 重複SHA-256は別エントリでも拒否される
        const n = byId("abGuidedFile");
        const blob = await makePng(100 + 0);            // ステップ1と同じ内容
        const dt = new DataTransfer(); dt.items.add(new File([blob], "dup.png", { type: "image/png" }));
        n.files = dt.files; n.dispatchEvent(new Event("change", { bubbles: true }));
        await delay(300);
        note(/同じ画像が既に/.test(gMsg()), "重複画像が拒否されていない: " + gMsg());
        note(imagesOf().length === 4, "重複で画像が増えた: " + imagesOf().length);
      }
      if (i === 5) {
        // 技術的失敗を記録してもキューは進まない
        const before = parseTarget();
        byId("abGuidedRetry").click();
        await delay(200);
        const after = parseTarget();
        note(JSON.stringify(before) === JSON.stringify(after), "失敗記録でキューが進んだ");
        note((store().guidedRetries||[]).length === 1, "失敗記録が保存されていない");
        note(imagesOf().length === 6, "失敗記録で画像レコードが作られた");
      }
      if (i === expected.length - 2) {
        note(!startReviewVisible(), (i+1) + "/16 なのに評価開始が出ている");
      }
    }

    note(/16 \/ 16 枚 登録済み/.test(gProgress()), "完了進捗が違う: " + gProgress());
    note(/16 \/ 16 生成画像登録完了/.test(gTarget()), "完了表示が違う: " + gTarget());
    note(startReviewVisible(), "48/48相当なのに評価開始が出ない");
    note(!gDropVisible(), "完了後も投入口が出ている");
    return { pass: problems.length === 0, problems, images: imagesOf().length,
      retries: (store().guidedRetries||[]).length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 3: 再読み込みで進捗と再開位置が復元される
// ---------------------------------------------------------------------------
function phaseReloadResume() {
  return (async () => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after reload");
    note(gCardVisible(), "再読み込み後に案内カードが出ていない");
    note(/16 \/ 16 枚 登録済み/.test(gProgress()), "再読み込みで進捗が失われた: " + gProgress());
    note(startReviewVisible(), "再読み込みで評価開始が消えた");
    note((store().guidedRetries||[]).length === 1, "再読み込みで失敗記録が消えた");
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
// 4: 評価フェーズは evaluationOrder で進む
// ---------------------------------------------------------------------------
function phaseEvaluationOrder() {
  return (async () => {
    __PRELUDE__
    byId("abGuidedStartReview").click();
    await delay(400);
    note(/評価中/.test(gPhase()), "評価フェーズになっていない: " + gPhase());
    note(byId("abReviewA").hidden === false, "評価中なのに評価欄が出ていない");
    note(!armDropHidden("A"), "評価中も通常の投入口が塞がれたまま");

    // evaluationOrder: FX-02(1) -> FX-04(2) -> FX-01(3) -> FX-03(4)
    const order = ["FX-02", "FX-04", "FX-01", "FX-03"];
    const caseNow = () => (byId("abCaseState")||{}).textContent + " " + (byId("abCaseCounter")||{}).textContent
      + " " + gTarget();
    note(/FX-02/.test(caseNow()), "評価順1番目が FX-02 でない: " + caseNow());
    note(/評価順 1 \/ 4/.test(gProgress()), "評価順の進捗表示が違う: " + gProgress());

    for (let i = 1; i < order.length; i++) {
      byId("abNext").click();
      await delay(300);
      note(new RegExp(order[i]).test(caseNow()), "評価順" + (i+1) + "番目が " + order[i] + " でない: " + caseNow());
      note(new RegExp("評価順 " + (i+1) + " / 4").test(gProgress()), "評価順表示が違う: " + gProgress());
    }
    // 逆方向もパッケージ順でなく評価順
    byId("abPrev").click(); await delay(300);
    note(/FX-01/.test(caseNow()), "戻りが評価順になっていない: " + caseNow());
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
// 5: 画面幅ごとの表示
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
    return { pass: problems.length === 0, problems, label, overflow, vw: de.clientWidth };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const legacyPkg = buildLegacyPackage();
  const guidedPkg = buildGuidedPackage();

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4d-guided-"));
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

    const legacy = await run(phaseLegacy, "legacy package unchanged", legacyPkg);
    const queued = await run(phaseGuidedQueue, "guided queue, binding, duplicate, bypass", guidedPkg);

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    await run(phaseReloadResume, "reload resumes progress");
    await run(phaseEvaluationOrder, "evaluation follows evaluationOrder");

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    // 生成中のカードでレイアウトを見るため、パッケージを入れ直して先頭状態へ戻す
    await run(function reloadGuided(p) {
      return (async (pk) => {
        __PRELUDE__
        // レイアウトは「生成中」のカードで測る。記録を消して同じパッケージを入れ直し、
        // 生成フェーズの先頭へ戻す(確認ダイアログは headless を止めるので既定応答にする)。
        window.confirm = () => true;
        byId("abTab").click();
        await delay(200);
        byId("abClear").click();
        await waitFor(() => {
          const raw = localStorage.getItem("personaGenerator.abExperiment.v1");
          if (!raw) return true;
          const d = JSON.parse(raw);
          return !d.images || d.images.length === 0;
        }, "records cleared");
        loadPkg(pk, "guided2.json");
        await waitFor(() => /読み込みました|読み直しました/.test(byId("abPackageStatus").textContent), "reload guided");
        await delay(300);
        if (byId("abWorkbench").hidden !== false) {
          byId("abSetupChatgpt").click();
          await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
        }
        note(gCardVisible(), "レイアウト用の再読込で案内カードが出ていない");
        await guidedPut("layout-1.png", 700);
        note(/生成中/.test(gPhase()), "レイアウト測定時に生成フェーズでない: " + gPhase());
        return { pass: problems.length === 0, problems, images: imagesOf().length };
      })(__ARG__);
    }, "reset to generation phase for layout", guidedPkg);

    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layout.push(await run(phaseLayout, "layout / " + spec.label, spec));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

    console.log("R4D GUIDED GENERATION BROWSER ACCEPTANCE PASSED");
    console.log(`  legacy package unchanged: no guided card, ordinary drops open, phase null (${legacy.images} images placed the old way)`);
    console.log(`  queue derived from mixed slotRoles/generationOrder; 16/16 registered in exact order`);
    console.log(`  duplicate SHA-256 refused; multi-file selection refused; ordinary drops blocked while incomplete`);
    console.log(`  technical retry recorded without advancing the queue (${queued.retries} retry)`);
    console.log(`  evaluation unavailable at 15/16, available at 16/16`);
    console.log(`  reload resumed progress and retry log`);
    console.log(`  evaluation navigates FX-02 -> FX-04 -> FX-01 -> FX-03 (evaluationOrder, not package order)`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
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
