#!/usr/bin/env node
// [R5B] 狙いとの一致(opticalIntentAlignment)の**実ブラウザ**受入検査。
//  合成フィクスチャのみを使い、実験の実データ・本文・ID・語彙は一切含まない。
//
//  確かめること（R5B ブリーフ §11）:
//   1. A/B 各2画像を登録できる
//   2. 1枚目へ入力 → 2枚目へ切替 → 1枚目へ戻すと全入力が復元する
//   3. ケース移動と再読み込みのあとも全入力が復元する
//   4. 未入力の画像が1枚でもあれば保存・書き出しを拒否し、残数を画面へ出す
//   5. JSONL 書き出しと再取込で全値・件数・ハッシュが一致する
//   6. 1280 / 320 / 375 / 390 / 430 / 844x390 で横溢れ0・操作44px以上・入力16px以上
//   7. 押したコピーボタン自身に成功・失敗・再試行の状態が出る
//   8. 検査の書き出しが利用者の Downloads へ1件も出ない
//  さらに:
//   - 宣言の無い既存パッケージでは項目が1つも増えない(保存形式も変わらない)
//   - 壊れた宣言(選択肢不足・値の重複・ラベル欠落・3段階入力との併用)は読み込みを拒否する
//   - 診断値は選択肢の外の値を保存できない
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
function reseal(pkg) {
  const body = JSON.parse(JSON.stringify(pkg));
  delete body.definitionSha256;
  delete body.integrity;
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}
function clone(p) { return JSON.parse(JSON.stringify(p)); }

// 選択肢は合成の語彙。実験の分類名をこの検査へ持ち込まない。
const INTENT_STATUSES = [
  { value: "fx_ok", label: "合成の選択肢イ（合っている）" },
  { value: "fx_hard", label: "合成の選択肢ロ（強すぎる）" },
  { value: "fx_soft", label: "合成の選択肢ハ（緩すぎる。長い説明を入れて折返しも見る）" },
  { value: "fx_other", label: "合成の選択肢ニ（別の面）" },
  { value: "fx_unknown", label: "合成の選択肢ホ（判断できない）" }
];
const INTENT_QUESTION = "この画像の見え方は、合成された狙いに合っていますか（受入検査用の設問）";

