#!/usr/bin/env node
// [R3-FB] A/B実験パッケージ画面の**実ブラウザ**受入検査。
//
//  確かめること:
//   タブが3つになっても既存画面が壊れない -> 合成パッケージの読み込みとハッシュ照合 ->
//   本文・設定が1バイトも変わらない -> 生成条件が画像登録の前提 -> A/B へ画像登録とプレビュー ->
//   評価(明示選択のみ) -> 比較(両方評価済みのときだけ) -> 再読み込み後の復元 ->
//   誤登録画像の無効化と stale 化 -> R3-FA互換の書き出し ->
//   **既存 PCEXPORT レビュー機能が壊れていない**。
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
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }
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
  close() { this.ws.close(); }
}

// ---------------------------------------------------------------------------
// 合成パッケージ(実験の実データは使わない)
// ---------------------------------------------------------------------------
function sha(text) {
  return crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function buildFixturePackage() {
  const insertText = "【合成テスト用の追加文】これはテスト専用のダミー指示です。";
  const cases = [1, 2].map((n) => {
    const head = `合成プロンプト ${n} 行目A\n合成プロンプト ${n} 行目B`;
    const tail = `\n合成プロンプト ${n} 末尾`;
    const a = head + tail;
    const insertOffset = head.length;
    const b = a.slice(0, insertOffset) + "\n" + insertText + a.slice(insertOffset);
    const settings = { schema: "t9_gen_settings.v1", salt: "fixture-" + n, controls: { density: n } };
    return {
      sourceNo: n,
      baselineGenerationId: "gen-fixture-p" + String(n).padStart(3, "0"),
      role: "テスト役割" + n,
      species: "テスト種族" + n,
      reason: "合成フィクスチャ",
      batchId: "fixture-batch",
      no: n,
      settings,
      settingsRaw: JSON.stringify(settings),
      baselinePromptSha256: sha(a),
      arms: {
        A: { generationId: "fixture-exp-p" + String(n).padStart(3, "0") + "-A", role: "control", prompt: a, promptSha256: sha(a), treatmentApplied: false },
        B: { generationId: "fixture-exp-p" + String(n).padStart(3, "0") + "-B", role: "treatment", prompt: b, promptSha256: sha(b), treatmentApplied: true, insertOffset, anchorLine: `合成プロンプト ${n} 行目B` }
      }
    };
  });

  const body = {
    schemaVersion: "persona-experiment-package.v1",
    generatedAt: "2026-08-01T00:00:00.000Z",
    generatedBy: "fixture",
    experiment: {
      experimentId: "fixture-exp",
      hypothesis: "合成フィクスチャ",
      insertionPoint: "テスト用の挿入位置",
      insertText,
      insertTextSha256: sha(insertText),
      holdConstant: ["model"],
      evaluationFocus: ["aesthetic satisfaction"]
    },
    policy: {
      arms: [{ id: "A", role: "control", label: "A 元プロンプト" }, { id: "B", role: "treatment", label: "B 追加文あり" }],
      maxImagesPerArm: 5,
      verdicts: ["accept", "hold", "reject"],
      scoreKeys: ["aestheticSatisfaction", "intentMatch"],
      scoreMin: 1,
      scoreMax: 5,
      failureCodes: ["composition", "hair", "makeup", "clothing", "lighting", "background", "motion", "anatomy", "other"],
      preferences: ["A", "B", "tie"],
      seedSupport: ["supported", "unsupported"],
      adoptionDecision: "not-applicable",
      rankImpliesAdoption: false
    },
    exportTargets: {
      reviewSchemaVersion: "persona-prompt-review.v2",
      experimentSchemaVersion: "persona-facial-fusion-ab.v1"
    },
    cases
  };
  body.definitionSha256 = sha(definitionText(body));
  body.integrity = { algorithm: "sha256", value: sha(JSON.stringify(body)) };
  return body;
}

// 定義の正本テキスト(書き出し側と同じキーの並び)。
function definitionText(pkg) {
  return JSON.stringify({
    experiment: pkg.experiment, policy: pkg.policy,
    exportTargets: pkg.exportTargets, cases: pkg.cases
  });
}

// 既存パッケージから派生を作る。mutate で定義を変えると definitionSha256 も変わる。
function derivePackage(base, opts) {
  const next = JSON.parse(JSON.stringify(base));
  if (opts && opts.generatedAt) next.generatedAt = opts.generatedAt;
  if (opts && typeof opts.mutate === "function") opts.mutate(next);
  delete next.definitionSha256;
  delete next.integrity;
  next.definitionSha256 = sha(definitionText(next));
  next.integrity = { algorithm: "sha256", value: sha(JSON.stringify(next)) };
  return next;
}

// ---------------------------------------------------------------------------
// ページ内共通ヘルパ
// ---------------------------------------------------------------------------
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
  const setVal = (id, v) => {
    const n = byId(id);
    if (!n) { problems.push("missing input: " + id); return; }
    n.value = String(v);
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const st = () => (byId("abStatus") || {}).textContent || "";
  const waitS = (re, label) => waitFor(() => re.test(st()), label);
  const makeFile = (name, seedByte, type) => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + seedByte) % 251;
    const file = new File([bytes], name, { type: type || "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt.files;
  };
  const attach = (id, files) => {
    const n = byId(id);
    n.files = files;
    n.dispatchEvent(new Event("change", { bubbles: true }));
  };
`;

// ---------------------------------------------------------------------------
// フェーズ1: 既存画面が壊れていないこと + パッケージ読み込み
// ---------------------------------------------------------------------------
function phaseLoad(pkg) {
  return (async (pkgArg) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");

    // --- 既存の PCEXPORT 画面が残っていること ---
    note(!!byId("extractTab") && !!byId("reviewTab") && !!byId("abTab"), "タブが3つ揃っていない");
    note(!!byId("pasteArea") && !!byId("fileButton"), "既存の取り出し画面が壊れている");
    note(byId("extractView").hidden === false, "初期表示が取り出し画面でない");
    note(byId("abView").hidden === true, "A/B画面が初期表示になっている");

    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view shown");
    note(byId("extractView").hidden === true && byId("reviewView").hidden === true,
      "A/B表示中に他画面が隠れていない");
    note(byId("abTab").getAttribute("aria-selected") === "true", "A/Bタブが選択状態になっていない");

    // --- 合成パッケージを読み込む ---
    const text = JSON.stringify(pkgArg, null, 2) + "\n";
    const dt = new DataTransfer();
    dt.items.add(new File([text], "fixture-package.json", { type: "application/json" }));
    attach("abFileInput", dt.files);
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "package loaded");
    note(/ハッシュ照合済み/.test(byId("abPackageStatus").textContent),
      "ハッシュ照合の表示が出ていない: " + byId("abPackageStatus").textContent);
    note(byId("abCaseSelect").options.length === pkgArg.cases.length,
      "ケース数が合わない: " + byId("abCaseSelect").options.length);

    // --- 本文・設定が1バイトも変わらない ---
    const c0 = pkgArg.cases[0];
    note(byId("abPromptA").value === c0.arms.A.prompt, "A 本文が変わっている");
    note(byId("abPromptB").value === c0.arms.B.prompt, "B 本文が変わっている");
    note(byId("abPromptB").value.replace("\n" + pkgArg.experiment.insertText, "") === c0.arms.A.prompt,
      "A/B 差分が挿入1文だけになっていない");
    note(/差分は指定の1文の挿入だけ/.test(byId("abInsertInfo").textContent),
      "差分照合の表示が出ていない");

    // --- 壊れたパッケージは拒否される ---
    const broken = JSON.parse(JSON.stringify(pkgArg));
    broken.cases[0].arms.B.prompt += "改ざん";
    const dt2 = new DataTransfer();
    dt2.items.add(new File([JSON.stringify(broken)], "broken.json", { type: "application/json" }));
    attach("abFileInput", dt2.files);
    await waitFor(() => /使えません/.test(byId("abPackageStatus").textContent), "broken rejected");
    note(byId("abPromptA").value === c0.arms.A.prompt, "拒否したのに本文が差し替わった");

    return { pass: problems.length === 0, problems, cases: byId("abCaseSelect").options.length,
      aBytes: byId("abPromptA").value.length, bBytes: byId("abPromptB").value.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ2: 生成条件 -> 画像登録 -> 評価 -> 比較
// ---------------------------------------------------------------------------
function phaseWorkflow() {
  return (async () => {
    __PRELUDE__
    // 生成条件が先
    attach("abFileA", makeFile("a1.png", 3));
    await delay(200);
    note(byId("abAddA").disabled === true, "生成条件なしで画像登録が押せてしまう");

    setVal("abProvider", "openai");
    setVal("abModel", "gpt-image-1");
    setVal("abSeedSupport", "supported");
    await waitFor(() => byId("abSeed").disabled === false, "seed enabled");
    note(byId("abSaveCondition").disabled === true, "Seed未入力で条件保存が押せる");
    setVal("abSeed", "4242");
    await waitFor(() => !byId("abSaveCondition").disabled, "condition ready");
    byId("abSaveCondition").click();
    await waitS(/生成条件を記録しました/, "condition saved");

    // A へ2枚、B へ1枚
    attach("abFileA", makeFile("a1.png", 3));
    await waitFor(() => !byId("abAddA").disabled, "add A enabled");
    byId("abAddA").click();
    await waitS(/画像を登録しました/, "A image 1");
    attach("abFileA", makeFile("a2.png", 11));
    await waitFor(() => !byId("abAddA").disabled, "add A enabled 2");
    byId("abAddA").click();
    await waitS(/2 枚目/, "A image 2");
    attach("abFileB", makeFile("b1.png", 19));
    await waitFor(() => !byId("abAddB").disabled, "add B enabled");
    byId("abAddB").click();
    await waitS(/画像を登録しました/, "B image 1");

    // 重複ハッシュは拒否
    attach("abFileA", makeFile("a1-copy.png", 3));
    await waitFor(() => !byId("abAddA").disabled, "add A enabled 3");
    byId("abAddA").click();
    await waitS(/同一ハッシュ/, "duplicate rejected");

    // プレビュー
    const thumbsA = byId("abThumbsA").querySelectorAll("img");
    note(thumbsA.length === 2, "A のサムネイルが2枚でない: " + thumbsA.length);
    note(Array.prototype.every.call(thumbsA, (n) => n.src.indexOf("blob:") === 0), "サムネイルが Object URL でない");
    note(Array.prototype.every.call(thumbsA, (n) => !!n.getAttribute("alt") && n.children.length === 0),
      "サムネイルに alt が無い / 子要素が差し込まれている");

    // 無操作では評価を書かない
    const target = byId("abReviewTarget");
    setVal("abReviewTarget", target.options[1].value);
    await delay(200);
    note(byId("abSaveReview").disabled === true, "画像を選んだだけで評価保存が押せる");
    note(byId("abVerdict").value === "" , "判定に既定値が入っている");

    // A の1枚目を評価
    const aFirst = target.options[1].value;
    setVal("abVerdict", "hold");
    setVal("abScore_aestheticSatisfaction", "2");
    setVal("abScore_intentMatch", "4");
    const anat = byId("abFailures").querySelector('[data-ab-failure-code="anatomy"]');
    anat.querySelector("input").checked = true;
    setVal("abReviewNotes", "耳が人間寄り");
    await waitFor(() => !byId("abSaveReview").disabled, "review enabled");
    byId("abSaveReview").click();
    await waitS(/評価を保存しました/, "A review saved");

    // 比較は B が未評価なのでまだ保存できない
    setVal("abCompareA", aFirst);
    const bId = byId("abCompareB").options[1].value;
    setVal("abCompareB", bId);
    setVal("abPreference", "B");
    setVal("abCompareNotes", "顔の意匠が明確になった");
    await delay(300);
    note(byId("abSaveComparison").disabled === true, "未評価なのに比較保存が押せる");
    note(/未評価/.test(byId("abCompareState").textContent),
      "未評価であることが出ていない: " + byId("abCompareState").textContent);

    // B を評価してから比較
    setVal("abReviewTarget", bId);
    setVal("abVerdict", "accept");
    setVal("abScore_aestheticSatisfaction", "4");
    setVal("abScore_intentMatch", "5");
    await waitFor(() => !byId("abSaveReview").disabled, "B review enabled");
    byId("abSaveReview").click();
    await waitS(/評価を保存しました/, "B review saved");

    setVal("abPreference", "B");
    await waitFor(() => !byId("abSaveComparison").disabled, "compare enabled");
    // 横並び表示
    const zA = byId("abZoomA").getBoundingClientRect();
    const zB = byId("abZoomB").getBoundingClientRect();
    note(byId("abZoomA").hidden === false && byId("abZoomB").hidden === false, "横並びの拡大表示が出ていない");
    note(zA.width > 0 && zB.width > 0 && Math.abs(zA.top - zB.top) < 40 && zA.left < zB.left,
      "A/B が横並びになっていない: " + JSON.stringify({ aTop: zA.top, bTop: zB.top, aLeft: zA.left, bLeft: zB.left }));

    byId("abSaveComparison").click();
    await waitS(/比較を記録しました/, "comparison saved");
    note(/採用判定ではありません/.test(st()), "採用判定でない旨が出ていない");
    note(/採用判定として扱いません/.test(byId("abView").textContent), "採用判定外の注意書きが画面に無い");

    const saved = JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
    note(saved.images.length === 3, "保存された画像が3件でない: " + saved.images.length);
    note(saved.reviews.length === 2, "保存された評価が2件でない: " + saved.reviews.length);
    note(saved.comparisons.length === 1 && saved.comparisons[0].adoptionDecision === "not-applicable",
      "比較が採用判定外で保存されていない");
    note(saved.comparisons[0].controlImageId === aFirst && saved.comparisons[0].treatmentImageId === bId,
      "比較対象の imageId が保存されていない");
    note(saved.conditions.length === 1 && saved.conditions[0].imageSeed === "4242", "生成条件が保存されていない");
    note(saved.images.every((r) => !r.blob && !r.bytes), "画像バイトが localStorage に入っている");

    return { pass: problems.length === 0, problems, images: saved.images.length,
      reviews: saved.reviews.length, aFirst, bId };
  })();
}

// ---------------------------------------------------------------------------
// フェーズ3: 再読み込み後の復元 -> 無効化 -> stale -> 書き出し
// ---------------------------------------------------------------------------
function phaseReloadAndExport(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view shown");
    await waitFor(() => /復元しました/.test(byId("abPackageStatus").textContent), "package restored");

    const saved = JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
    note(saved.images.length === 3 && saved.reviews.length === 2 && saved.comparisons.length === 1,
      "再読み込み後に記録が残っていない");
    note(saved.conditions[0].provider === "openai" && saved.conditions[0].imageSeed === "4242",
      "再読み込み後に生成条件が残っていない");

    // 生成条件と比較の復元
    await waitFor(() => byId("abProvider").value === "openai", "condition restored");
    note(byId("abModel").value === "gpt-image-1" && byId("abSeedSupport").value === "supported"
      && byId("abSeed").value === "4242", "生成条件の入力欄が復元されていない");
    note(byId("abSaveCondition").disabled === true, "画像がある状態で条件を変更できてしまう");
    await waitFor(() => byId("abPreference").value === "B", "preference restored");
    note(byId("abCompareNotes").value === "顔の意匠が明確になった", "比較コメントが復元されていない");
    note(byId("abCompareA").value === a.aFirst && byId("abCompareB").value === a.bId,
      "比較対象が復元されていない");

    // プレビューも復元される(実体は IndexedDB から)
    await waitFor(() => byId("abThumbsA").querySelectorAll("img").length === 2, "thumbs restored");
    note(byId("abZoomA").hidden === false, "再読み込み後に拡大表示が復元されていない");

    // 評価の復元(訂正でコメントと失敗分類が消えない)
    setVal("abReviewTarget", a.aFirst);
    await waitFor(() => byId("abVerdict").value === "hold", "review prefilled");
    note(byId("abReviewNotes").value === "耳が人間寄り", "評価コメントが復元されていない");
    note(byId("abFailures").querySelector('[data-ab-failure-code="anatomy"]').querySelector("input").checked === true,
      "失敗分類が復元されていない");
    setVal("abScore_aestheticSatisfaction", "4");
    byId("abSaveReview").click();
    await waitS(/評価を保存しました/, "review corrected");
    let now = JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
    note(now.reviews.length === 3, "訂正が append-only で積まれていない: " + now.reviews.length);

    // --- 書き出し(R3-FA互換) ---
    const reviewRows = [];
    const origCreate = URL.createObjectURL;
    // 書き出し内容を実ダウンロードせずに捕まえる
    let captured = null;
    URL.createObjectURL = function (blob) { captured = blob; return origCreate.call(URL, blob); };
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "review jsonl exported");
    const reviewText = await captured.text();
    URL.createObjectURL = origCreate;
    const rows = reviewText.trim().split("\n").map((l) => JSON.parse(l));
    note(rows.length === 2, "レビュー行が2件でない: " + rows.length);
    const rowA = rows.filter((r) => r.experiment.arm === "A")[0];
    const rowB = rows.filter((r) => r.experiment.arm === "B")[0];
    note(rowA.schemaVersion === "persona-prompt-review.v2", "R3-FA互換のスキーマでない: " + rowA.schemaVersion);
    note(rowA.source.prompt === a.promptA, "書き出しの A 本文が変わっている");
    note(rowB.source.prompt === a.promptB, "書き出しの B 本文が変わっている");
    note(rowA.experiment.promptSha256 !== rowB.experiment.promptSha256, "A/B の promptSha256 が同値");
    note(rowA.experiment.promptSha256 === a.shaA && rowB.experiment.promptSha256 === a.shaB,
      "promptSha256 がパッケージの値と違う");
    note(rowA.experiment.generationConditions.imageSeed === "4242", "生成条件が書き出しに無い");
    note(rowA.experiment.adoptionDecision === "not-applicable", "書き出しが採用判定外になっていない");
    note(rowA.comparison.bestImageId === a.aFirst, "bestImageId が比較対象になっていない");
    note(typeof rowA.images[0].evaluation.aestheticSatisfaction === "string",
      "スコアが v2 の文字列形になっていない");

    // --- 無効化 -> stale ---
    setVal("abReviewTarget", a.aFirst);
    await waitFor(() => !byId("abInvalidate").disabled, "invalidate enabled");
    byId("abInvalidate").click();
    await waitS(/無効化しました/, "invalidated");
    await waitFor(() => /再比較が必要/.test(byId("abComparisonState").textContent), "stale notice");
    now = JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
    note(now.invalidations.length === 1, "無効化記録が残っていない");
    note(now.images.length === 3, "無効化で画像行が物理削除された");
    note(/無効化済み/.test(byId("abListA").textContent), "一覧に無効化済みの印が無い");
    note(!/比較記録済み 1 件/.test(byId("abProgress").textContent),
      "stale 比較が進捗に数えられている: " + byId("abProgress").textContent);

    captured = null;
    URL.createObjectURL = function (blob) { captured = blob; return origCreate.call(URL, blob); };
    byId("abExportComparisons").click();
    await delay(400);
    URL.createObjectURL = origCreate;
    note(/書き出す記録がまだありません/.test(st()),
      "stale 比較が比較JSONLへ出ている: " + st());

    return { pass: problems.length === 0, problems, reviewRows: rows.length,
      invalidations: now.invalidations.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ3b: 定義が同じなら記録を保つ / 変わったら消してから入れ替える
// ---------------------------------------------------------------------------
function phaseDefinitionSwap(arg) {
  return (async (a) => {
    __PRELUDE__
    const read = () => JSON.parse(localStorage.getItem("personaGenerator.abExperiment.v1"));
    const countBlobs = () => new Promise((resolve) => {
      const req = indexedDB.open("personaGeneratorAbImages", 1);
      req.onsuccess = () => {
        const d = req.result;
        const tx = d.transaction(["abImagesV1"], "readonly");
        const c = tx.objectStore("abImagesV1").count();
        c.onsuccess = () => { d.close(); resolve(c.result); };
        c.onerror = () => { d.close(); resolve(-1); };
      };
      req.onerror = () => resolve(-1);
    });
    const drop = (pkg, name) => {
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(pkg, null, 2) + "\n"], name, { type: "application/json" }));
      attach("abFileInput", dt.files);
    };

    const before = read();
    note(before.images.length === 3, "前提: 画像3件が残っていない: " + before.images.length);
    const blobsBefore = await countBlobs();
    note(blobsBefore === 3, "前提: 画像実体3件が残っていない: " + blobsBefore);

    // --- 1. 同じ定義(日時だけ違う)を読み直す -> 記録はそのまま ---
    note(a.same.definitionSha256 === a.original.definitionSha256,
      "日時だけ違うパッケージの definitionSha256 が変わっている");
    note(a.same.generatedAt !== a.original.generatedAt, "テスト前提: generatedAt が同じ");
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    drop(a.same, "same-definition.json");
    await waitFor(() => /記録はそのまま/.test(byId("abPackageStatus").textContent), "same definition reloaded");
    let now = read();
    note(now.images.length === 3 && now.reviews.length === 3 && now.comparisons.length === 1
      && now.conditions.length === 1 && now.invalidations.length === 1,
      "同一定義の読み直しで記録が失われた: " + JSON.stringify({
        i: now.images.length, r: now.reviews.length, c: now.comparisons.length,
        cd: now.conditions.length, iv: now.invalidations.length }));
    note(window.__confirms.length === 0, "同一定義なのに確認を求めた");
    note(now.pkg.generatedAt === a.same.generatedAt, "パッケージ自体は差し替わっていない");
    note(await countBlobs() === 3, "同一定義の読み直しで画像実体が消えた");

    // --- 2. 同じ experimentId で定義が違う -> 拒否すると何も変わらない ---
    note(a.changed.experiment.experimentId === a.original.experiment.experimentId,
      "テスト前提: experimentId が違う");
    note(a.changed.definitionSha256 !== a.original.definitionSha256,
      "本文を変えても definitionSha256 が変わっていない");
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return false; };
    drop(a.changed, "changed-definition.json");
    await waitFor(() => /中止しました/.test(byId("abPackageStatus").textContent), "declined");
    note(window.__confirms.length === 1 && /実験定義（本文・設定・方針）が変わって/.test(window.__confirms[0]),
      "定義差の説明が確認文に無い: " + (window.__confirms[0] || ""));
    now = read();
    note(now.images.length === 3 && now.reviews.length === 3 && now.comparisons.length === 1,
      "拒否したのに記録が変わった");
    note(now.pkg.definitionSha256 === a.original.definitionSha256, "拒否したのにパッケージが差し替わった");
    note(await countBlobs() === 3, "拒否したのに画像実体が消えた");
    note(byId("abPromptA").value === a.originalPromptA, "拒否したのに本文が差し替わった");

    // --- 3. 承認すると旧記録と旧画像実体が消えてから入れ替わる ---
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    drop(a.changed, "changed-definition.json");
    await waitFor(() => /以前の記録は削除しました/.test(byId("abPackageStatus").textContent), "swapped");
    note(window.__confirms.length === 1, "承認時の確認が1回でない: " + window.__confirms.length);
    now = read();
    note(now.images.length === 0 && now.reviews.length === 0 && now.comparisons.length === 0
      && now.conditions.length === 0 && now.invalidations.length === 0,
      "定義変更後に旧記録が残っている: " + JSON.stringify({
        i: now.images.length, r: now.reviews.length, c: now.comparisons.length,
        cd: now.conditions.length, iv: now.invalidations.length }));
    note(now.pkg.definitionSha256 === a.changed.definitionSha256, "新しい定義に入れ替わっていない");
    const blobsAfter = await countBlobs();
    note(blobsAfter === 0, "旧画像の実体が消えていない: " + blobsAfter);
    note(byId("abPromptA").value === a.changedPromptA, "新しい本文が表示されていない");
    note(byId("abThumbsA").querySelectorAll("img").length === 0, "旧サムネイルが残っている");
    note(byId("abProvider").value === "" && byId("abSeed").value === "",
      "旧生成条件が入力欄に残っている");
    note(byId("abPreference").value === "", "旧 preference が残っている");
    note(/未記録/.test(byId("abComparisonState").textContent),
      "旧比較が残っている: " + byId("abComparisonState").textContent);
    // 新パッケージで書き出すと、旧記録は1行も出ない
    byId("abExportReviews").click();
    await delay(400);
    note(/書き出す記録がまだありません/.test(st()), "新パッケージに旧記録が紐づいている: " + st());

    // --- 4. 別の experimentId も同じ順序で安全に入れ替わる ---
    window.__confirms = [];
    drop(a.otherId, "other-experiment.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "other experiment loaded");
    now = read();
    note(now.pkg.experiment.experimentId === a.otherId.experiment.experimentId,
      "別実験へ入れ替わっていない");
    note(now.images.length === 0 && now.reviews.length === 0, "別実験へ入れ替えたのに記録が残っている");
    note(await countBlobs() === 0, "別実験へ入れ替えたのに画像実体が残っている");

    return { pass: problems.length === 0, problems, blobsBefore, blobsAfter };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ4: 既存 PCEXPORT レビュー機能が壊れていないこと
// ---------------------------------------------------------------------------
function phaseLegacy() {
  return (async () => {
    __PRELUDE__
    byId("extractTab").click();
    await waitFor(() => byId("extractView").hidden === false, "extract shown");
    note(byId("abView").hidden === true, "取り出し画面でA/B画面が隠れていない");

    const sample = [
      "<<<PCEXPORT v1 count=1>>>",
      "<<<PROMPT 1>>>",
      "既存フロー確認用のプロンプト本文",
      "<<<SETTINGS 1>>>",
      '{"schema":"t9_gen_settings.v1","salt":"legacy"}',
      "<<<PCEXPORT END>>>"
    ].join("\n");
    setVal("pasteArea", sample);
    byId("parseButton").click();
    await waitFor(() => byId("viewer").style.display !== "none", "parsed");
    note(byId("promptBox").textContent.indexOf("既存フロー確認用のプロンプト本文") >= 0,
      "既存の解析結果が出ていない");

    byId("reviewTab").click();
    await waitFor(() => byId("reviewView").hidden === false, "review shown");
    note(byId("abView").hidden === true, "レビュー画面でA/B画面が隠れていない");
    attach("reviewImages", makeFile("legacy.png", 31));
    await waitFor(() => byId("reviewImageList").children.length === 1, "legacy image added");
    byId("reviewBottomSaveButton").click();
    await waitFor(() => {
      const raw = localStorage.getItem("personaGenerator.promptReviews.v1");
      return raw && JSON.parse(raw).length === 1;
    }, "legacy review saved");
    const legacy = JSON.parse(localStorage.getItem("personaGenerator.promptReviews.v1"))[0];
    note(legacy.schemaVersion === "persona-prompt-review.v3",
      "既存レビューのスキーマが変わっている: " + legacy.schemaVersion);
    note(!!legacy.comparison && "topRankedImageId" in legacy.comparison,
      "既存レビューの comparison 形が変わっている");
    // 既存とA/Bで保存先が分かれていること
    note(!!localStorage.getItem("personaGenerator.abExperiment.v1"), "A/B側の保存が消えている");
    note(legacy.images.length === 1, "既存レビューの画像が保存されていない");

    return { pass: problems.length === 0, problems, legacySchema: legacy.schemaVersion };
  })();
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const pkg = buildFixturePackage();
  const server = createServer();
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fb-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fb-dl-"));
  const chrome = spawn(CHROME_PATH, [
    "--headless=new", "--disable-background-networking", "--disable-default-apps",
    "--disable-extensions", "--disable-gpu", "--disable-sync",
    "--no-default-browser-check", "--no-first-run",
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
    try {
      await client.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
    } catch (_) {
      await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir }, sessionId);
    }
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

    const loaded = await run(phaseLoad, "package load and hash verification", pkg);
    const worked = await run(phaseWorkflow, "condition, images, review, comparison");

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    const c0 = pkg.cases[0];
    const reloaded = await run(phaseReloadAndExport, "reload restore, invalidate, export", {
      aFirst: worked.aFirst, bId: worked.bId,
      promptA: c0.arms.A.prompt, promptB: c0.arms.B.prompt,
      shaA: c0.arms.A.promptSha256, shaB: c0.arms.B.promptSha256
    });
    const same = derivePackage(pkg, { generatedAt: "2027-05-06T07:08:09.000Z" });
    const changed = derivePackage(pkg, { mutate: (p) => { p.cases[0].arms.B.prompt += "\n追記された行"; p.cases[0].arms.B.promptSha256 = sha(p.cases[0].arms.B.prompt); } });
    const otherId = derivePackage(pkg, { mutate: (p) => { p.experiment.experimentId = "fixture-exp-2"; } });
    const swapped = await run(phaseDefinitionSwap, "definition-aware package swap", {
      original: pkg, same, changed, otherId,
      originalPromptA: pkg.cases[0].arms.A.prompt,
      changedPromptA: changed.cases[0].arms.A.prompt
    });

    const legacy = await run(phaseLegacy, "existing PCEXPORT review flow");

    console.log("R3-FB A/B EXPERIMENT PACKAGE BROWSER ACCEPTANCE PASSED");
    console.log(`  3 tabs, existing screens intact | package verified (${loaded.cases} cases, A=${loaded.aBytes}B B=${loaded.bBytes}B)`);
    console.log(`  tampered package rejected without replacing the loaded one`);
    console.log(`  condition required before images | images=${worked.images} reviews=${worked.reviews} (untouched form wrote nothing)`);
    console.log(`  comparison blocked until both targets reviewed; recorded as not-applicable`);
    console.log(`  reload restored package/condition/comparison/preview | export rows=${reloaded.reviewRows} in persona-prompt-review.v2`);
    console.log(`  invalidated=${reloaded.invalidations} -> comparison went stale and left both progress and export`);
    console.log(`  same definition (new timestamp) kept every record and blob; changed definition needed consent`);
    console.log(`  declined swap changed nothing | approved swap wiped ${swapped.blobsBefore} blobs -> ${swapped.blobsAfter} before installing`);
    console.log(`  existing PCEXPORT flow still saves ${legacy.legacySchema}`);
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
