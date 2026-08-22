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
// ---------------------------------------------------------------------------
// 合成フィクスチャ。実験の実データ・生成規則・語彙はここへ持ち込まない。
// ---------------------------------------------------------------------------
const LONG_TARGET = "合成の長い合焦対象名。" + "折り返しの検査のために意味を持たない合成文をつないで長くしています。".repeat(3);
// 注: このファイルの合成フィクスチャは、実験の本文・語彙・対象名を一切含まない。

function buildLegacyPackage() {
  const cases = [1, 2].map((n) => {
    const a = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 末尾`;
    const b = a + "\n合成の処理行";
    const settings = { schema: "t9_gen_settings.v1", salt: "legacy-" + n, controls: { density: n } };
    return {
      sourceNo: n, baselineGenerationId: "gen-legacy-p" + String(n).padStart(3, "0"),
      role: "合成軸" + n, species: "", reason: "合成フィクスチャ",
      batchId: "legacy-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: "legacy-p" + n + "-A", role: "control", prompt: a, promptSha256: sha(a),
             treatmentApplied: false, diffSummary: "元のプロンプトのまま。" },
        B: { generationId: "legacy-p" + n + "-B", role: "treatment", prompt: b, promptSha256: sha(b),
             treatmentApplied: true, diffSummary: "合成の処理行を足しています。" }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-14T00:00:00.000Z", generatedBy: "fixture-legacy-focus",
    experiment: { experimentId: "fixture-legacy-focus", hypothesis: "合成", automaticProductionUpdate: false, seedSupported: false },
    policy: {
      arms: [{ id: "A", role: "control", label: "A 合成" }, { id: "B", role: "treatment", label: "B 合成" }],
      maxImagesPerArm: 2, requiredImagesPerArm: 2,
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-legacy-focus-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

// ケース1: 前後差あり(separationRequired=true) / ケース2: 前後差なし + 長い対象名
function buildFocusPackage() {
  // 合成の対象名。実験の実際の合焦対象名・実本文の語彙は公開リポジトリへ持ち込まない。
  const spec = { 1: { target: "合成の合焦対象イ", sep: true }, 2: { target: LONG_TARGET, sep: false } };
  const cases = [1, 2].map((n) => {
    const a = `合成プロンプト ${n} 行目A\n合成の焦点指示: 対象イに合わせ、周囲をゆるめる。`;
    const b = `合成プロンプト ${n} 行目A\n合成の焦点指示: 対象イの細部に合わせ、周囲をゆるめる。`;
    const settings = { schema: "t9_gen_settings.v1", salt: "focus-" + n, controls: { density: n } };
    return {
      sourceNo: n, baselineGenerationId: "gen-focus-p" + String(n).padStart(3, "0"),
      role: "合成軸" + n, species: "", reason: "合成フィクスチャ",
      batchId: "focus-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      focusRubric: { targetLabel: spec[n].target, separationRequired: spec[n].sep },
      arms: {
        A: { generationId: "focus-p" + n + "-A", role: "control", prompt: a, promptSha256: sha(a),
             treatmentApplied: false, diffSummary: "元のプロンプトのまま。" },
        B: { generationId: "focus-p" + n + "-B", role: "treatment", prompt: b, promptSha256: sha(b),
             treatmentApplied: true, treatmentRuleId: "FIXTURE-FOCUS-RULE",
             diffSummary: "合成の合焦対象を名指ししています。" }
      }
    };
  });
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-14T00:00:00.000Z", generatedBy: "fixture-focus",
    experiment: { experimentId: "fixture-focus", hypothesis: "合成", automaticProductionUpdate: false, seedSupported: false },
    policy: {
      arms: [{ id: "A", role: "control", label: "A 合成" }, { id: "B", role: "treatment", label: "B 合成" }],
      maxImagesPerArm: 2, requiredImagesPerArm: 2,
      focusRubricRequired: true, focusRubricSchema: "focusAssessment.v1",
      compareNotesPlaceholder: "合成の比較案内文",
      imageNotesPlaceholder: "合成の画像コメント案内文",
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"], scoreMin: 1, scoreMax: 5,
      failureCodes: ["composition", "anatomy", "other"], preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"], adoptionDecision: "not-applicable", rankImpliesAdoption: false
    },
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-focus-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

function derive(base, mutate) {
  const next = JSON.parse(JSON.stringify(base));
  mutate(next);
  delete next.definitionSha256;
  delete next.integrity;
  next.definitionSha256 = sha(definitionText(next));
  next.integrity = { algorithm: "sha256", value: sha(JSON.stringify(next)) };
  return next;
}
function buildInvalidFocusPackages(base) {
  return [
    { label: "focusRubric欠落", field: "focusRubric", pkg: derive(base, (p) => { delete p.cases[0].focusRubric; }) },
    { label: "targetLabel空", field: "targetLabel", pkg: derive(base, (p) => { p.cases[0].focusRubric.targetLabel = ""; }) },
    { label: "separationRequiredが真偽値でない", field: "separationRequired",
      pkg: derive(base, (p) => { p.cases[1].focusRubric.separationRequired = "yes"; }) },
    { label: "2件目のケースの focusRubric が壊れている", field: "focusRubric",
      pkg: derive(base, (p) => { p.cases[1].focusRubric = null; }) }
  ];
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
// 合焦欄を触るためのページ側ヘルパ(PRELUDE へ追記する)
const FOCUS_HELPERS = `
  const focusRows = (arm) => Array.prototype.slice.call(
    byId("abRev" + arm + "_focus").querySelectorAll("[data-ab-focus-field]"));
  const focusSel = (arm, field) => {
    const row = byId("abRev" + arm + "_focus").querySelector('[data-ab-focus-field="' + field + '"]');
    return row ? row.querySelector("select") : null;
  };
  const setFocusField = (arm, field, value) => {
    const sel = focusSel(arm, field);
    if (!sel) { problems.push("missing focus row: " + arm + " " + field); return; }
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const getFocusField = (arm, field) => { const s = focusSel(arm, field); return s ? s.value : null; };
  const focusDisabled = (arm, field) => { const s = focusSel(arm, field); return s ? s.disabled : null; };
  const derivedOf = (arm) => {
    const n = byId("abRev" + arm + "_focusDerived");
    return n ? (n.getAttribute("data-ab-focus-derived") || "") : null;
  };
  const focusTargetText = (arm) => {
    const n = byId("abRev" + arm + "_focusTarget");
    return n ? n.textContent : null;
  };
  const reviewCount = () => {
    const raw = localStorage.getItem(abKey());
    return raw ? (JSON.parse(raw).reviews || []).length : 0;
  };
  const saveCase = async (label, expectAtLeast) => {
    const before = reviewCount();
    await waitFor(() => !byId("abSaveNext").disabled, "save enabled " + label);
    byId("abSaveNext").click();
    await waitFor(() => reviewCount() >= (expectAtLeast === undefined ? before + 1 : expectAtLeast),
      "records written " + label);
    return reviewCount();
  };
  const setFocusAll = (arm, v, s, d) => {
    setFocusField(arm, "targetVisibility", v);
    if (s !== undefined && s !== null) setFocusField(arm, "targetSharpness", s);
    if (d !== undefined && d !== null) setFocusField(arm, "depthSeparation", d);
  };
`;

// ---------------------------------------------------------------------------
// シナリオ1: 宣言の無い従来パッケージは合焦欄が増えない
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
    await pickImage("A", "legacy-a1.png", 11);
    note(byId("abRevA_focusHead").hidden === true, "宣言が無いのに『合焦対象の反映』の見出しが出ている");
    note(focusRows("A").length === 0, "宣言が無いのに合焦の行が出ている");
    await pickImage("A", "legacy-a2.png", 12);
    await pickImage("B", "legacy-b1.png", 13);
    await pickImage("B", "legacy-b2.png", 14);
    const lthumbs = (arm) => Array.prototype.slice.call(byId("abThumbs" + arm).querySelectorAll("img"));
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 2; i += 1) {
        lthumbs(arm)[i].click();
        await delay(200);
        reviewSide(arm, "hold", "3", "2", "従来の記録" + arm + (i + 1));
      }
    }
    setVal("abPreference", "A");
    setVal("abCompareNotes", "従来の比較");
    await saveCase("legacy", 4);
    const rows = await exportRows("abExportReviews");
    const ev = rows[0].images[0].evaluation;
    note(!("focusAssessment" in ev), "宣言が無いのに focusAssessment が書き出されている");
    note(Object.keys(ev).sort().join(",") === "aestheticSatisfaction,failures,intentMatch,verdict",
      "従来の evaluation キーが増えている: " + Object.keys(ev).sort().join(","));
    return { pass: problems.length === 0, problems, legacyKeys: Object.keys(ev).length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// シナリオ2: 合焦パッケージのゲート・導出・矛盾拒否・未入力ブロック
// ---------------------------------------------------------------------------
function phaseFocusGate(pkg) {
  return (async (p) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(p, "focus.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "focus loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await pickImage("A", "focus-a1.png", 21);
    await pickImage("A", "focus-a2.png", 22);
    await pickImage("B", "focus-b1.png", 23);
    await pickImage("B", "focus-b2.png", 24);

    note(byId("abRevA_focusHead").hidden === false, "合焦の見出しが出ていない");
    note(focusRows("A").length === 3, "合焦の行が3つでない: " + focusRows("A").length);
    note(/合成の合焦対象イ/.test(focusTargetText("A")), "合焦対象名が出ていない: " + focusTargetText("A"));
    note(/前後との鮮明度差も見る/.test(focusTargetText("A")), "前後差の要否が出ていない");
    note(byId("abRevA_focusDerived") !== null, "自動判定の表示が無い");
    note(byId("abRevA_focusDerived").tagName !== "SELECT" && byId("abRevA_focusDerived").tagName !== "INPUT",
      "自動判定が入力可能になっている");

    // R4B: not_visible と indeterminate は別の意味であることを文言で確かめる。
    const visSel = focusSel("A", "targetVisibility");
    const optText = (v) => {
      const o = Array.prototype.slice.call(visSel.options).filter((x) => x.value === v)[0];
      return o ? o.textContent : null;
    };
    note(optText("not_visible") === "画面内に存在しない／顔が完全に隠れている",
      "not_visible の文言が違う: " + optText("not_visible"));
    note(optText("indeterminate") === "画像から存在・合焦を判断できない",
      "indeterminate の文言が違う: " + optText("indeterminate"));
    note(optText("visible") === "画面内に見えている", "visible の文言が違う: " + optText("visible"));
    note(optText("not_visible") !== optText("indeterminate"), "not_visible と indeterminate の文言が同じ");
    note(!/判別できない/.test(optText("not_visible")),
      "not_visible の文言が不確実性を対象の不在として説明している: " + optText("not_visible"));
    note(!/存在しない|隠れている/.test(optText("indeterminate")),
      "indeterminate の文言が対象の不在として説明している: " + optText("indeterminate"));

    // 未入力では完了できない
    reviewSide("A", "hold", "3", "3", "");
    reviewSide("B", "hold", "3", "3", "");
    note(byId("abSaveNext").disabled === true, "合焦が未入力なのに保存できてしまう");
    note(derivedOf("A") === "", "未入力なのに判定が出ている: " + derivedOf("A"));

    // 導出の網羅(前後差あり)
    const table = [
      ["visible", "pass", "pass", "present"],
      ["visible", "pass", "fail", "missing"],
      ["visible", "pass", "indeterminate", "unclear"],
      ["visible", "fail", "pass", "missing"],
      ["visible", "fail", "fail", "missing"],
      ["visible", "fail", "indeterminate", "missing"],
      ["visible", "indeterminate", "pass", "unclear"],
      ["visible", "indeterminate", "fail", "missing"],
      ["visible", "indeterminate", "indeterminate", "unclear"]
    ];
    for (const t of table) {
      setFocusAll("A", t[0], t[1], t[2]);
      await delay(30);
      note(derivedOf("A") === t[3],
        "導出が違う " + t.slice(0, 3).join("/") + " => " + derivedOf("A") + " (期待 " + t[3] + ")");
    }
    // 対象が見えないときは以降を問わず、矛盾する組み合わせを作れない
    setFocusField("A", "targetVisibility", "not_visible");
    await delay(30);
    note(derivedOf("A") === "target_not_visible", "not_visible の判定が違う: " + derivedOf("A"));
    note(getFocusField("A", "targetSharpness") === "not_applicable"
      && getFocusField("A", "depthSeparation") === "not_applicable",
      "not_visible なのに鮮明さ・前後差が該当なしへ落ちていない");
    note(focusDisabled("A", "targetSharpness") === true && focusDisabled("A", "depthSeparation") === true,
      "not_visible なのに以降の欄が操作可能なまま");
    const derivedText = (arm) => (byId("abRev" + arm + "_focusDerived") || {}).textContent || "";
    note(/target_not_visible（対象が画面内に存在しない）/.test(derivedText("A")),
      "target_not_visible の自動判定文言が違う: " + derivedText("A"));
    setFocusField("A", "targetVisibility", "indeterminate");
    await delay(30);
    note(derivedOf("A") === "unclear", "indeterminate の判定が違う: " + derivedOf("A"));
    note(/unclear（画像から判断できない）/.test(derivedText("A")),
      "unclear の自動判定文言が違う: " + derivedText("A"));

    // 前後差が要らないケース2では depthSeparation が自動で該当なし
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "case 2");
    await pickImage("A", "focus-c2a1.png", 31);
    note(/前後との鮮明度差は問わない/.test(focusTargetText("A")), "ケース2の前後差不要が出ていない");
    setFocusField("A", "targetVisibility", "visible");
    await delay(30);
    note(getFocusField("A", "depthSeparation") === "not_applicable",
      "前後差不要なのに該当なしが入っていない: " + getFocusField("A", "depthSeparation"));
    note(focusDisabled("A", "depthSeparation") === true, "前後差不要なのに欄が操作可能");
    setFocusField("A", "targetSharpness", "pass");
    await delay(30);
    note(derivedOf("A") === "present", "前後差不要ケースの判定が違う: " + derivedOf("A"));

    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "back to case 1");
    return { pass: problems.length === 0, problems, images: 4, derivedChecks: table.length + 3 };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// シナリオ3: 画像切替・A/B切替・ケース移動をまたいだ保持
// ---------------------------------------------------------------------------
function phaseRetention() {
  return (async () => {
    __PRELUDE__
    const thumbs = (arm) => Array.prototype.slice.call(byId("abThumbs" + arm).querySelectorAll("img"));
    const pick = async (arm, i) => { thumbs(arm)[i].click(); await delay(200); };

    await pick("A", 0);
    reviewSide("A", "accept", "4", "4", "A1のコメント");
    setFocusAll("A", "visible", "pass", "pass");
    await delay(50);
    note(derivedOf("A") === "present", "A1 の判定が present でない");

    await pick("A", 1);
    reviewSide("A", "reject", "2", "2", "A2のコメント");
    setFocusAll("A", "visible", "fail", "pass");
    await delay(50);
    note(derivedOf("A") === "missing", "A2 の判定が missing でない");

    // 画像を戻して A1 の入力が残っている
    await pick("A", 0);
    note(getFocusField("A", "targetVisibility") === "visible"
      && getFocusField("A", "targetSharpness") === "pass"
      && getFocusField("A", "depthSeparation") === "pass",
      "画像を戻すと A1 の合焦入力が消えている");
    note(derivedOf("A") === "present", "画像を戻すと A1 の判定が復元されない");

    // B 側
    await pick("B", 0);
    reviewSide("B", "hold", "3", "3", "B1のコメント");
    setFocusAll("B", "not_visible");
    await delay(50);
    note(derivedOf("B") === "target_not_visible", "B1 の判定が target_not_visible でない: " + derivedOf("B"));
    await pick("B", 1);
    reviewSide("B", "hold", "3", "3", "B2のコメント");
    setFocusAll("B", "indeterminate");
    await delay(50);
    note(derivedOf("B") === "unclear", "B2 の判定が unclear でない");

    // ケース移動して戻す
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "to case 2");
    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "back to case 1");
    await delay(300);
    await pick("A", 0);
    note(getFocusField("A", "targetSharpness") === "pass", "ケース移動で A1 の合焦入力が消えている");
    await pick("B", 1);
    note(getFocusField("B", "targetVisibility") === "indeterminate", "ケース移動で B2 の合焦入力が消えている");
    const drafts = Object.keys(JSON.parse(localStorage.getItem(abKey())).reviewDrafts).length;
    return { pass: problems.length === 0, problems, drafts };
  })();
}

// ---------------------------------------------------------------------------
// シナリオ4: 再読み込み復元 → 保存 → 書き出し → 再取り込み照合
// ---------------------------------------------------------------------------
function phaseReloadSaveExport() {
  return (async () => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after reload");
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1 after reload");
    const thumbs = (arm) => Array.prototype.slice.call(byId("abThumbs" + arm).querySelectorAll("img"));
    const pick = async (arm, i) => { thumbs(arm)[i].click(); await delay(200); };

    // 再読み込み後に4枚すべての入力が残っている
    await pick("A", 0);
    note(getFocusField("A", "targetVisibility") === "visible" && getFocusField("A", "targetSharpness") === "pass"
      && getFocusField("A", "depthSeparation") === "pass" && derivedOf("A") === "present",
      "再読み込みで A1 の合焦入力が消えている");
    await pick("A", 1);
    note(getFocusField("A", "targetSharpness") === "fail" && derivedOf("A") === "missing",
      "再読み込みで A2 の合焦入力が消えている");
    await pick("B", 0);
    note(getFocusField("B", "targetVisibility") === "not_visible" && derivedOf("B") === "target_not_visible",
      "再読み込みで B1 の not_visible が消えている: " + getFocusField("B", "targetVisibility") + "/" + derivedOf("B"));
    await pick("B", 1);
    note(getFocusField("B", "targetVisibility") === "indeterminate" && derivedOf("B") === "unclear",
      "再読み込みで B2 の合焦入力が消えている");

    setVal("abPreference", "A");
    setVal("abCompareNotes", "合成の比較コメント");
    await saveCase("focus case 1", 4);

    // [R5B] ケース2には合焦入力だけ入れた画像が1枚ある(判定も点数も空)。
    //  未評価の画像が1枚でも登録されている間は、書き出し自体を断る。
    //  以前はここで「下書きは空欄のまま書き出される」ことを確かめていたが、
    //  空欄のまま提出物へ出る経路そのものを塞ぐ方が契約(UI品質契約 §9)に沿う。
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await delay(400);
    note(/未評価の画像が 1 枚あります/.test(st()),
      "未評価の画像があるのに書き出しが通った: " + st());
    note(/すべて評価するまで書き出せません/.test(st()), "書き出せない理由が出ていない: " + st());

    // その画像を外すと、残るのは保存済みのケース1だけになる。
    byId("abNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "case 2 to clean up");
    await delay(250);
    window.confirm = () => true;
    byId("abStatus").textContent = "";
    byId("abRemoveA").click();
    await waitS(/画像を外しました/, "case 2 image removed");
    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "back to case 1");
    await delay(250);

    const rows = await exportRows("abExportReviews");
    const flat = [];
    rows.forEach((r) => r.images.forEach((im) => flat.push({ row: r, im })));
    const case1 = flat.filter((x) => x.row.experiment.sourceNo === 1);
    const case2 = flat.filter((x) => x.row.experiment.sourceNo === 2);
    note(case1.length === 4, "ケース1の書き出し画像数が4でない: " + case1.length);
    note(case1.every((x) => x.im.evaluation.focusAssessment),
      "保存済みケース1に focusAssessment の無い画像がある");
    note(case2.length === 0, "外したはずのケース2の画像が書き出しに残っている: " + case2.length);
    const withFocus = case1;
    note(withFocus.length === 4, "focusAssessment を持つ評価が4でない: " + withFocus.length);
    const derivedSeen = {};
    withFocus.forEach((x) => {
      const fa = x.im.evaluation.focusAssessment;
      derivedSeen[fa.derivedFocusStatus] = (derivedSeen[fa.derivedFocusStatus] || 0) + 1;
      note(fa.targetLabel === "合成の合焦対象イ", "targetLabel が違う: " + fa.targetLabel);
      note(fa.separationRequired === true, "separationRequired が true でない");
      note(["present", "missing", "unclear", "target_not_visible"].indexOf(fa.derivedFocusStatus) >= 0,
        "derivedFocusStatus が想定外: " + fa.derivedFocusStatus);
      const keys = Object.keys(fa).sort().join(",");
      note(keys === "depthSeparation,derivedFocusStatus,separationRequired,targetLabel,targetSharpness,targetVisibility",
        "focusAssessment のキーが違う: " + keys);
    });
    note(derivedSeen.present === 1 && derivedSeen.missing === 1 && derivedSeen.unclear === 1
      && derivedSeen.target_not_visible === 1,
      "書き出しの判定内訳が違う（4状態すべてが1件ずつ出るはず）: " + JSON.stringify(derivedSeen));
    // R4B: not_visible と indeterminate が書き出しでも別物として残る
    const nv = withFocus.map((x) => x.im.evaluation.focusAssessment)
      .filter((fa) => fa.derivedFocusStatus === "target_not_visible");
    const ind = withFocus.map((x) => x.im.evaluation.focusAssessment)
      .filter((fa) => fa.derivedFocusStatus === "unclear");
    note(nv.length === 1 && nv[0].targetVisibility === "not_visible",
      "target_not_visible の書き出しが not_visible を保持していない: " + JSON.stringify(nv));
    note(ind.length === 1 && ind[0].targetVisibility === "indeterminate",
      "unclear の書き出しが indeterminate を保持していない: " + JSON.stringify(ind));
    note(nv[0].targetVisibility !== ind[0].targetVisibility,
      "not_visible と indeterminate が書き出しで同一値になっている");

    // 書き出し → 取り込みの往復。アプリ自身の正規化で「変わっていない」と判定できること。
    const roundTrip = case1.map((x) => JSON.stringify(x.im.evaluation.focusAssessment));
    const again = await exportRows("abExportReviews");
    const flat2 = [];
    again.forEach((r) => r.images.forEach((im) => { if (r.experiment.sourceNo === 1) flat2.push(im); }));
    const roundTrip2 = flat2.map((im) => JSON.stringify(im.evaluation.focusAssessment));
    note(JSON.stringify(roundTrip) === JSON.stringify(roundTrip2),
      "同じ状態を2回書き出して値が違う(往復で壊れている)");

    return { pass: problems.length === 0, problems, exported: case1.length, totalRows: flat.length,
      derived: derivedSeen, reviewId: rows[0].reviewId,
      sample: JSON.parse(roundTrip[0]) };
  })();
}

// ---------------------------------------------------------------------------
// シナリオ5: 意味の壊れた合焦パッケージを拒否する
// ---------------------------------------------------------------------------
function phaseRejectInvalid(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => { problems.push("rejected package must not open a confirm dialog"); return false; };
    const before = JSON.stringify(JSON.parse(localStorage.getItem(abKey())).reviews.length);
    let count = 0;
    for (const item of a.invalid) {
      const verdict = await loadAndExpectRejected(item.pkg, "invalid.json", item.label);
      note(/使えません/.test(verdict), item.label + " が拒否されていない: " + verdict);
      note(verdict.indexOf(item.field) >= 0, item.label + " の理由に項目名が出ていない: " + verdict);
      count += 1;
    }
    const after = JSON.stringify(JSON.parse(localStorage.getItem(abKey())).reviews.length);
    note(before === after, "拒否したのに記録が変わっている");
    return { pass: problems.length === 0, problems, count };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// シナリオ6: 画面幅ごとの横溢れ・A/B整列・折返し・タップ領域
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

    const rows = focusRows("A");
    note(rows.length === 3, label + " で合焦の行が3つでない: " + rows.length);
    rows.forEach((r, i) => {
      const lab = r.querySelector(".ab-focus-label");
      note(lab.scrollWidth <= lab.clientWidth + 1,
        label + " の合焦項目" + (i + 1) + " が折り返されず横へはみ出している: " + lab.scrollWidth + " > " + lab.clientWidth);
      const sel = r.querySelector("select").getBoundingClientRect();
      note(sel.height >= 44, label + " の合焦項目" + (i + 1) + " の選択欄が44px未満: " + Math.round(sel.height));
      note(parseFloat(getComputedStyle(r.querySelector("select")).fontSize) >= 16,
        label + " の合焦項目" + (i + 1) + " がiOSズームを招く文字サイズ");
    });
    const tgt = byId("abRevA_focusTarget");
    note(tgt.scrollWidth <= tgt.clientWidth + 1,
      label + " で合焦対象名が折り返されず横へはみ出している: " + tgt.scrollWidth + " > " + tgt.clientWidth);

    if (vw >= 720) {
      const g = (id) => byId(id).getBoundingClientRect();
      const sideA = document.querySelector('[data-ab-side="A"]').getBoundingClientRect();
      const sideB = document.querySelector('[data-ab-side="B"]').getBoundingClientRect();
      note(Math.abs(sideA.top - sideB.top) <= 1, label + " でカード上端がずれている");
      note(Math.abs(g("abCopyA").top - g("abCopyB").top) <= 1, label + " で主要操作の上端がずれている");
      note(Math.abs(g("abBigA").top - g("abBigB").top) <= 1, label + " で画像領域の上端がずれている");
      note(Math.abs(g("abReviewA").top - g("abReviewB").top) <= 1, label + " で評価欄の上端がずれている");
      note(Math.abs(g("abRevA_focusHead").top - g("abRevB_focusHead").top) <= 1,
        label + " で合焦見出しの上端がずれている");
      note(Math.abs(sideA.bottom - sideB.bottom) <= 1, label + " でカード下端がずれている");
    }
    ["abPrev", "abNext", "abSaveNext", "abCopyA", "abCopyB"].forEach((id) => {
      const r = byId(id).getBoundingClientRect();
      note(r.width > 0 && r.height >= 44, label + " の " + id + " が44px未満");
    });
    return { pass: problems.length === 0, problems, label, overflow, vw, rows: rows.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const legacyPkg = buildLegacyPackage();
  const focusPkg = buildFocusPackage();

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a-focus-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4a-focus-dl-"));
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

    const FULL_PRELUDE = PRELUDE + FOCUS_HELPERS;
    const run = async (fn, label, arg, timeout = 180000) => {
      process.stderr.write("  [phase] " + label + " ...\n");
      let source = fn.toString().replace("__PRELUDE__", FULL_PRELUDE);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      const evaluated = await client.send("Runtime.evaluate", {
        expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout,
      }, sessionId);
      process.stderr.write("  [phase] " + label + " done\n");
      if (evaluated.exceptionDetails) fail(`${label} threw`, evaluated.exceptionDetails);
      const value = evaluated.result && evaluated.result.value;
      if (!value || !value.pass) fail(`${label} failed`, value);
      return value;
    };

    const legacy = await run(phaseLegacy, "legacy package unchanged", legacyPkg);
    const gate = await run(phaseFocusGate, "focus gating and derivation", focusPkg);
    const retained = await run(phaseRetention, "input retention across switches");

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    const exported = await run(phaseReloadSaveExport, "reload restore, save, export, round trip");

    // 保存後は次のケースへ進む。レイアウトは A/B 両方に画像がある状態で見る必要があるため、
    // 2枚ずつ揃っているケース1へ戻してから測る。
    await run(function backToCase1() {
      return (async () => {
        __PRELUDE__
        byId("abPrev").click();
        await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "case 1");
        await waitFor(() => byId("abBigA").hidden === false && byId("abBigB").hidden === false, "both previews");
        return { pass: problems.length === 0, problems };
      })();
    }, "back to case 1 for layout");

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
      layoutResults.push(await run(phaseLayout, "layout / " + spec.label, spec));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(500);

    const rejected = await run(phaseRejectInvalid, "invalid focus packages refused",
      { invalid: buildInvalidFocusPackages(focusPkg) });

    console.log("R4B FOCUS ASSESSMENT BROWSER ACCEPTANCE PASSED");
    console.log(`  legacy package unchanged: no focus heading, evaluation still has ${legacy.legacyKeys} keys, no focusAssessment`);
    console.log(`  focus package gated: 3 controls per image, ${gate.derivedChecks} derivation cases all correct`);
    console.log(`  contradictions blocked: not_visible/indeterminate force not_applicable and disable later fields`);
    console.log(`  separation auto not_applicable when the rubric does not require it`);
    console.log(`  inputs survived image switch, A/B switch and case moves (${retained.drafts} per-image drafts)`);
    console.log(`  reload restored all 4 images; save wrote focusAssessment on ${exported.exported} reviews`);
    console.log(`  export derived breakdown: ${JSON.stringify(exported.derived)}`);
    console.log(`  export/import round trip byte-stable; sample: ${JSON.stringify(exported.sample)}`);
    console.log(`  layout (${layoutResults.length} passes): ${layoutResults.map((r) => `${r.vw}px overflow ${r.overflow}px`).join(" | ")}`);
    console.log(`  ${rejected.count} semantically invalid focus packages refused, records untouched`);
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