function basePolicy() {
  return {
    arms: [{ id: "A", role: "slot", label: "A" }, { id: "B", role: "slot", label: "B" }],
    maxImagesPerArm: 4, requiredImagesPerArm: 2,
    verdicts: ["accept", "hold", "reject"],
    scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
    failureCodes: ["composition", "anatomy", "other", "fx_lost"],
    failureCodeLabels: { fx_lost: "合成の失敗分類（読みやすい短文）" },
    preferences: ["A", "B", "tie"],
    seedSupport: ["supported", "unsupported"],
    adoptionDecision: "not-applicable", rankImpliesAdoption: false
  };
}
function buildCases(n, tag) {
  return Array.from({ length: n }, (_, i) => {
    const no = i + 1;
    const a = `合成本文 ${tag}${no} A面。受入検査のための合成であり、実験の語彙は含まない。`;
    const b = `合成本文 ${tag}${no} B面。受入検査のための合成であり、実験の語彙は含まない。`;
    const settings = { schema: "t9_gen_settings.v1", salt: tag + no };
    return {
      sourceNo: no, caseId: tag + "-" + String(no).padStart(2, "0"),
      baselineGenerationId: "gen-" + tag.toLowerCase() + "-p" + String(no).padStart(3, "0"),
      role: "合成軸", species: "", reason: "合成フィクスチャ",
      batchId: tag.toLowerCase() + "-batch", no, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: tag.toLowerCase() + "-p" + no + "-A", role: "control", prompt: a,
             promptSha256: sha(a), treatmentApplied: false, diffSummary: "合成" },
        B: { generationId: tag.toLowerCase() + "-p" + no + "-B", role: "treatment", prompt: b,
             promptSha256: sha(b), treatmentApplied: true, diffSummary: "合成" }
      }
    };
  });
}
function buildIntentPackage() {
  const cases = buildCases(2, "OI");
  const policy = Object.assign(basePolicy(), {
    opticalIntentAlignmentRequired: true,
    opticalIntentAlignmentSchema: "opticalIntentAlignment.v1",
    opticalIntentAlignmentQuestion: INTENT_QUESTION,
    opticalIntentAlignmentStatuses: INTENT_STATUSES,
    imageNotesPlaceholder: "コメント（合成の受入検査用）"
  });
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-23T00:00:00.000Z", generatedBy: "fixture-optical-intent",
    experiment: { experimentId: "fixture-optical-intent", hypothesis: "合成",
      automaticProductionUpdate: false, seedSupported: false },
    policy,
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-fixture-optical-intent-ab.v1" },
    cases
  });
}
// 宣言の無い従来型（後方互換の確認用）
function buildLegacyPackage() {
  const cases = buildCases(1, "LG");
  return reseal({
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-23T00:00:00.000Z", generatedBy: "fixture-legacy-intent",
    experiment: { experimentId: "fixture-legacy-intent", hypothesis: "合成",
      automaticProductionUpdate: false, seedSupported: false },
    policy: basePolicy(),
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-fixture-legacy-intent-ab.v1" },
    cases
  });
}
// 壊れた宣言。1回に1箇所だけ壊し、必ず封をし直す。
function buildRejectFixtures(base) {
  const out = [];
  const add = (label, expectField, mutate) => {
    const p = clone(base);
    mutate(p);
    out.push({ label, expectField, pkg: reseal(p), name: "reject-oi-" + out.length + ".json" });
  };
  add("選択肢が1つしかない", "policy.opticalIntentAlignmentStatuses",
    (p) => { p.policy.opticalIntentAlignmentStatuses = [INTENT_STATUSES[0]]; });
  add("選択肢が配列でない", "policy.opticalIntentAlignmentStatuses",
    (p) => { p.policy.opticalIntentAlignmentStatuses = "fx_ok,fx_hard"; });
  add("選択肢の値が重複", "policy.opticalIntentAlignmentStatuses[2].value", (p) => {
    p.policy.opticalIntentAlignmentStatuses = INTENT_STATUSES.slice(0, 3).map((s, i) =>
      (i === 2 ? { value: INTENT_STATUSES[0].value, label: s.label } : s));
  });
  add("選択肢にラベルが無い", "policy.opticalIntentAlignmentStatuses[1].label", (p) => {
    p.policy.opticalIntentAlignmentStatuses = INTENT_STATUSES.slice(0, 3).map((s, i) =>
      (i === 1 ? { value: s.value } : s));
  });
  add("選択肢の値が空", "policy.opticalIntentAlignmentStatuses[0].value", (p) => {
    p.policy.opticalIntentAlignmentStatuses = INTENT_STATUSES.slice(0, 3).map((s, i) =>
      (i === 0 ? { value: "", label: s.label } : s));
  });
  add("設問文が空文字", "policy.opticalIntentAlignmentQuestion",
    (p) => { p.policy.opticalIntentAlignmentQuestion = ""; });
  add("3段階の合焦入力と併用", "policy.opticalIntentAlignmentRequired", (p) => {
    p.policy.focusRubricRequired = true;
    p.policy.focusRubricSchema = "focusAssessment.v1";
    p.cases.forEach((c) => { c.focusRubric = { targetLabel: "合成の対象", separationRequired: false }; });
  });
  return out;
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abPackageStatus")||{}).textContent||""));
  };
  const byId = (id) => document.getElementById(id);
  const problems = [];
  const note = (c, m) => { if (!c) problems.push(m); };
  const st = () => (byId("abStatus") || {}).textContent || "";
  const waitS = (re, label) => waitFor(() => re.test(st()), label);
  const setVal = (id, v) => {
    const n = byId(id);
    if (!n) { problems.push("missing input: " + id); return; }
    n.value = String(v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const WS_INDEX_KEY = "personaGenerator.abWorkspaces.v1";
  const LEGACY_STORE_KEY = "personaGenerator.abExperiment.v1";
  const abWsIndex = () => {
    try { return JSON.parse(localStorage.getItem(WS_INDEX_KEY)); } catch (_) { return null; }
  };
  const activeWsEntry = () => {
    const i = abWsIndex();
    if (!i || !i.activeId) return null;
    return (i.workspaces || []).filter((w) => w.id === i.activeId)[0] || null;
  };
  const abKey = () => { const w = activeWsEntry(); return w ? w.storeKey : LEGACY_STORE_KEY; };
  const store = () => JSON.parse(localStorage.getItem(abKey()));
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
  const loadPkg = (pkg, name) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(pkg, null, 2) + "\\n"], name, { type: "application/json" }));
    const input = byId("abFileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const openAbTab = async () => {
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    await delay(250);
  };
  const rid = (arm, name) => "abRev" + arm + "_" + name;
  const intentSelect = (arm) => byId(rid(arm, "opticalIntentValue"));
  const intentHead = (arm) => byId(rid(arm, "opticalIntentHead"));
  const setIntent = (arm, v) => setVal(rid(arm, "opticalIntentValue"), v);
  const getIntent = (arm) => { const n = intentSelect(arm); return n ? n.value : null; };
  const setSide = (arm, verdict, aes, intent, notes, intentValue, failures) => {
    setVal(rid(arm, "verdict"), verdict);
    setVal(rid(arm, "aestheticSatisfaction"), aes);
    setVal(rid(arm, "intentMatch"), intent);
    if (notes !== undefined) setVal(rid(arm, "notes"), notes);
    if (intentValue !== undefined) setIntent(arm, intentValue);
    if (failures) {
      const box = byId(rid(arm, "failures"));
      failures.forEach((code) => {
        const row = box.querySelector('[data-ab-failure-code="' + code + '"]');
        if (!row) { problems.push("missing failure code " + code); return; }
        const cb = row.querySelector("input");
        cb.checked = true;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  };
  const readSide = (arm) => ({
    verdict: byId(rid(arm, "verdict")).value,
    aes: byId(rid(arm, "aestheticSatisfaction")).value,
    intent: byId(rid(arm, "intentMatch")).value,
    notes: byId(rid(arm, "notes")).value,
    intentValue: getIntent(arm),
    failures: Array.prototype.slice.call(byId(rid(arm, "failures"))
      .querySelectorAll("[data-ab-failure-code]"))
      .filter((r) => r.querySelector("input").checked)
      .map((r) => r.getAttribute("data-ab-failure-code"))
  });
  const thumbs = (arm) => Array.prototype.slice.call(byId("abThumbs" + arm).querySelectorAll("img"));
  const selectThumb = async (arm, i) => {
    const t = thumbs(arm);
    if (!t[i]) { problems.push("thumb " + arm + i + " missing"); return; }
    t[i].click();
    await delay(220);
  };
  const flowText = () => (byId("abFlowState") || {}).textContent || "";
`;

// ---------------------------------------------------------------------------
// 1: 宣言の無いパッケージでは項目が1つも増えない
// ---------------------------------------------------------------------------
function phaseLegacy(pkg) {
  return (async (p) => {
    __PRELUDE__
    await openAbTab();
    loadPkg(p, "legacy-intent.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "legacy loaded");
    await waitFor(() => byId("abSetup").hidden === false, "setup");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    note(!intentSelect("A") && !intentSelect("B"), "宣言が無いのに狙いとの一致が出ている");
    note(intentHead("A") && intentHead("A").hidden === true, "宣言が無いのに見出しが出ている");
    // 従来どおり保存でき、保存形式に新しいキーが増えない
    await pickImage("A", "lg-a1.png", 11); await pickImage("A", "lg-a2.png", 12);
    await pickImage("B", "lg-b1.png", 13); await pickImage("B", "lg-b2.png", 14);
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 2; i += 1) {
        await selectThumb(arm, i);
        setSide(arm, "accept", "4", "4", "従来の記録 " + arm + i);
        await delay(80);
      }
    }
    setVal("abPreference", "tie");
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled (legacy)");
    byId("abSaveNext").click();
    await waitFor(() => (store().reviews || []).length === 4, "legacy reviews saved");
    const saved = store().reviews;
    note(saved.every((r) => !("opticalIntentAlignment" in r)),
      "宣言の無いパッケージの保存へ新しいキーが入った");
    note(saved.every((r) => !("focusAssessment" in r)), "宣言の無いパッケージへ focusAssessment が入った");
    // 失敗分類のラベルは宣言があるものだけ差し替わり、保存値はコードのまま
    const labelRow = byId(rid("A", "failures")).querySelector('[data-ab-failure-code="fx_lost"] span');
    note(labelRow && labelRow.textContent === "合成の失敗分類（読みやすい短文）",
      "失敗分類の短文が使われていない: " + (labelRow && labelRow.textContent));
    const plainRow = byId(rid("A", "failures")).querySelector('[data-ab-failure-code="composition"] span');
    note(plainRow && plainRow.textContent === "composition",
      "短文の無いコードが書き換えられた: " + (plainRow && plainRow.textContent));
    return { pass: problems.length === 0, problems, reviews: saved.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 2: 壊れた宣言は1つずつ拒否され、既存の記録は変わらない
// ---------------------------------------------------------------------------
function phaseReject(list) {
  return (async (fixtures) => {
    __PRELUDE__
    window.confirm = () => { problems.push("拒否されるはずのパッケージで確認ダイアログが出た"); return false; };
    const before = localStorage.getItem(abKey());
    const beforeExp = store().pkg.experiment.experimentId;
    for (const f of fixtures) {
      byId("abPackageStatus").textContent = "";
      loadPkg(f.pkg, f.name);
      await waitFor(() => /使えません|読み込みました|読み直しました|中止しました/
        .test(byId("abPackageStatus").textContent), "verdict for " + f.label);
      const verdict = byId("abPackageStatus").textContent;
      note(/使えません/.test(verdict), f.label + " が拒否されていない: " + verdict);
      note(verdict.indexOf(f.expectField) >= 0,
        f.label + " の指摘箇所が " + f.expectField + " でない: " + verdict);
      note(localStorage.getItem(abKey()) === before, f.label + " の拒否で保存内容が変わった");
      note(store().pkg.experiment.experimentId === beforeExp, f.label + " の拒否でパッケージが差し替わった");
    }
    note(byId("abWorkbench").hidden === false, "拒否のあとで作業台が閉じた");
    return { pass: problems.length === 0, problems, rejected: fixtures.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 3: 宣言したパッケージ — 項目が出て、A/B各2枚を登録し、往復で入力が復元する
// ---------------------------------------------------------------------------
function phaseRoundTrip(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(a.pkg, "optical-intent.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "intent loaded");
    await waitFor(() => byId("abSetup").hidden === false, "setup for intent");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench for intent");

    // 項目が出る。設問文も選択肢もパッケージから読む。
    note(!!intentSelect("A") && !!intentSelect("B"), "狙いとの一致が出ていない");
    note(intentHead("A").hidden === false, "見出しが隠れたまま");
    note(intentHead("A").textContent === a.question,
      "設問文がパッケージのものでない: " + intentHead("A").textContent);
    const opts = Array.prototype.slice.call(intentSelect("A").options).map((o) => o.value);
    note(JSON.stringify(opts) === JSON.stringify([""].concat(a.statuses)),
      "選択肢がパッケージと違う: " + JSON.stringify(opts));
    const labels = Array.prototype.slice.call(intentSelect("A").options).slice(1).map((o) => o.textContent);
    note(labels.every((l) => /合成の選択肢/.test(l)), "選択肢の短文が使われていない");
    note(!/control|treatment|対照|処理群/.test(byId("abReviewA").textContent),
      "レビュー欄に役割語が出ている");

    // A/B 各2枚
    await pickImage("A", "oi-a1.png", 21); await pickImage("A", "oi-a2.png", 22);
    await pickImage("B", "oi-b1.png", 23); await pickImage("B", "oi-b2.png", 24);
    note(thumbs("A").length === 2 && thumbs("B").length === 2,
      "A/B各2枚になっていない: " + thumbs("A").length + "/" + thumbs("B").length);

    // 1枚目へ入力
    await selectThumb("A", 0);
    setSide("A", "accept", "5", "4", "1枚目のコメント", a.statuses[0], ["composition"]);
    await delay(120);
    const first = readSide("A");
    note(first.intentValue === a.statuses[0], "1枚目の診断値が入っていない: " + first.intentValue);

    // 2枚目へ切替えて別の値を入れる
    await selectThumb("A", 1);
    const blank = readSide("A");
    note(blank.verdict === "" && blank.intentValue === "",
      "2枚目へ切替えたのに1枚目の入力が残っている: " + JSON.stringify(blank));
    setSide("A", "hold", "2", "3", "2枚目のコメント", a.statuses[2], ["anatomy"]);
    await delay(120);

    // 1枚目へ戻すと全値が復元する
    await selectThumb("A", 0);
    const back = readSide("A");
    note(JSON.stringify(back) === JSON.stringify(first),
      "1枚目へ戻したのに入力が復元しない: " + JSON.stringify(back) + " 期待 " + JSON.stringify(first));

    // 2枚目もそのまま
    await selectThumb("A", 1);
    const second = readSide("A");
    note(second.verdict === "hold" && second.intentValue === a.statuses[2]
      && second.notes === "2枚目のコメント" && second.aes === "2",
      "2枚目の入力が復元しない: " + JSON.stringify(second));

    // B側も2枚入れる
    await selectThumb("B", 0);
    setSide("B", "accept", "4", "5", "B1", a.statuses[1]);
    await delay(100);
    await selectThumb("B", 1);
    setSide("B", "reject", "1", "2", "B2", a.statuses[4], ["fx_lost"]);
    await delay(120);
    return { pass: problems.length === 0, problems,
      first: first, second: second };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 4: 未入力が残る間は保存できず、残数が画面へ出る
// ---------------------------------------------------------------------------
function phaseIncomplete(arg) {
  return (async (a) => {
    __PRELUDE__
    // B の2枚目の診断値だけを消す
    await selectThumb("B", 1);
    setIntent("B", "");
    await delay(150);
    note(/狙いとの一致が 1 件/.test(flowText()),
      "未入力の残数が画面へ出ていない: " + flowText());
    setVal("abPreference", "tie");
    await delay(150);
    note(byId("abSaveNext").disabled === true, "診断値が空でも保存が押せる");
    // 直接呼んでも保存されない
    const beforeReviews = (store().reviews || []).length;
    byId("abStatus").textContent = "";
    byId("abSaveNext").click();
    await delay(300);
    note((store().reviews || []).length === beforeReviews, "未入力なのに保存された");

    // 書き出しも拒否される
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await delay(400);
    note(/未評価の画像が 1 枚あります/.test(st()), "未入力なのに書き出しが通った: " + st());
    note(/すべて評価するまで書き出せません/.test(st()), "書き出せない理由が出ていない: " + st());

    // 埋めると保存できる
    setIntent("B", a.statuses[4]);
    await delay(200);
    note(!/狙いとの一致が/.test(flowText()), "埋めたのに残数が残っている: " + flowText());
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled after filling");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 5: ケース移動と再読み込みで全入力が復元する
// ---------------------------------------------------------------------------
function phaseMoveAndReload(arg) {
  return (async (a) => {
    __PRELUDE__
    const before = { A: [], B: [] };
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 2; i += 1) { await selectThumb(arm, i); before[arm].push(readSide(arm)); }
    }
    // ケース2へ移動して戻る
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test((byId("abCaseCounter") || {}).textContent || ""), "case 2");
    await delay(200);
    note(!!intentSelect("A"), "ケース移動で項目が消えた");
    note(getIntent("A") === "", "ケース2に前ケースの診断値が残っている: " + getIntent("A"));
    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test((byId("abCaseCounter") || {}).textContent || ""), "case 1");
    await delay(250);
    const after = { A: [], B: [] };
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 2; i += 1) { await selectThumb(arm, i); after[arm].push(readSide(arm)); }
    }
    note(JSON.stringify(after) === JSON.stringify(before),
      "ケース往復で入力が変わった: " + JSON.stringify(after));
    return { pass: problems.length === 0, problems, before };
  })(__ARG__);
}
function phaseAfterReload(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after reload");
    await delay(300);
    note(!!intentSelect("A"), "再読み込みで項目が消えた");
    note(intentHead("A").textContent === a.question, "再読み込みで設問文が変わった");
    const after = { A: [], B: [] };
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 2; i += 1) { await selectThumb(arm, i); after[arm].push(readSide(arm)); }
    }
    note(JSON.stringify(after) === JSON.stringify(a.before),
      "再読み込みで入力が復元しない: " + JSON.stringify(after));
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 6: 保存 → 書き出し → 再取込で全値・件数・ハッシュが一致する
// ---------------------------------------------------------------------------
function phaseSaveAndExport(arg) {
  return (async (a) => {
    __PRELUDE__
    setVal("abPreference", "A");
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled");
    byId("abSaveNext").click();
    await waitFor(() => (store().reviews || []).length >= 4, "reviews saved");
    const saved = (store().reviews || []).filter((r) => /OI-01/.test(r.imageId) || true);
    const withIntent = saved.filter((r) => !!r.opticalIntentAlignment);
    note(withIntent.length >= 4, "診断値つきの記録が4件未満: " + withIntent.length);
    note(withIntent.every((r) => a.statuses.indexOf(r.opticalIntentAlignment) >= 0),
      "宣言外の診断値が保存された");
    note(Object.keys(store().reviewDrafts || {}).length === 0, "保存後に下書きが残っている");

    // 書き出し(Blob を捕まえて中身を読む。ダウンロード先は使い捨てへ固定済み)
    const orig = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "reviews exported");
    const text = await captured.text();
    URL.createObjectURL = orig;
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    note(rows.length === 2, "書き出し行数が 2 でない（画像を置いたのはケース1だけ）: " + rows.length);
    const images = rows.reduce((acc, r) => acc.concat(r.images), []);
    note(images.length === 4, "書き出しの画像が 4 枚でない: " + images.length);
    note(images.every((im) => a.statuses.indexOf(im.evaluation.opticalIntentAlignment) >= 0),
      "書き出しへ診断値が出ていない: "
      + JSON.stringify(images.map((im) => im.evaluation.opticalIntentAlignment)));
    note(images.every((im) => !("focusAssessment" in im.evaluation)),
      "宣言していない focusAssessment が書き出しへ出た");

    // 端末の記録と書き出しが同じ値であること(画像単位で突き合わせる)
    const byId2 = new Map(images.map((im) => [im.imageId, im]));
    const mismatches = [];
    (store().reviews || []).forEach((r) => {
      const im = byId2.get(r.imageId);
      if (!im) return;
      if (String(im.evaluation.verdict) !== String(r.verdict)) mismatches.push(r.imageId + ":verdict");
      if (String(im.evaluation.aestheticSatisfaction) !== String(r.scores.aestheticSatisfaction)) {
        mismatches.push(r.imageId + ":aes");
      }
      if (String(im.evaluation.opticalIntentAlignment || "") !== String(r.opticalIntentAlignment || "")) {
        mismatches.push(r.imageId + ":intent");
      }
      if (JSON.stringify((im.evaluation.failures || []).slice().sort())
        !== JSON.stringify((r.failures || []).slice().sort())) mismatches.push(r.imageId + ":failures");
      if (String(im.notes || "") !== String(r.notes || "")) mismatches.push(r.imageId + ":notes");
    });
    note(mismatches.length === 0, "端末の記録と書き出しが一致しない: " + mismatches.join(","));
    // 画像ハッシュも保持されている
    note(images.every((im) => /^[0-9a-f]{64}$/.test(im.metadata.sha256)), "画像ハッシュが欠けている");
    return { pass: problems.length === 0, problems, exported: text,
      rows: rows.length, images: images.length };
  })(__ARG__);
}
// 書き出したJSONLを再取込して、件数・値・ハッシュが一致することを確かめる
function phaseReimport(arg) {
  return (async (a) => {
    __PRELUDE__
    const rows = a.exported.trim().split("\n").map((l) => JSON.parse(l));
    const d = store();
    const live = d.reviews || [];
    const liveById = new Map(live.map((r) => [r.imageId, r]));
    // 画像のハッシュは記録側の images 行が持つ(reviews は評価だけを持つ)。
    const imgById = new Map((d.images || []).map((r) => [r.imageId, r]));
    const images = rows.reduce((acc, r) => acc.concat(r.images), []);
    note(images.length === live.length, "再取込の画像数が端末の評価数と違う: "
      + images.length + " / " + live.length);
    const bad = images.filter((im) => {
      const r = liveById.get(im.imageId);
      const rec = imgById.get(im.imageId);
      if (!r || !rec) return true;
      return String(im.evaluation.opticalIntentAlignment || "") !== String(r.opticalIntentAlignment || "")
        || String(im.metadata.sha256) !== String((rec.metadata || {}).sha256)
        || Number(im.rank) !== Number(rec.rank);
    });
    note(bad.length === 0, "再取込で一致しない画像がある: " + bad.map((im) => im.imageId).join(","));
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 7: 押したコピーボタン自身に成功・失敗・再試行が出る
// ---------------------------------------------------------------------------
function phaseCopyState() {
  return (async () => {
    __PRELUDE__
    const btn = byId("abCopyA");
    const label = btn.textContent;
    const realClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      || Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const realExec = document.execCommand;

    // 成功
    let copied = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: (t) => { copied = t; return Promise.resolve(); } }
    });
    btn.click();
    await waitFor(() => btn.getAttribute("data-copy-state") === "success", "copy success state");
    note(/コピーしました/.test(btn.textContent), "成功が押したボタンに出ていない: " + btn.textContent);
    note(btn.classList.contains("flash-ok"), "成功の色が付いていない");
    note(typeof copied === "string" && copied.length > 0, "本文が渡っていない");

    // 失敗 → 同じボタンに再試行が出る
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) }
    });
    document.execCommand = () => false;
    btn.click();
    await waitFor(() => btn.getAttribute("data-copy-state") === "error", "copy error state");
    note(/再試行/.test(btn.textContent), "再試行の案内が押したボタンに出ていない: " + btn.textContent);
    note(btn.classList.contains("flash-err"), "失敗の色が付いていない");

    // もう一度成功させると元へ戻る
    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: () => Promise.resolve() }
    });
    document.execCommand = realExec;
    btn.click();
    await waitFor(() => btn.getAttribute("data-copy-state") === "success", "copy success again");
    await waitFor(() => btn.getAttribute("data-copy-state") === "idle", "copy state returns to idle", 6000);
    note(btn.textContent === label, "ボタンの文言が元へ戻らない: " + btn.textContent);

    if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
    else delete navigator.clipboard;
    return { pass: problems.length === 0, problems };
  })();
}

// レイアウトは「画像も評価もある状態」で測る。
function phaseBackToCase1() {
  return (async () => {
    __PRELUDE__
    if (!/ケース 1 \/ 2/.test((byId("abCaseCounter") || {}).textContent || "")) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test((byId("abCaseCounter") || {}).textContent || ""), "case 1");
    }
    await delay(300);
    await selectThumb("A", 0);
    await selectThumb("B", 0);
    await delay(200);
    note(!!intentSelect("A") && intentSelect("A").getClientRects().length > 0,
      "レイアウト測定の前提が整っていない（項目が見えていない）");
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
// 8: 画面幅
// ---------------------------------------------------------------------------
function phaseLayout(spec) {
  return (async (a) => {
    __PRELUDE__
    await delay(300);
    const de = document.documentElement;
    const overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow <= 1, a.label + " で横溢れ: " + overflow + "px");
    const wide = [];
    byId("abView").querySelectorAll("*").forEach((n) => {
      if (n.getClientRects().length && n.scrollWidth > de.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, a.label + " で幅超過要素: " + wide.slice(0, 4).join(", "));
    // 診断値の入力欄: 44px以上・16px以上・画面内
    ["A", "B"].forEach((arm) => {
      const n = intentSelect(arm);
      note(!!n, a.label + " の " + arm + " に項目が無い");
      if (!n) return;
      const r = n.getBoundingClientRect();
      note(r.height >= 44, a.label + " の " + arm + " の入力が44px未満: " + Math.round(r.height));
      note(r.width <= de.clientWidth + 1, a.label + " の " + arm + " の入力が画面幅を超えている");
      const fs = parseFloat(getComputedStyle(n).fontSize);
      note(fs >= 16, a.label + " の " + arm + " の入力が16px未満: " + fs);
      const head = intentHead(arm);
      note(head.scrollWidth <= head.clientWidth + 1,
        a.label + " の設問文が横に溢れている: " + head.scrollWidth + " > " + head.clientWidth);
    });
    // A/B の項目が同じ基準線に並ぶ(デスクトップの2列時)
    if (de.clientWidth >= 720) {
      const ra = intentSelect("A").getBoundingClientRect();
      const rb = intentSelect("B").getBoundingClientRect();
      note(Math.abs(ra.top - rb.top) <= 1,
        a.label + " で A/B の項目の上端がずれている: " + Math.abs(ra.top - rb.top));
      note(Math.abs(ra.height - rb.height) <= 1, a.label + " で A/B の項目の高さが違う");
    }
    // 主要操作は44px以上
    ["abSaveNext", "abCopyA", "abCopyB", "abPrev", "abNext"].forEach((id) => {
      const n = byId(id);
      if (!n || !n.getClientRects().length) return;
      const r = n.getBoundingClientRect();
      note(r.height >= 44, a.label + " の " + id + " が44px未満: " + Math.round(r.height));
    });
    return { pass: problems.length === 0, problems, label: a.label, overflow, vw: de.clientWidth };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const legacyPkg = buildLegacyPackage();
  const intentPkg = buildIntentPackage();
  const rejects = buildRejectFixtures(intentPkg);
  const statuses = INTENT_STATUSES.map((s) => s.value);

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b-intent-"));
  // 書き出しは使い捨ての保存先へ固定する。利用者の Downloads へ1件も出さない。
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b-intent-dl-"));
  const homeDownloads = path.join(os.homedir(), "Downloads");
  const snapshotDownloads = () => {
    try { return new Set(fs.readdirSync(homeDownloads)); } catch (_) { return new Set(); }
  };
  const beforeDownloads = snapshotDownloads();

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
    await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    const target = await client.send("Target.createTarget", { url: baseUrl + "/" });
    const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(1500);

    const run = async (fn, label, arg, timeout = 180000) => {
      const at = Date.now();
      process.stderr.write("  [phase] " + label + " ...\n");
      let source = fn.toString().replace("__PRELUDE__", PRELUDE);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      const ev = await client.send("Runtime.evaluate",
        { expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout }, sessionId);
      process.stderr.write("  [phase] " + label + " done in "
        + ((Date.now() - at) / 1000).toFixed(1) + "s\n");
      if (ev.exceptionDetails) fail(`${label} threw`, ev.exceptionDetails);
      const v = ev.result && ev.result.value;
      if (!v || !v.pass) fail(`${label} failed`, v);
      return v;
    };
    const reload = async (settle = 2200) => {
      await client.send("Page.reload", { ignoreCache: false }, sessionId);
      await wait(settle);
    };

    const legacy = await run(phaseLegacy, "declaration-free package gains no field", legacyPkg);
    const rejected = await run(phaseReject, "broken declarations refused one at a time",
      rejects.map((f) => ({ label: f.label, expectField: f.expectField, pkg: f.pkg, name: f.name })));
    const round = await run(phaseRoundTrip, "item appears; two images per arm; image round trip restores every value",
      { pkg: intentPkg, question: INTENT_QUESTION, statuses }, 240000);
    await run(phaseIncomplete, "an unanswered image blocks save and export and shows the remaining count",
      { statuses });
    const moved = await run(phaseMoveAndReload, "case move keeps every value", { statuses });
    await reload();
    await run(phaseAfterReload, "reload keeps every value",
      { question: INTENT_QUESTION, before: moved.before });
    const exported = await run(phaseSaveAndExport, "save and export carry every value", { statuses });
    await run(phaseReimport, "re-import matches values, counts and hashes",
      { exported: exported.exported });
    await run(phaseCopyState, "the pressed copy button shows success, failure and retry");

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    await run(phaseBackToCase1, "return to the evaluated case for layout");
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layout.push(await run(phaseLayout, "layout / " + spec.label, { label: spec.label }, 90000));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

    // 書き出しが使い捨ての保存先に留まり、利用者の Downloads へ漏れていないこと
    const captured = fs.readdirSync(downloadDir);
    const leaked = [...snapshotDownloads()].filter((n) => !beforeDownloads.has(n));
    if (leaked.length) fail("検査の書き出しが利用者の Downloads へ出た", leaked);

    console.log("R5B OPTICAL INTENT BROWSER ACCEPTANCE PASSED");
    console.log(`  declaration-free package unchanged: no new field, no new saved key (${legacy.reviews} reviews saved the old way)`);
    console.log(`  ${rejected.rejected} broken declarations refused one at a time; package and records unchanged after every rejection`);
    console.log(`  the item reads its question and its five options from the package; no role vocabulary on screen`);
    console.log(`  two images per arm; image switch and return restored verdict, both scores, failures, notes and the item`);
    console.log(`  an unanswered image blocked save and export and printed the remaining count`);
    console.log(`  case move and reload restored every value for all four images`);
    console.log(`  export carried ${exported.rows} rows / ${exported.images} images with the item and the image hashes; re-import matched`);
    console.log(`  the pressed copy button showed success, then failure with retry, then returned to its label`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
    console.log(`  ${captured.length} export downloads stayed in the disposable directory; user Downloads gained 0 files`);
  } finally {
    if (client) {
      try { await client.send("Browser.setDownloadBehavior", { behavior: "deny" }); }
      catch (_) { /* 閉じる途中の失敗は無視 */ }
      client.close();
    }
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
