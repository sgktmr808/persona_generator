#!/usr/bin/env node
// [R3-FG] 追加レビュー計画(第2ラウンド)の**実ブラウザ**受入検査。
//
//  守らせたい約束:
//   - 計画JSON(初回解析の結果)を読み込むと、指定されたケースだけ画像を足せる
//     ラウンドへ切り替わる。実験IDと実験定義SHA-256が違う計画は受け取らない。
//   - 計画に載った初回の画像は外せず、評価も書き換えられない。
//   - 対象外のケースは凍結する(追加・削除・保存のいずれもできない)。
//   - 対象ケースは A/B 各2枚まで、順位は初回の続き(3・4)にしかならない。
//   - 「次の追加対象へ」は対象ケースの中だけを回る。
//   - 対象がすべて揃うまで書き出せない。揃えば初回分と追加分の両方が出る。
//   - 再読み込みしても計画と進み具合が残る。
//   - 計画を読み込まなければ、従来の初回レビューと1つも挙動が変わらない。
//
//  合成フィクスチャだけを使う。実験の実データ・本文・パッケージ・解析結果は扱わない。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CASE_COUNT = 8;          // 実運用と同じ形（8ケース×A/B各2枚＝32枚）
const TARGETS = [2, 3, 5, 6];  // 追加対象（4ケース）

// 案内付き初回フローを持つパッケージでも、追加計画が有効になった後は初回案内が
// 対象ケースを上書きしてはならない。この境界が消えると実運用では追加対象外へ戻る。
const INDEX_SOURCE = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
if (!/function guidedEnabled\(\) \{ return !!guidedContract\(\) && !planActive\(\); \}/.test(INDEX_SOURCE)) {
  throw new Error(
    "追加レビュー計画が有効な間も初回の案内付き生成が動く状態です。" +
    "追加対象以外へ戻るため受け入れられません。"
  );
}

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
function buildPackage() {
  const cases = [];
  for (let n = 1; n <= CASE_COUNT; n += 1) {
    const a = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 末尾`;
    const b = "【合成の追加ブロック】\n" + a;
    const settings = { schema: "t9_gen_settings.v1", salt: "plan-" + n };
    cases.push({
      sourceNo: n, baselineGenerationId: "gen-plan-p" + n, role: "合成", species: "", reason: "合成",
      batchId: "plan-batch", no: n, settings, settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      priorityItems: [1, 2].map((i) => ({
        itemId: "P" + i, label: `合成の重要要素 ${n}-${i}`, clauseSha256: sha(`合成の重要要素 ${n}-${i}`)
      })),
      arms: {
        A: { generationId: `plan-p${n}-A`, role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false, diffSummary: "この面の本文を使ってください。" },
        B: { generationId: `plan-p${n}-B`, role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, diffSummary: "この面の本文を使ってください。" }
      }
    });
  }
  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-11T00:00:00.000Z", generatedBy: "fixture-resample-plan",
    experiment: {
      experimentId: "fixture-resample-plan", hypothesis: "合成", insertionPoint: "合成",
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
    exportTargets: { reviewSchemaVersion: "persona-prompt-review.v2", experimentSchemaVersion: "persona-fixture-plan-ab.v1" },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

// 解析器と同じ正規化。ここがずれると「変わっていないのに拒否」になる。
//  可変値(comparisonId・時刻・supersedes)は入れない。
function normalizedEvaluation(image) {
  const e = (image && image.evaluation) || {};
  return {
    verdict: String(e.verdict === undefined || e.verdict === null ? "" : e.verdict),
    aestheticSatisfaction: String(e.aestheticSatisfaction === undefined || e.aestheticSatisfaction === null
      ? "" : e.aestheticSatisfaction),
    intentMatch: String(e.intentMatch === undefined || e.intentMatch === null ? "" : e.intentMatch),
    failures: (e.failures || []).map(String).slice().sort(),
    priorityChecks: (e.priorityChecks || [])
      .map((p) => ({ itemId: String(p.itemId), status: String(p.status) }))
      .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)),
    missingPriorityCount: e.missingPriorityCount === undefined ? null : e.missingPriorityCount,
    notes: String(image && image.notes !== undefined && image.notes !== null ? image.notes : "")
  };
}
function evaluationSha(image) { return sha(JSON.stringify(normalizedEvaluation(image))); }
function normalizedComparison(c) {
  return {
    sourceNo: c.sourceNo,
    armGenerationIds: { A: (c.armGenerationIds || {}).A || "", B: (c.armGenerationIds || {}).B || "" },
    promptSha256: { A: (c.promptSha256 || {}).A || "", B: (c.promptSha256 || {}).B || "" },
    comparedImageIds: { A: (c.comparedImageIds || {}).A || "", B: (c.comparedImageIds || {}).B || "" },
    preference: String(c.preference === undefined || c.preference === null ? "" : c.preference),
    notes: String(c.notes === undefined || c.notes === null ? "" : c.notes)
  };
}
function comparisonSha(c) { return sha(JSON.stringify(normalizedComparison(c))); }

// OP-E1 解析器 v1 が初回提出を封印する正規化。汎用計画より対象項目が狭く、
// UI は report.schemaVersion を見てこの形式と完全一致させる必要がある。
function opticalEvaluationSha(image) {
  const e = (image && image.evaluation) || {};
  return sha(JSON.stringify({
    verdict: String(e.verdict || ""),
    aestheticSatisfaction: String(e.aestheticSatisfaction || ""),
    intentMatch: String(e.intentMatch || ""),
    failures: (e.failures || []).map(String).slice().sort(),
    focusAssessment: e.focusAssessment || null,
    notes: String(image && image.notes ? image.notes : "")
  }));
}
function opticalComparisonSha(c) {
  return sha(JSON.stringify({ preference: c.preference || "", notes: c.notes || "" }));
}

// 初回書き出し(レビューJSONL・比較JSONL)から、解析ツールが出すのと同じ形の計画JSONを組む。
function buildPlanReport(pkg, reviewRows, comparisonRows, targets) {
  return {
    schemaVersion: "fixture-analysis.v1",
    stage: "initial",
    experimentId: pkg.experiment.experimentId,
    packageDefinitionSha256: pkg.definitionSha256,
    problems: [],
    verdict: "resample_required",
    resample: {
      stage: "initial", threshold: -1, required: true, exhausted: false,
      cases: targets.map((n) => ({ caseId: "FX-" + String(n).padStart(2, "0"), sourceNo: n, deltaAesthetic: -1.5 }))
    },
    snapshot: {
      stage: "initial",
      files: { reviews: { name: "fixture-reviews.jsonl", sha256: sha("fixture") } },
      reviewRows: reviewRows.map((r) => ({
        sourceNo: r.experiment.sourceNo,
        slot: r.experiment.arm,
        reviewId: r.reviewId,
        generationId: r.generationId,
        images: r.images.map((im) => ({
          imageId: im.imageId, rank: im.rank,
          sha256: im.metadata.sha256,
          evaluationSha256: evaluationSha(im)
        }))
      })),
      comparisons: comparisonRows.map((c) => ({
        sourceNo: c.sourceNo, comparisonId: c.comparisonId, sha256: comparisonSha(c)
      }))
    }
  };
}

function buildOpticalPlanReport(pkg, reviewRows, comparisonRows, targets) {
  const report = buildPlanReport(pkg, reviewRows, comparisonRows, targets);
  report.schemaVersion = "optical-target-materialization.submission-analysis.v1";
  report.snapshot.reviewRows.forEach((row) => {
    const source = reviewRows.find((r) => r.experiment.sourceNo === row.sourceNo
      && r.experiment.arm === row.slot);
    row.images.forEach((im) => {
      const image = source.images.find((x) => x.imageId === im.imageId);
      im.evaluationSha256 = opticalEvaluationSha(image);
    });
  });
  report.snapshot.comparisons.forEach((row) => {
    const source = comparisonRows.find((c) => c.sourceNo === row.sourceNo);
    row.sha256 = opticalComparisonSha(source);
  });
  return report;
}

// 「初回の記録が1項目だけ変わっていた」状態を、計画側のハッシュで作る。
//  画面の記録は正しいまま、スナップショットが別の値を指す = 変化の検出そのもの。
function planWithEvaluationChange(plan, reviewRows, mutate) {
  const next = JSON.parse(JSON.stringify(plan));
  const row = reviewRows[0];
  const image = JSON.parse(JSON.stringify(row.images[0]));
  mutate(image);
  const target = next.snapshot.reviewRows.find(
    (r) => r.sourceNo === row.experiment.sourceNo && r.slot === row.experiment.arm);
  target.images.find((im) => im.imageId === image.imageId).evaluationSha256 = evaluationSha(image);
  return next;
}
function planWithComparisonChange(plan, comparisonRows, mutate) {
  const next = JSON.parse(JSON.stringify(plan));
  const row = JSON.parse(JSON.stringify(comparisonRows[0]));
  mutate(row);
  next.snapshot.comparisons.find((c) => c.sourceNo === row.sourceNo).sha256 = comparisonSha(row);
  return next;
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 40000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(80); }
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
    ctx.fillStyle = "rgb(" + (seed % 251) + "," + ((seed * 7) % 251) + "," + ((seed * 13) % 251) + ")";
    ctx.fillRect(0, 0, 40, 30);
    ctx.fillStyle = "#000";
    ctx.fillText(String(seed), 2, 12);
    cv.toBlob(resolve, "image/png");
  });
  const pickImage = async (arm, name, seed) => {
    byId("abStatus").textContent = "";
    const dt = new DataTransfer();
    dt.items.add(new File([await makePng(seed)], name, { type: "image/png" }));
    const n = byId("abFile" + arm);
    if (n.disabled) { n.disabled = false; }
    n.files = dt.files;
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitS(/画像を .* 枚置きました|登録できませんでした|追加対象ではありません/, "pick " + arm + " " + name);
    return st();
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
  const caseNo = () => {
    const m = /ケース (\\d+) \\//.exec(byId("abCaseCounter").textContent);
    return m ? Number(m[1]) : null;
  };
  const goToCaseNo = async (want) => {
    for (let i = 0; i < 40; i += 1) {
      const now = caseNo();
      if (now === want) { await delay(180); return true; }
      byId(now < want ? "abNext" : "abPrev").click();
      await delay(180);
    }
    throw new Error("could not reach case " + want);
  };
  const grabExport = async (id) => {
    const orig = URL.createObjectURL;
    let cap = null;
    URL.createObjectURL = function (b) { cap = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId(id).click();
    await waitS(/書き出しました|揃っていません|書き出す記録/, "export " + id);
    const message = st();
    const text = cap ? await cap.text() : "";
    URL.createObjectURL = orig;
    return { text, message };
  };
`;

// ---------------------------------------------------------------------------
// 第1ラウンド: 8ケース × A/B 各2枚 = 32枚を評価して保存し、レビューJSONLを書き出す
// ---------------------------------------------------------------------------
function phaseRound1(pkg) {
  return (async (p) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(p, null, 2) + "\n"], "plan-fixture.json", { type: "application/json" }));
    const inp = byId("abFileInput"); inp.files = dt.files;
    inp.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "loaded");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    // 計画を読み込むまでは、追加ラウンドの表示は一切出ない。
    note(byId("abResampleBanner").hidden === true, "計画が無いのに追加ラウンドの帯が出ている");
    note(byId("abNextTarget").hidden === true, "計画が無いのに「次の追加対象へ」が出ている");
    note(!!byId("abLoadResamplePlan"), "「追加レビュー計画を読み込む」ボタンが無い");
    note(byId("abLoadResamplePlan").textContent.indexOf("追加レビュー計画を読み込む") >= 0,
      "ボタンの文言が違う: " + byId("abLoadResamplePlan").textContent);

    for (let n = 1; n <= p.cases.length; n += 1) {
      await goToCaseNo(n);
      await pickImage("A", "r1-p" + n + "-a1.png", n * 100 + 1);
      await pickImage("A", "r1-p" + n + "-a2.png", n * 100 + 2);
      await pickImage("B", "r1-p" + n + "-b1.png", n * 100 + 3);
      await pickImage("B", "r1-p" + n + "-b2.png", n * 100 + 4);
      note(JSON.stringify(liveRanks(n, "A")) === "[1,2]", "p" + n + " A の初回 rank が 1,2 でない");
      evalImage("A", 0, "hold", 3, 3, "初回p" + n + "A1");
      evalImage("A", 1, "accept", 4, 4, "初回p" + n + "A2");
      evalImage("B", 0, "accept", 4, 4, "初回p" + n + "B1");
      evalImage("B", 1, "hold", 3, 3, "初回p" + n + "B2");
      await delay(160);
      byId("abThumbsA").querySelectorAll("img")[0].click();
      byId("abThumbsB").querySelectorAll("img")[0].click();
      setVal("abPreference", n % 2 ? "A" : "B");
      setVal("abCompareNotes", "初回の比較 p" + n);
      await waitFor(() => !byId("abSaveNext").disabled, "save enabled p" + n);
      byId("abSaveNext").click();
      await delay(320);
    }

    const ex = await grabExport("abExportReviews");
    const rows = ex.text.trim().split("\n").map((l) => JSON.parse(l));
    out_rows = rows;
    note(rows.length === p.cases.length * 2, "初回のレビュー行が " + rows.length + " 行");
    const total = rows.reduce((a, r) => a + r.images.length, 0);
    note(total === p.cases.length * 4, "初回の画像が " + total + " 枚");
    const cex = await grabExport("abExportComparisons");
    const cmp = cex.text.trim().split("\n").filter((l) => l).map((l) => JSON.parse(l));
    out_cmp = cmp;
    note(cmp.length === p.cases.length, "初回の比較行が " + cmp.length + " 行");
    return { pass: problems.length === 0, problems, rows: out_rows, cmp: out_cmp,
      reviewRows: rows.length, images: total, comparisons: cmp.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 計画の受け取り検証: 実験IDや定義SHA-256が違う計画を突き返す
// ---------------------------------------------------------------------------
function phaseReject(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    const load = async (obj, label) => {
      byId("abStatus").textContent = "";
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(obj)], "plan.json", { type: "application/json" }));
      const n = byId("abResamplePlanInput");
      n.files = dt.files;
      n.dispatchEvent(new Event("change", { bubbles: true }));
      await waitS(/追加レビュー計画/, label);
      return st();
    };
    const refused = [];
    const mustRefuse = async (obj, label, re) => {
      const m = await load(obj, label);
      note(/使えません/.test(m), label + " を受け取ってしまった: " + m);
      note(re.test(m), label + " の理由が違う: " + m);
      note(store().resamplePlan == null, label + " が保存された");
      refused.push(label);
    };
    const clone = () => JSON.parse(JSON.stringify(a.plan));

    // --- 計画そのものの形 ---
    let p1 = clone(); p1.experimentId = "another-experiment";
    await mustRefuse(p1, "実験ID違い", /実験IDが違います/);
    p1 = clone(); p1.packageDefinitionSha256 = "0".repeat(64);
    await mustRefuse(p1, "実験定義SHA違い", /実験定義のSHA-256が一致しません/);
    p1 = clone(); delete p1.stage;
    await mustRefuse(p1, "stage欠落", /初回解析の結果ではありません/);
    p1 = clone(); p1.stage = "resampled-final";
    await mustRefuse(p1, "stage違い", /初回解析の結果ではありません/);
    p1 = clone(); p1.verdict = "final";
    await mustRefuse(p1, "verdict違い", /追加が必要だという判定ではありません/);
    p1 = clone(); delete p1.verdict;
    await mustRefuse(p1, "verdict欠落", /追加が必要だという判定ではありません/);
    p1 = clone(); delete p1.problems;
    await mustRefuse(p1, "problems欠落", /指摘の一覧（problems）がありません/);
    p1 = clone(); p1.problems = "なし";
    await mustRefuse(p1, "problems非配列", /指摘の一覧（problems）がありません/);
    p1 = clone(); p1.problems = ["合成の指摘"];
    await mustRefuse(p1, "problems非空", /未解決の指摘/);
    p1 = clone(); delete p1.resample.stage;
    await mustRefuse(p1, "resample.stage欠落", /初回のものではありません/);
    p1 = clone(); p1.resample.required = false;
    await mustRefuse(p1, "resample.required=false", /追加が必要な計画ではありません/);
    p1 = clone(); delete p1.resample.required;
    await mustRefuse(p1, "resample.required欠落", /追加が必要な計画ではありません/);
    p1 = clone(); p1.resample.exhausted = true;
    await mustRefuse(p1, "resample.exhausted=true", /使い切られています/);
    p1 = clone(); delete p1.resample.exhausted;
    await mustRefuse(p1, "resample.exhausted欠落", /使い切られています/);
    p1 = clone(); p1.resample.cases.push({ caseId: "FX-99", sourceNo: 99, deltaAesthetic: -2 });
    await mustRefuse(p1, "存在しないケース", /このパッケージにありません/);
    p1 = clone(); delete p1.snapshot.comparisons;
    await mustRefuse(p1, "snapshot.comparisons欠落", /スナップショット（reviewRows \/ comparisons）がありません/);

    // --- 初回の画像 ---
    p1 = clone(); p1.snapshot.reviewRows[0].images[0].sha256 = "1".repeat(64);
    await mustRefuse(p1, "初回画像の差し替え", /画像が差し替えられています/);
    p1 = clone(); delete p1.snapshot.reviewRows[0].images[0].sha256;
    await mustRefuse(p1, "画像SHA欠落", /画像のSHA-256がありません/);
    p1 = clone(); p1.snapshot.reviewRows[0].images[0].imageId = "another-image";
    await mustRefuse(p1, "imageId違い", /画像が差し替えられています/);
    p1 = clone(); p1.snapshot.reviewRows[0].images[0].rank = 9;
    await mustRefuse(p1, "rank違い", /順位 9 の画像がありません/);
    p1 = clone(); delete p1.snapshot.reviewRows[0].images[0].evaluationSha256;
    await mustRefuse(p1, "評価SHA欠落", /評価のSHA-256がありません/);
    p1 = clone(); p1.snapshot.reviewRows[0].images[0].evaluationSha256 = "2".repeat(64);
    await mustRefuse(p1, "評価SHA不一致", /初回の評価が変わっています/);

    // --- 初回の評価（項目ごとに1つずつ変える。正規化に入っていない項目は素通りする） ---
    p1 = a.evalChanges.verdict;
    await mustRefuse(p1, "初回評価の判定", /初回の評価が変わっています/);
    await mustRefuse(a.evalChanges.aesthetic, "初回評価の美的満足度", /初回の評価が変わっています/);
    await mustRefuse(a.evalChanges.intent, "初回評価の意図一致", /初回の評価が変わっています/);
    await mustRefuse(a.evalChanges.failures, "初回評価の失敗ラベル", /初回の評価が変わっています/);
    await mustRefuse(a.evalChanges.priority, "初回評価の重要要素", /初回の評価が変わっています/);
    await mustRefuse(a.evalChanges.missingCount, "初回評価の未反映数", /初回の評価が変わっています/);
    await mustRefuse(a.evalChanges.notes, "初回評価のコメント", /初回の評価が変わっています/);

    // --- 初回の比較 ---
    await mustRefuse(a.cmpChanges.compared, "初回比較の選択画像", /初回の比較.*が変わっています/);
    await mustRefuse(a.cmpChanges.preference, "初回比較のどちらが良いか", /初回の比較.*が変わっています/);
    await mustRefuse(a.cmpChanges.notes, "初回比較のコメント", /初回の比較.*が変わっています/);
    p1 = clone(); delete p1.snapshot.comparisons[0].sha256;
    await mustRefuse(p1, "比較SHA欠落", /比較のSHA-256がありません/);
    p1 = clone(); p1.snapshot.comparisons.splice(0, 1);
    await mustRefuse(p1, "比較行の欠落", /の比較がありません/);
    p1 = clone(); p1.snapshot.comparisons.push(JSON.parse(JSON.stringify(p1.snapshot.comparisons[0])));
    await mustRefuse(p1, "比較行の重複", /比較が重複しています/);
    p1 = clone(); p1.snapshot.comparisons[0].sourceNo = 99;
    await mustRefuse(p1, "比較の未知ケース", /比較に未知のケース/);

    // --- レビュー行そのもの ---
    p1 = clone(); p1.snapshot.reviewRows[0].reviewId = "changed-review-id";
    await mustRefuse(p1, "reviewId違い", /レビューIDが変わっています/);
    p1 = clone(); p1.snapshot.reviewRows[0].generationId = "changed-generation-id";
    await mustRefuse(p1, "generationId違い", /生成IDが変わっています/);
    p1 = clone(); p1.snapshot.reviewRows.splice(0, 1);
    await mustRefuse(p1, "レビュー行の欠落", /記録がスナップショットにありません/);
    p1 = clone(); p1.snapshot.reviewRows.push(JSON.parse(JSON.stringify(p1.snapshot.reviewRows[0])));
    await mustRefuse(p1, "レビュー行の重複", /行が重複しています/);
    p1 = clone(); p1.snapshot.reviewRows[0].sourceNo = 99;
    await mustRefuse(p1, "未知ケースの行", /未知のケース/);
    p1 = clone(); p1.snapshot.reviewRows[0].slot = "C";
    await mustRefuse(p1, "未知の面", /未知の面/);
    p1 = clone(); p1.snapshot.reviewRows[0].images.splice(0, 1);
    await mustRefuse(p1, "画像の欠落", /枚数が初回と違います/);

    // --- スナップショットに無い画像がすでにある ---
    byId("abStatus").textContent = "";
    await goToCaseNo(1);
    await delay(200);
    await pickImage("A", "extra-before-plan.png", 7777);
    note(liveRanks(1, "A").length === 3, "追加画像を置けなかった: " + liveRanks(1, "A"));
    await mustRefuse(a.plan, "スナップショット外の追加画像", /スナップショットに無い画像がすでにあります/);
    window.confirm = () => true;
    byId("abStatus").textContent = "";
    byId("abRemoveA").click();
    await waitS(/画像を外しました/, "remove extra");
    note(liveRanks(1, "A").length === 2, "追加画像を外せなかった: " + liveRanks(1, "A"));
    out_invalidations = store().invalidations.length;

    // 正しい計画は受け取る
    let msg = await load(a.validPlan || a.plan, "valid plan");
    note(/読み込みました/.test(msg), "正しい計画を受け取れなかった: " + msg);
    note(/SHA-256で照合済み/.test(msg), "照合済みだと分かる表示になっていない: " + msg);
    out_refused = refused;
    const plan = store().resamplePlan;
    note(!!plan, "計画が保存されていない");
    note(plan.cases.length === a.targets.length, "対象ケース数が違う: " + (plan && plan.cases.length));
    note(plan.lockedCount === a.lockedCount, "初回画像の固定数が違う: " + (plan && plan.lockedCount));
    note(byId("abResampleBanner").hidden === false, "追加ラウンドの帯が出ていない");
    note(byId("abNextTarget").hidden === false, "「次の追加対象へ」が出ていない");
    note(a.targets.indexOf(caseNo()) >= 0, "対象ケースへ移動していない: ケース " + caseNo());
    return { pass: problems.length === 0, problems, opened: caseNo(),
      refused: out_refused, invalidations: out_invalidations };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 対象外ケースの凍結
// ---------------------------------------------------------------------------
function phaseFrozen(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await goToCaseNo(a.nonTarget);
    await delay(250);
    note(byId("abResampleBanner").getAttribute("data-ab-target") === "false",
      "対象外なのに対象として表示されている");
    note(/追加対象ではありません/.test(byId("abResampleBanner").textContent),
      "対象外だと分かる表示になっていない: " + byId("abResampleBanner").textContent);
    note(byId("abDropA").getAttribute("aria-disabled") === "true", "対象外でも A のドロップ領域が有効");
    note(byId("abDropB").getAttribute("aria-disabled") === "true", "対象外でも B のドロップ領域が有効");
    note(byId("abFileA").disabled === true, "対象外でも A のファイル入力が有効");
    note(byId("abSaveNext").disabled === true, "対象外でも保存ボタンが押せる");

    const before = liveRanks(a.nonTarget, "A").length;
    const msg = await pickImage("A", "ng-extra.png", 9001);
    note(/追加対象ではありません/.test(msg), "対象外へ画像を足せてしまった: " + msg);
    note(liveRanks(a.nonTarget, "A").length === before, "対象外の画像が増えた");

    // 初回の画像は外せず、評価も触れない
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await delay(200);
    note(byId("abRemoveA").disabled === true, "初回画像の「外す」が押せる");
    note(/初回提出分/.test(byId("abRemoveA").textContent), "初回提出分だと分かる表示になっていない: "
      + byId("abRemoveA").textContent);
    note(byId("abRevA_verdict").disabled === true, "初回画像の判定欄が編集できる");
    note(byId("abRevA_aestheticSatisfaction").disabled === true, "初回画像のスコア欄が編集できる");
    note(byId("abRevA_notes").disabled === true, "初回画像のコメント欄が編集できる");

    // 直接呼んでも拒否される
    byId("abStatus").textContent = "";
    let confirmed = 0;
    window.confirm = () => { confirmed += 1; return true; };
    byId("abRemoveA").disabled = false;
    byId("abRemoveA").click();
    await waitS(/追加ラウンドでは外せません/, "locked removal");
    note(confirmed === 0, "初回画像で確認ダイアログが出た");
    note(store().invalidations.length === a.invalidations, "初回画像が無効化された");

    byId("abStatus").textContent = "";
    byId("abSaveNext").disabled = false;
    byId("abSaveNext").click();
    await waitS(/追加対象ではありません/, "frozen save");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 対象ケース: A/B 各2枚だけ・rank 3,4・途中では書き出せない
// ---------------------------------------------------------------------------
function phaseAdd(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");

    // 途中の書き出しは止まる
    await goToCaseNo(a.targets[0]);
    await delay(200);
    const early = await grabExport("abExportReviews");
    note(/揃っていません/.test(early.message), "追加が終わる前に書き出せてしまった: " + early.message);
    note(early.text === "", "追加が終わる前に中身が出てしまった");

    const visited = [];
    for (let i = 0; i < a.targets.length; i += 1) {
      const n = a.targets[i];
      await goToCaseNo(n);
      await delay(200);
      visited.push(caseNo());
      note(byId("abResampleBanner").getAttribute("data-ab-target") === "true",
        "p" + n + " が対象として表示されていない");

      await pickImage("A", "r2-p" + n + "-a3.png", n * 100 + 21);
      await pickImage("A", "r2-p" + n + "-a4.png", n * 100 + 22);
      await pickImage("B", "r2-p" + n + "-b3.png", n * 100 + 23);
      await pickImage("B", "r2-p" + n + "-b4.png", n * 100 + 24);
      note(JSON.stringify(liveRanks(n, "A")) === "[1,2,3,4]", "p" + n + " A の rank が 1..4 でない: " + liveRanks(n, "A"));
      note(JSON.stringify(liveRanks(n, "B")) === "[1,2,3,4]", "p" + n + " B の rank が 1..4 でない: " + liveRanks(n, "B"));

      // 3枚目の追加は拒否される（A/B 各2枚まで）
      const over = await pickImage("A", "r2-p" + n + "-a5.png", n * 100 + 25);
      note(/登録できませんでした/.test(over), "p" + n + " で3枚目を足せてしまった: " + over);
      note(liveRanks(n, "A").length === 4, "p" + n + " A が4枚を超えた: " + liveRanks(n, "A"));

      // 初回分の評価はそのまま
      byId("abThumbsA").querySelectorAll("img")[0].click();
      await delay(150);
      note(byId("abRevA_notes").value === "初回p" + n + "A1", "p" + n + " の初回評価が変わった: " + byId("abRevA_notes").value);
      note(byId("abRevA_verdict").disabled === true, "p" + n + " の初回評価が編集できる");

      evalImage("A", 2, "hold", 2, 2, "追加p" + n + "A3");
      evalImage("A", 3, "accept", 5, 4, "追加p" + n + "A4");
      evalImage("B", 2, "accept", 4, 5, "追加p" + n + "B3");
      evalImage("B", 3, "hold", 3, 3, "追加p" + n + "B4");
      await delay(160);
      byId("abThumbsA").querySelectorAll("img")[0].click();
      byId("abThumbsB").querySelectorAll("img")[0].click();
      setVal("abPreference", "tie");
      setVal("abCompareNotes", "追加後の比較 p" + n);
      await waitFor(() => !byId("abSaveNext").disabled, "save enabled p" + n);
      byId("abSaveNext").click();
      await delay(400);
    }
    out_visited = visited;
    const plan = store().resamplePlan;
    note(!!plan, "計画が消えた");
    note(/追加画像 16 \/ 16 枚/.test(byId("abProgressSummary").textContent),
      "進捗表示が 16/16 でない: " + byId("abProgressSummary").textContent);
    return { pass: problems.length === 0, problems, visited: out_visited,
      summary: byId("abProgressSummary").textContent };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 「次の追加対象へ」は対象の中だけを回る
// ---------------------------------------------------------------------------
function phaseNavigate(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await goToCaseNo(a.targets[0]);
    await delay(200);
    const seen = [caseNo()];
    for (let i = 0; i < a.targets.length; i += 1) {
      byId("abNextTarget").click();
      await delay(260);
      seen.push(caseNo());
    }
    out_seen = seen;
    seen.forEach((n) => note(a.targets.indexOf(n) >= 0, "対象外のケース " + n + " へ移動した"));
    note(new Set(seen).size === a.targets.length, "対象を一巡していない: " + seen.join(","));
    note(seen[seen.length - 1] === seen[0], "一巡して戻ってこない: " + seen.join(","));
    return { pass: problems.length === 0, problems, seen: out_seen };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 最終書き出し: 48画像 / 16レビュー行 / 8比較行 / 48コピー行
// ---------------------------------------------------------------------------
function phaseFinalExport(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    const rev = await grabExport("abExportReviews");
    note(/書き出しました/.test(rev.message), "最終のレビューJSONLを書き出せない: " + rev.message);
    const rows = rev.text.trim().split("\n").map((l) => JSON.parse(l));
    note(rows.length === 16, "レビュー行が 16 行でない: " + rows.length);
    const images = rows.reduce((acc, r) => acc.concat(r.images.map((im) => ({
      sourceNo: r.experiment.sourceNo, arm: r.experiment.arm, imageId: im.imageId, rank: im.rank,
      sha: im.metadata.sha256, verdict: im.evaluation.verdict,
      aes: im.evaluation.aestheticSatisfaction, intent: im.evaluation.intentMatch, notes: im.notes
    }))), []);
    note(images.length === 48, "最終の画像が 48 枚でない: " + images.length);

    // 初回32枚が1件も変わっていない
    let changed = 0;
    a.initial.forEach((was) => {
      const now = images.find((x) => x.imageId === was.imageId);
      if (!now) { problems.push("初回画像が消えた: " + was.notes); return; }
      if (now.sha !== was.sha || now.rank !== was.rank || now.verdict !== was.verdict
        || now.aes !== was.aes || now.intent !== was.intent || now.notes !== was.notes) {
        changed += 1;
        problems.push("初回の記録が変わった: " + was.notes);
      }
    });
    note(changed === 0, "初回の記録が " + changed + " 件変わった");

    // 対象ケースは各面4枚、対象外は各面2枚
    a.targets.forEach((n) => {
      ["A", "B"].forEach((arm) => {
        const ranks = images.filter((x) => x.sourceNo === n && x.arm === arm).map((x) => x.rank).sort();
        note(JSON.stringify(ranks) === "[1,2,3,4]", "p" + n + arm + " の rank が 1..4 でない: " + ranks);
      });
    });
    a.nonTargets.forEach((n) => {
      ["A", "B"].forEach((arm) => {
        const ranks = images.filter((x) => x.sourceNo === n && x.arm === arm).map((x) => x.rank).sort();
        note(JSON.stringify(ranks) === "[1,2]", "対象外 p" + n + arm + " の枚数が増えた: " + ranks);
      });
    });

    const cmp = await grabExport("abExportComparisons");
    const cmpRows = cmp.text.trim().split("\n").filter((l) => l).map((l) => JSON.parse(l));
    note(cmpRows.length === 8, "比較行が 8 行でない: " + cmpRows.length);

    const tsv = await grabExport("abExportCopyList");
    const lines = tsv.text.trim().split("\n");
    note(lines.length === 1 + 48, "コピーリストが 48 行でない: " + (lines.length - 1));
    const targets = lines.slice(1).map((l) => l.split("\t")[5]);
    note(new Set(targets).size === targets.length, "コピーリストの targetPath が重複している");
    return { pass: problems.length === 0, problems,
      reviewRows: rows.length, images: images.length, comparisons: cmpRows.length, copyRows: lines.length - 1 };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 再読み込みで計画と進み具合が残る
// ---------------------------------------------------------------------------
function phaseReload(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await delay(500);
    const plan = store().resamplePlan;
    note(!!plan, "再読み込みで計画が消えた");
    note(plan && plan.cases.length === a.targets.length, "再読み込みで対象数が変わった");
    note(byId("abResampleBanner").hidden === false, "再読み込みで帯が消えた");
    note(/追加画像 16 \/ 16 枚/.test(byId("abProgressSummary").textContent),
      "再読み込みで進捗が失われた: " + byId("abProgressSummary").textContent);
    note(a.targets.indexOf(caseNo()) >= 0, "再読み込み後に対象ケースを開いていない: " + caseNo());
    await goToCaseNo(a.targets[0]);
    await delay(250);
    note(JSON.stringify(liveRanks(a.targets[0], "A")) === "[1,2,3,4]", "再読み込みで rank が変わった");
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await delay(250);
    note(byId("abRemoveA").disabled === true, "再読み込み後に初回画像が外せる");
    note(byId("abRevA_verdict").disabled === true, "再読み込み後に初回評価が編集できる");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 計画をやめると通常のレビューへ戻る（初回機能を壊していない）
// ---------------------------------------------------------------------------
function phaseDropPlan(arg) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    window.confirm = () => true;
    byId("abDropResamplePlan").click();
    await waitS(/やめました/, "drop plan");
    note(store().resamplePlan == null, "計画が残っている");
    note(byId("abResampleBanner").hidden === true, "帯が残っている");
    note(byId("abNextTarget").hidden === true, "「次の追加対象へ」が残っている");
    await goToCaseNo(a.nonTarget);
    await delay(250);
    note(byId("abFileA").disabled === false, "計画をやめても画像を足せない");
    note(byId("abDropA").getAttribute("aria-disabled") === "false", "計画をやめてもドロップ領域が無効のまま");
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await delay(200);
    note(byId("abRevA_verdict").disabled === false, "計画をやめても評価欄が編集できない");
    // 書き出し済みの保護（従来からの約束）は残っている
    note(byId("abRemoveA").disabled === true, "書き出し済みの保護まで外れている");
    note(/書き出し済み/.test(byId("abRemoveA").textContent), "書き出し済みの表示になっていない: "
      + byId("abRemoveA").textContent);
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
    const banner = byId("abResampleBanner");
    note(banner.hidden === false, a.label + " で帯が消えている");
    note(banner.scrollWidth <= banner.clientWidth + 1, a.label + " で帯が横に溢れている");
    const nav = ["abPrev", "abJumpIncomplete", "abNextTarget", "abNext"];
    nav.forEach((id) => {
      const n = byId(id);
      const r = n.getBoundingClientRect();
      note(r.width > 0 && r.height >= 44, a.label + " の " + id + " が44px未満: " + Math.round(r.height));
      note(n.scrollWidth <= n.clientWidth + 1, a.label + " で " + id + " の文言が溢れている");
    });
    const rows = nav.map((id) => Math.round(byId(id).getBoundingClientRect().top));
    const sameRow = rows.filter((t) => t === rows[0]).length;
    note(sameRow >= 2, a.label + " でナビゲーションが1つずつ縦積みになっている");
    return { pass: problems.length === 0, problems, label: a.label, vw: de.clientWidth, overflow,
      navRows: new Set(rows).size };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const pkg = buildPackage();
  const nonTargets = [];
  for (let n = 1; n <= CASE_COUNT; n += 1) if (TARGETS.indexOf(n) < 0) nonTargets.push(n);

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fg-"));
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

    const run = async (fn, label, arg, timeout = 600000) => {
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

    const r1 = await run(phaseRound1, "round 1: 8 cases x A/B x 2 images", pkg);
    const initial = r1.rows.reduce((acc, r) => acc.concat(r.images.map((im) => ({
      sourceNo: r.experiment.sourceNo, arm: r.experiment.arm, imageId: im.imageId, rank: im.rank,
      sha: im.metadata.sha256, verdict: im.evaluation.verdict,
      aes: im.evaluation.aestheticSatisfaction, intent: im.evaluation.intentMatch, notes: im.notes
    }))), []);
    const plan = buildPlanReport(pkg, r1.rows, r1.cmp, TARGETS);
    const opticalPlan = buildOpticalPlanReport(pkg, r1.rows, r1.cmp, TARGETS);

    // 初回の記録が1項目だけ変わっていた場合を、計画側のハッシュで再現する。
    const evalChanges = {
      verdict: planWithEvaluationChange(plan, r1.rows, (im) => { im.evaluation.verdict = "reject"; }),
      aesthetic: planWithEvaluationChange(plan, r1.rows, (im) => { im.evaluation.aestheticSatisfaction = "1"; }),
      intent: planWithEvaluationChange(plan, r1.rows, (im) => { im.evaluation.intentMatch = "5"; }),
      failures: planWithEvaluationChange(plan, r1.rows, (im) => { im.evaluation.failures = ["anatomy"]; }),
      priority: planWithEvaluationChange(plan, r1.rows, (im) => {
        im.evaluation.priorityChecks = (im.evaluation.priorityChecks || []).map((p, i) => ({
          itemId: p.itemId, status: i === 0 ? "missing" : p.status
        }));
      }),
      missingCount: planWithEvaluationChange(plan, r1.rows, (im) => { im.evaluation.missingPriorityCount = 2; }),
      notes: planWithEvaluationChange(plan, r1.rows, (im) => { im.notes = "書き換えられたコメント"; })
    };
    const cmpChanges = {
      compared: planWithComparisonChange(plan, r1.cmp, (c) => { c.comparedImageIds.A = "another-image"; }),
      preference: planWithComparisonChange(plan, r1.cmp, (c) => { c.preference = c.preference === "A" ? "B" : "A"; }),
      notes: planWithComparisonChange(plan, r1.cmp, (c) => { c.notes = "書き換えられた比較コメント"; })
    };

    const rejected = await run(phaseReject, "plan intake refuses mismatched plans",
      { plan, validPlan: opticalPlan, targets: TARGETS, lockedCount: initial.length, evalChanges, cmpChanges });
    const frozen = await run(phaseFrozen, "non-target cases stay frozen",
      { nonTarget: nonTargets[0], invalidations: rejected.invalidations });
    const added = await run(phaseAdd, "target cases accept exactly 2 more per arm at ranks 3,4",
      { targets: TARGETS });
    const nav = await run(phaseNavigate, "next-target walks targets only", { targets: TARGETS });
    const exported = await run(phaseFinalExport, "final export carries initial + added",
      { initial, targets: TARGETS, nonTargets });

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    await run(phaseReload, "reload keeps the plan, locks and progress", { targets: TARGETS });

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
      layout.push(await run(phaseLayout, spec.label + " layout", spec, 120000));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(400);
    await run(phaseDropPlan, "dropping the plan restores the normal review flow",
      { nonTarget: nonTargets[0] }, 120000);

    console.log("R3-FG RESAMPLE PLAN BROWSER ACCEPTANCE PASSED");
    console.log(`  round 1 recorded ${r1.reviewRows} review rows / ${r1.images} images / ${r1.comparisons} comparisons with no plan loaded`);
    console.log(`  plan intake refused ${rejected.refused.length} tampered variants:`);
    rejected.refused.forEach((label, i) => {
      if (i % 4 === 0) console.log("    " + rejected.refused.slice(i, i + 4).join(" / "));
    });
    console.log(`  valid plan accepted: ${TARGETS.length} targets, ${initial.length} initial images locked, opened case ${rejected.opened}`);
    console.log(`  non-target case ${nonTargets[0]}: drop zones disabled, add refused, save refused, initial removal and evaluation locked`);
    console.log(`  targets ${added.visited.join(",")}: +2 per arm at ranks 3,4, third add refused, export blocked mid-round`);
    console.log(`  next-target cycled ${nav.seen.join(" -> ")} (targets only)`);
    console.log(`  final export: ${exported.images} images / ${exported.reviewRows} review rows / ${exported.comparisons} comparisons / ${exported.copyRows} copy rows`);
    console.log(`  reload kept the plan, the locks and 16/16 progress`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px nav rows ${l.navRows}`).join(" | ")}`);
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
