#!/usr/bin/env node
// [R3-FC] A/B比較ワークベンチの**実ブラウザ**受入検査。
//
//  確かめること(ブリーフ §5 の受入条件):
//   生成元は1回の登録で次ケースへ引き継がれる -> 本文は既定で閉じ、コピーは1バイト不変 ->
//   画像は選ぶ/落とすだけで登録され、その場で横並び比較に出る -> 片側だけでも個別レビューを
//   保存でき採用扱いにならない -> 必須が揃うと一操作で全画像レビューと比較1件を保存して
//   次の未完了ケースへ進む -> 再読み込みで条件・画像・レビュー・比較・進捗が復元 ->
//   書き出しは R3-FB 互換 -> iPhoneの縦横とデスクトップで崩れない ->
//   複数画像を切り替えても下書きが消えず全画像が保存される ->
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
// ページ内共通ヘルパ(各フェーズの先頭へ差し込む)
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
  // 実際にデコードできる PNG を作る(壊れた画像だとレイアウト計測が alt 文字幅になる)。
  // 同じ seed は同じバイト列になるので、重複ハッシュの検査にも使える。
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
  // 画像は「選ぶ / 落とす」だけで登録される(別の登録ボタンは無い)。
  const pickImage = async (arm, name, seed) => {
    byId("abStatus").textContent = "";
    const n = byId("abFile" + arm);
    n.files = await files(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitS(/画像を .* 枚置きました|登録できませんでした/, "image " + arm + " " + name);
  };
  const dropImage = async (arm, name, seed) => {
    const zone = byId("abDrop" + arm);
    const dt = new DataTransfer();
    dt.items.add(new File([await makePng(seed)], name, { type: "image/png" }));
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    byId("abStatus").textContent = "";
    zone.dispatchEvent(ev);
    await waitS(/画像を .* 枚置きました|登録できませんでした/, "drop " + arm + " " + name);
  };
  const reviewSide = (arm, verdict, aesthetic, intent, notes) => {
    setVal("abRev" + arm + "_verdict", verdict);
    setVal("abRev" + arm + "_aestheticSatisfaction", aesthetic);
    setVal("abRev" + arm + "_intentMatch", intent);
    if (notes !== undefined) setVal("abRev" + arm + "_notes", notes);
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
`;

// ---------------------------------------------------------------------------
// フェーズ1: 既存画面が壊れていない -> パッケージ読込 -> 生成元は1回だけ
// ---------------------------------------------------------------------------
function phaseLoad(pkg) {
  return (async (pkgArg) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");

    note(!!byId("extractTab") && !!byId("reviewTab") && !!byId("abTab"), "タブが3つ揃っていない");
    note(!!byId("pasteArea") && !!byId("fileButton"), "既存の取り出し画面が壊れている");
    note(byId("extractView").hidden === false, "初期表示が取り出し画面でない");

    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view shown");
    note(byId("abWorkbench").hidden === true, "パッケージ前から作業台が出ている");
    note(byId("abIntro").hidden === false, "読み込み案内が出ていない");

    const text = JSON.stringify(pkgArg, null, 2) + "\n";
    const dt = new DataTransfer();
    dt.items.add(new File([text], "fixture-package.json", { type: "application/json" }));
    const input = byId("abFileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "package loaded");

    // 生成元の登録を1回だけ求める。最初は選ぶだけで、技術用語の欄は出さない。
    note(byId("abSetup").hidden === false, "生成元の登録画面が出ていない");
    note(byId("abWorkbench").hidden === true, "生成元未登録なのに作業台が出ている");
    note(/どこで画像を作りますか/.test(byId("abSetup").textContent),
      "最初の問いかけが出ていない: " + byId("abSetup").textContent.slice(0, 40));
    note(!!byId("abSetupChatgpt") && !!byId("abSetupOther"), "生成元の選択肢が無い");
    note(byId("abSetupDetail").hidden === true, "最初から provider/model の欄が出ている");
    byId("abSetupOther").click();
    await waitFor(() => byId("abSetupDetail").hidden === false, "detail opened");
    note(byId("abSaveCondition").disabled === true, "未入力で登録ボタンが押せる");
    setVal("abProvider", "openai");
    setVal("abModel", "gpt-image-1");
    setVal("abSeedSupport", "supported");
    await waitFor(() => byId("abSeed").disabled === false, "seed enabled");
    note(byId("abSaveCondition").disabled === true, "Seed未入力で登録ボタンが押せる");
    setVal("abSeed", "4242");
    await waitFor(() => !byId("abSaveCondition").disabled, "condition ready");
    byId("abSaveCondition").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench shown");
    note(byId("abSetup").hidden === true, "登録後も生成元画面が残っている");

    // ヘッダーの現在地
    note(/ケース 1 \/ 2/.test(byId("abCaseCounter").textContent),
      "ケース番号が出ていない: " + byId("abCaseCounter").textContent);
    note(byId("abCaseState").textContent === "未生成",
      "ケース状態が未生成でない: " + byId("abCaseState").textContent);
    note(/完了 0 件/.test(byId("abDoneCount").textContent), "完了件数が出ていない");

    // A/B の説明文量が違っても、主要操作とカード下端を同じ基準線へ揃える。
    // 文言変更で折返しが増えても、片側だけが下へずれる状態を公開しない。
    const copyARect = byId("abCopyA").getBoundingClientRect();
    const copyBRect = byId("abCopyB").getBoundingClientRect();
    const dropARect = byId("abDropA").getBoundingClientRect();
    const dropBRect = byId("abDropB").getBoundingClientRect();
    const sideARect = document.querySelector('[data-ab-side="A"]').getBoundingClientRect();
    const sideBRect = document.querySelector('[data-ab-side="B"]').getBoundingClientRect();
    if (window.innerWidth >= 720) {
      note(Math.abs(copyARect.top - copyBRect.top) <= 1,
        "A/B のコピーボタン上端がずれている: " + JSON.stringify({ A: copyARect.top, B: copyBRect.top }));
      note(Math.abs(dropARect.top - dropBRect.top) <= 1,
        "A/B の画像登録欄がずれている: " + JSON.stringify({ A: dropARect.top, B: dropBRect.top }));
      note(Math.abs(sideARect.height - sideBRect.height) <= 1,
        "A/B カードの高さが揃っていない: " + JSON.stringify({ A: sideARect.height, B: sideBRect.height }));
    }

    // 本文は既定で閉じている & コピーは1バイトも変えない
    const c0 = pkgArg.cases[0];
    const details = byId("abPromptA").closest("details");
    note(details && details.open === false, "本文が既定で開いている");
    note(byId("abPromptA").value === c0.arms.A.prompt, "A 本文が変わっている");
    note(byId("abPromptB").value === c0.arms.B.prompt, "B 本文が変わっている");
    let copied = null;
    navigator.clipboard.writeText = (t) => { copied = t; return Promise.resolve(); };
    byId("abCopyA").click();
    await waitS(/コピーしました/, "copy A");
    note(copied === c0.arms.A.prompt, "コピーした本文が元と違う");
    byId("abCopySettingsA").click();
    await waitS(/コピーしました/, "copy settings");
    note(copied === c0.settingsRaw, "コピーした生成設定が元と違う");

    return { pass: problems.length === 0, problems,
      cases: byId("abCaseSelect") ? -1 : pkgArg.cases.length,
      promptBytes: byId("abPromptA").value.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ2: 画像は置いた瞬間に登録 -> インライン評価 -> 一操作で保存して次へ
// ---------------------------------------------------------------------------
function phaseWorkbench() {
  return (async () => {
    __PRELUDE__
    // 選択だけで登録され、そのまま比較プレビューに出る
    await pickImage("A", "a1.png", 3);
    note(store().images.length === 1, "選択だけで登録されていない");
    note(byId("abBigA").hidden === false, "登録直後に大きく表示されていない");
    note(byId("abBigA").src.indexOf("blob:") === 0, "プレビューが Object URL でない");
    note(byId("abThumbsA").querySelectorAll("img").length === 1, "サムネイルが出ていない");
    note(byId("abReviewA").querySelectorAll("select").length >= 3, "画像直下の評価欄が出ていない");
    note(byId("abCaseState").textContent === "Aのみ",
      "状態が Aのみ でない: " + byId("abCaseState").textContent);

    // ドラッグ&ドロップでも登録される
    await dropImage("B", "b1.png", 19);
    note(store().images.length === 2, "ドロップで登録されていない");
    note(byId("abBigB").hidden === false, "B が大きく表示されていない");
    note(byId("abCaseState").textContent === "評価待ち",
      "状態が 評価待ち でない: " + byId("abCaseState").textContent);

    // A/B が同じ画面内に並んでいる(下部の別カードへ隔離していない)
    const ra = byId("abBigA").getBoundingClientRect();
    const rb = byId("abBigB").getBoundingClientRect();
    const wide = window.innerWidth >= 720;
    note(ra.width > 0 && rb.width > 0, "比較画像が表示されていない");
    if (wide) {
      note(Math.abs(ra.top - rb.top) <= 1 && ra.left < rb.left,
        "デスクトップで A/B が横並びでない: " + JSON.stringify({ at: ra.top, bt: rb.top, al: ra.left, bl: rb.left }));
    }

    // 同一ハッシュは拒否
    await pickImage("A", "a1-copy.png", 3);
    note(/同一画像/.test(st()), "同一ハッシュが拒否されていない: " + st());
    note(store().images.length === 2, "同一ハッシュが登録された");

    // 1枚目を評価してから2枚目を追加する。画像が切り替わっても入力を失ってはいけない。
    note(byId("abSaveNext").disabled === true, "未評価で保存が押せる");
    reviewSide("A", "hold", "2", "4", "A1 耳が人間寄り");
    const anat = byId("abRevA_failures").querySelector('[data-ab-failure-code="anatomy"]');
    anat.querySelector("input").checked = true;
    anat.querySelector("input").dispatchEvent(new Event("change", { bubbles: true }));
    await delay(150);
    note(byId("abSaveNext").disabled === true, "B 未評価で保存が押せる");
    reviewSide("B", "accept", "4", "5", "B1 顔の意匠が明確");
    await pickImage("A", "a2.png", 23);
    await pickImage("B", "b2.png", 29);
    note(store().images.length === 4, "2枚ずつ登録されていない");
    note(byId("abSaveNext").disabled === true, "2枚目が未評価なのに保存が押せる");

    reviewSide("A", "accept", "5", "5", "A2 まとまりが良い");
    reviewSide("B", "hold", "3", "4", "B2 変形がやや強い");
    await delay(150);

    // 1枚目へ戻ると、保存前の判定・スコア・失敗分類・コメントがすべて復元される。
    byId("abThumbsA").querySelectorAll("img")[0].click();
    await waitFor(() => byId("abRevA_notes").value === "A1 耳が人間寄り", "A1 draft restored");
    note(byId("abRevA_verdict").value === "hold"
      && byId("abRevA_aestheticSatisfaction").value === "2"
      && byId("abRevA_intentMatch").value === "4", "A1 の判定・スコアが消えた");
    note(anat.querySelector("input").checked === true, "A1 の失敗分類が消えた");
    byId("abThumbsB").querySelectorAll("img")[0].click();
    await waitFor(() => byId("abRevB_notes").value === "B1 顔の意匠が明確", "B1 draft restored");
    note(byId("abRevB_verdict").value === "accept"
      && byId("abRevB_aestheticSatisfaction").value === "4"
      && byId("abRevB_intentMatch").value === "5", "B1 の判定・スコアが消えた");

    // 比較対象は2枚目へ戻す。2枚目の入力も同じように復元される。
    byId("abThumbsA").querySelectorAll("img")[1].click();
    byId("abThumbsB").querySelectorAll("img")[1].click();
    await waitFor(() => byId("abRevA_notes").value === "A2 まとまりが良い"
      && byId("abRevB_notes").value === "B2 変形がやや強い", "second drafts restored");
    note(Object.keys(store().reviewDrafts || {}).length === 4, "画像ごとの下書きが4件保存されていない");

    // 全画像の必須項目が揃っていても、A/B preference までは保存できない。
    note(byId("abSaveNext").disabled === true, "preference 未選択で保存が押せる");
    setVal("abPreference", "B");
    setVal("abCompareNotes", "顔の意匠が明確になった");
    await waitFor(() => !byId("abSaveNext").disabled, "save enabled");
    note(byId("abSaveNext").textContent === "全4枚の評価と比較を保存して次へ",
      "保存ボタンの文言が違う: " + byId("abSaveNext").textContent);

    // 一操作でレビュー4件と比較1件を保存し、次の未完了ケースへ
    byId("abSaveNext").click();
    await waitFor(() => /ケース 2 \/ 2/.test(byId("abCaseCounter").textContent), "advanced to case 2");
    const s = store();
    note(s.reviews.length === 4, "レビューが4件でない: " + s.reviews.length);
    note(Object.keys(s.reviewDrafts || {}).length === 0, "保存後も下書きが残っている");
    note(s.comparisons.length === 1, "比較が1件でない: " + s.comparisons.length);
    note(s.comparisons[0].adoptionDecision === "not-applicable", "比較が採用判定外になっていない");
    note(s.comparisons[0].preference === "B", "preference が保存されていない");
    note(!!s.comparisons[0].controlImageId && !!s.comparisons[0].treatmentImageId,
      "比較対象の imageId が保存されていない");
    note(s.conditions.length === 1 && s.conditions[0].imageSeed === "4242",
      "生成条件が内部生成されていない: " + JSON.stringify(s.conditions));
    note(/完了 1 件/.test(byId("abDoneCount").textContent), "完了件数が増えていない");
    note(byId("abCaseState").textContent === "未生成", "次ケースの状態が未生成でない");

    // 2ケース目は生成元を再入力させない
    note(byId("abSetup").hidden === true, "2ケース目で生成元の再入力を求めている");
    note(byId("abBigA").hidden === true && byId("abThumbsA").children.length === 0,
      "次ケースに前ケースの画像が残っている");
    note(byId("abPreference").value === "", "次ケースに前の preference が残っている");

    // 片側だけでも個別レビューを保存できる(採用扱いにしない)
    await pickImage("A", "a2.png", 41);
    reviewSide("A", "reject", "1", "1", "不採用");
    await waitFor(() => !byId("abSaveNext").disabled, "single side enabled");
    note(byId("abSaveNext").textContent === "A の全画像評価を保存する",
      "片側保存の文言が違う: " + byId("abSaveNext").textContent);
    byId("abSaveNext").click();
    await waitS(/片側だけの記録/, "single side saved");
    const s2 = store();
    note(s2.reviews.length === 5, "片側レビューが保存されていない: " + s2.reviews.length);
    note(s2.comparisons.length === 1, "片側なのに比較が作られた: " + s2.comparisons.length);
    const single = s2.reviews[s2.reviews.length - 1];
    note(single.verdict === "reject", "不採用の判定が保存されていない");
    note(byId("abCaseState").textContent === "Aのみ", "片側保存後の状態が Aのみ でない");
    note(/完了 1 件/.test(byId("abDoneCount").textContent), "片側保存が完了扱いになっている");

    // 保存後に書き始めた変更も、再読み込みをまたいで画像単位の下書きとして残る。
    setVal("abRevA_notes", "再読込でも残る下書き");
    note(Object.keys(store().reviewDrafts || {}).length === 1, "再読込前の下書きが端末保存されていない");

    return { pass: problems.length === 0, problems, reviews: s2.reviews.length,
      comparisons: s2.comparisons.length, wide };
  })();
}

// ---------------------------------------------------------------------------
// フェーズ3: 再読込後の復元 + 書き出し互換 + 実験データが漏れない
// ---------------------------------------------------------------------------
function phaseReloadExport(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench restored");

    const s = store();
    note(s.images.length === 5 && s.reviews.length === 5 && s.comparisons.length === 1,
      "再読み込み後に記録が残っていない: " + JSON.stringify({ i: s.images.length, r: s.reviews.length, c: s.comparisons.length }));
    note(!!s.defaultCondition && s.defaultCondition.imageSeed === "4242",
      "生成元が復元されていない");
    note(byId("abSetup").hidden === true, "再読み込み後に生成元の再入力を求めている");
    // 進捗も復元され、未完了ケースから再開する
    note(/完了 1 件/.test(byId("abDoneCount").textContent), "完了件数が復元されていない");
    note(/ケース 2 \/ 2/.test(byId("abCaseCounter").textContent),
      "未完了ケースから再開していない: " + byId("abCaseCounter").textContent);
    await waitFor(() => byId("abThumbsA").querySelectorAll("img").length === 1, "thumbs restored");
    // サムネイルの枠は実体が読めなくても出る。実体の復元は大きい方で見る。
    await waitFor(() => byId("abBigA").hidden === false, "preview restored");
    note(byId("abBigA").src.indexOf("blob:") === 0, "復元したプレビューが Object URL でない");
    await waitFor(() => byId("abRevA_verdict").value === "reject", "review restored");
    note(byId("abRevA_notes").value === "再読込でも残る下書き", "保存前の評価コメントが再読込後に復元されていない");
    note(Object.keys(s.reviewDrafts || {}).length === 1, "保存前の画像別下書きが再読込後に残っていない");

    // 完了ケースへ戻ると比較も復元される
    byId("abPrev").click();
    await waitFor(() => /ケース 1 \/ 2/.test(byId("abCaseCounter").textContent), "back to case 1");
    note(byId("abCaseState").textContent === "完了", "完了ケースの状態が違う");
    await waitFor(() => byId("abPreference").value === "B", "preference restored");
    note(byId("abCompareNotes").value === "顔の意匠が明確になった", "比較コメントが復元されていない");
    await waitFor(() => byId("abRevA_verdict").value === "accept", "case1 selected review restored");
    note(byId("abRevA_notes").value === "A2 まとまりが良い", "選択中画像の評価が復元されていない");

    // 書き出しは R3-FB/R3-FA 互換のまま
    const orig = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return orig.call(URL, b); };
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "reviews exported");
    const rows = (await captured.text()).trim().split("\n").map((l) => JSON.parse(l));
    captured = null;
    byId("abExportComparisons").click();
    await waitS(/書き出しました/, "comparisons exported");
    const cmpRows = (await captured.text()).trim().split("\n").map((l) => JSON.parse(l));
    captured = null;
    byId("abExportCopyList").click();
    await waitS(/書き出しました/, "copy list exported");
    const copyText = await captured.text();
    URL.createObjectURL = orig;

    const rowA = rows.filter((r) => r.experiment.sourceNo === a.no1 && r.experiment.arm === "A")[0];
    const rowB = rows.filter((r) => r.experiment.sourceNo === a.no1 && r.experiment.arm === "B")[0];
    note(rowA.schemaVersion === "persona-prompt-review.v2", "レビューJSONLのスキーマが変わっている");
    note(rowA.source.prompt === a.promptA && rowB.source.prompt === a.promptB,
      "書き出しの本文が変わっている");
    note(rowA.experiment.promptSha256 === a.shaA && rowB.experiment.promptSha256 === a.shaB,
      "書き出しの promptSha256 が変わっている");
    note(rowA.experiment.generationConditions.imageSeed === "4242", "生成条件が書き出しに無い");
    note(rowA.experiment.adoptionDecision === "not-applicable", "書き出しが採用判定外でない");
    note(typeof rowA.images[0].evaluation.aestheticSatisfaction === "string",
      "スコアが v2 の文字列形でない");
    note(rowA.images.length === 2 && rowB.images.length === 2
      && rowA.images.concat(rowB.images).every((im) => !!im.evaluation.verdict
        && !!im.evaluation.aestheticSatisfaction && !!im.evaluation.intentMatch),
      "登録した4画像の評価がすべて書き出されていない");
    note(rowA.images[0].evaluation.failures.indexOf("anatomy") >= 0,
      "切替前画像の失敗分類が書き出されていない");
    note(rowA.comparison.bestImageId === s.comparisons[0].controlImageId,
      "bestImageId が比較対象でない");
    // 片側だけのケースは比較を持たず、順位1位・採用扱いにならない
    const solo = rows.filter((r) => r.experiment.sourceNo === a.no2)[0];
    note(!!solo && solo.comparison.bestImageId === "" && solo.experiment.comparedImageIds === null,
      "片側だけの記録が比較を持っている");
    note(solo.experiment.armPreference === "" && solo.experiment.adoptionDecision === "not-applicable",
      "片側だけの記録が採用扱いになっている");
    note(solo.images[0].evaluation.verdict === "reject", "片側の不採用判定が書き出されていない");
    note(cmpRows.length === 1 && cmpRows[0].adoptionDecision === "not-applicable",
      "比較JSONLが変わっている: " + cmpRows.length);
    note(copyText.split("\n")[0] === "sha256\tarm\tsourceNo\trank\tsourceFileName\ttargetPath",
      "画像コピーリストの見出しが変わっている");
    note(copyText.trim().split("\n").length === 1 + 5, "コピーリストの行数が合わない");

    return { pass: problems.length === 0, problems, reviewRows: rows.length, cmpRows: cmpRows.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ4b: 旧R3-FB受入検査から引き継いだ回帰観点
//   改ざん拒否 / 同一定義の保持 / 定義変更の拒否と承認 / 画像を外す→stale /
//   記録の全削除と生成元への復帰
// ---------------------------------------------------------------------------
function phaseRegression(arg) {
  return (async (a) => {
    __PRELUDE__
    const read = () => JSON.parse(localStorage.getItem(abKey()));
    // [R4F] 実体は保管庫ごとに鍵を前置する。数えるのも「いま開いている保管庫」の分だけ。
    const countBlobsFor = (w) => new Promise((resolve) => {
      const req = indexedDB.open("personaGeneratorAbImages", 1);
      req.onsuccess = () => {
        const d = req.result;
        const tx = d.transaction(["abImagesV1"], "readonly");
        const c = tx.objectStore("abImagesV1").getAllKeys();
        c.onsuccess = () => {
          d.close();
          const keys = (c.result || []).map(String);
          if (!w) { resolve(keys.length); return; }
          if (w.blobKeyMode === "legacyBlobKeys") { resolve(keys.filter((k) => k.indexOf("::") < 0).length); return; }
          resolve(keys.filter((k) => k.indexOf(w.id + "::") === 0).length);
        };
        c.onerror = () => { d.close(); resolve(-1); };
      };
      req.onerror = () => resolve(-1);
    });
    const countBlobs = () => countBlobsFor(activeWsEntry());
    const drop = (pkg, name) => {
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(pkg, null, 2) + "\n"], name, { type: "application/json" }));
      const inp = byId("abFileInput");
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    };

    // 前提: ケース1が4画像で完了、ケース2に A の単独レビューがある状態
    let now = read();
    note(now.images.length === 5 && now.reviews.length === 5 && now.comparisons.length === 1,
      "前提の記録が揃っていない: " + JSON.stringify({ i: now.images.length, r: now.reviews.length, c: now.comparisons.length }));
    const blobsBefore = await countBlobs();
    note(blobsBefore === 5, "前提の画像実体が5件でない: " + blobsBefore);

    // --- (1) 改ざんパッケージは拒否し、読込済みを置換しない ---
    const shownBefore = byId("abPromptA").value;
    drop(a.tampered, "tampered.json");
    await waitFor(() => /使えません/.test(byId("abPackageStatus").textContent), "tampered rejected");
    note(byId("abPromptA").value === shownBefore, "拒否したのに本文が差し替わった");
    note(read().images.length === 5, "拒否したのに記録が変わった");

    // --- (2) 同じ定義(日時だけ違う)の読み直しは記録も実体も保持 ---
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    drop(a.same, "same-definition.json");
    await waitFor(() => /記録はそのまま/.test(byId("abPackageStatus").textContent), "same definition");
    const sameWsId = (activeWsEntry() || {}).id;
    now = read();
    note(now.images.length === 5 && now.reviews.length === 5 && now.comparisons.length === 1
      && now.conditions.length >= 1, "同一定義の読み直しで記録が失われた");
    note(!!now.defaultCondition, "同一定義の読み直しで生成元が失われた");
    note(window.__confirms.length === 0, "同一定義なのに確認を求めた");
    note(await countBlobs() === 5, "同一定義の読み直しで画像実体が消えた");
    note(byId("abWorkbench").hidden === false, "同一定義なのに生成元登録へ戻った");

    // --- (3) 定義変更を拒否すると何も変わらない ---
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return false; };
    drop(a.changed, "changed-definition.json");
    await waitFor(() => /中止しました/.test(byId("abPackageStatus").textContent), "declined");
    note(window.__confirms.length === 1 && /実験定義（本文・設定・方針）が変わって/.test(window.__confirms[0]),
      "定義差の説明が確認文に無い: " + (window.__confirms[0] || ""));
    now = read();
    note(now.images.length === 5 && now.reviews.length === 5 && !!now.defaultCondition,
      "拒否したのに記録が変わった");
    note(await countBlobs() === 5, "拒否したのに画像実体が消えた");
    note(byId("abWorkbench").hidden === false, "拒否したのに画面が戻った");

    // --- (4) [R4F] 承認しても旧記録は消さない。新しい定義には別の保管庫を作る ---
    const oldWs = activeWsEntry();
    const oldKey = oldWs.storeKey;
    const oldRaw = localStorage.getItem(oldKey);
    const oldBlobs = await countBlobsFor(oldWs);
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    drop(a.changed, "changed-definition.json");
    await waitFor(() => /新しい保管庫を作りました/.test(byId("abPackageStatus").textContent), "swapped");
    note(/削除は行いません/.test(window.__confirms[0] || ""),
      "定義変更の確認文が削除しないことを述べていない: " + (window.__confirms[0] || ""));
    const newWs = activeWsEntry();
    note(newWs && newWs.id !== oldWs.id, "定義が変わったのに同じ保管庫のまま");
    now = read();
    note(now.images.length === 0 && now.reviews.length === 0 && now.comparisons.length === 0
      && now.conditions.length === 0 && now.invalidations.length === 0,
      "新しい保管庫に旧記録が入っている");
    note(Object.keys(now.reviewDrafts || {}).length === 0, "新しい保管庫に旧下書きが入っている");
    note(!now.defaultCondition, "新しい保管庫に旧生成元が入っている");
    note(await countBlobsFor(newWs) === 0, "新しい保管庫に画像実体が入っている");
    // 旧保管庫は1バイトも変わらず、実体もそのまま残る
    note(localStorage.getItem(oldKey) === oldRaw, "定義変更で旧保管庫の記録が変わった");
    note(await countBlobsFor(oldWs) === oldBlobs,
      "定義変更で旧保管庫の画像実体が消えた: " + (await countBlobsFor(oldWs)) + " / " + oldBlobs);
    note(abWsIndex().workspaces.some((w) => w.id === oldWs.id), "旧保管庫が索引から消えた");
    note(byId("abSetup").hidden === false && byId("abWorkbench").hidden === true,
      "定義変更後に生成元の登録へ戻っていない");
    note(byId("abProvider").value === "" && byId("abSeed").value === "",
      "定義変更後に前の生成元が入力欄へ残っている");

    // 旧保管庫へ戻すと、記録も実体もそのまま読める(切替は破壊しない)
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "workspace list");
    const back = byId("abWorkspaceList").querySelector('[data-ab-resume="' + oldWs.id + '"]');
    note(!!back, "保存済み一覧に旧実験が出ていない");
    back.click();
    await waitFor(() => (activeWsEntry() || {}).id === oldWs.id, "old workspace resumed");
    await waitFor(() => byId("abWorkbench").hidden === false, "old workbench");
    const restored = read();
    note(restored.images.length === 5 && restored.reviews.length === 5 && restored.comparisons.length === 1,
      "旧保管庫へ戻したのに記録が欠けている: " + JSON.stringify({ i: restored.images.length, r: restored.reviews.length }));
    note(await countBlobsFor(oldWs) === oldBlobs, "旧保管庫へ戻したのに実体が欠けている");
    // 新しい保管庫へ戻る
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "workspace list again");
    byId("abWorkspaceList").querySelector('[data-ab-resume="' + newWs.id + '"]').click();
    await waitFor(() => (activeWsEntry() || {}).id === newWs.id, "new workspace resumed");
    await waitFor(() => byId("abSetup").hidden === false, "setup for new workspace");
    note(read().images.length === 0, "新しい保管庫に記録が混ざった");

    // --- (5) 画像を外すと比較が stale になり、進捗と書き出しから外れる ---
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after preset");
    note(read().defaultCondition.model === "ChatGPT Images UI", "ChatGPT 既定が保存されていない");
    await pickImage("A", "r1.png", 61);
    await pickImage("B", "r2.png", 67);
    reviewSide("A", "hold", "3", "3");
    reviewSide("B", "accept", "4", "4");
    setVal("abPreference", "B");
    await waitFor(() => !byId("abSaveNext").disabled, "ready to save");
    byId("abSaveNext").click();
    await waitFor(() => read().comparisons.length === 1, "comparison saved");
    note(/完了 1 件/.test(byId("abDoneCount").textContent), "完了件数が増えていない");

    byId("abPrev").click();
    await waitFor(() => byId("abCaseState").textContent === "完了", "back to completed case");
    note(byId("abRemoveA").hidden === false, "「この画像を外す」が出ていない");
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    byId("abRemoveA").click();
    await waitS(/画像を外しました/, "image removed");
    note(window.__confirms.length === 1 && /外しますか/.test(window.__confirms[0]),
      "外すときに確認していない");
    now = read();
    note(now.invalidations.length === 1, "無効化が append-only で記録されていない");
    note(now.images.length === 2, "画像行が物理削除された: " + now.images.length);
    note(byId("abCaseState").textContent !== "完了",
      "外したのに完了のまま: " + byId("abCaseState").textContent);
    note(/完了 0 件/.test(byId("abDoneCount").textContent),
      "stale 比較が進捗に数えられている: " + byId("abDoneCount").textContent);

    const orig = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId("abExportComparisons").click();
    await delay(500);
    note(/書き出す記録がまだありません/.test(st()),
      "stale 比較が比較JSONLへ出ている: " + st());
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "reviews exported");
    const reviewRows = (await captured.text()).trim().split("\n").map((l) => JSON.parse(l));
    URL.createObjectURL = orig;
    const ids = reviewRows.reduce((acc, r) => acc.concat(r.images.map((im) => im.imageId)), []);
    note(ids.indexOf(now.invalidations[0].imageId) < 0, "外した画像が書き出しに残っている");
    note(reviewRows.every((r) => r.comparison.bestImageId === ""),
      "stale 比較が bestImageId に出ている");

    // --- (6) [R4F] 削除は「開いている実験だけ」。ほかの保管庫は索引にも記録にも残る ---
    const doomed = activeWsEntry();
    const doomedKey = doomed.storeKey;
    window.__confirms = [];
    window.confirm = (m) => { window.__confirms.push(String(m)); return true; };
    byId("abClear").click();
    await waitFor(() => byId("abWorkspaces").hidden === false && !abWsIndex().activeId, "workspace deleted");
    note(/ほかの保存済み実験は削除されません/.test(window.__confirms[0] || ""),
      "削除の確認文がほかの実験を守ると述べていない: " + (window.__confirms[0] || ""));
    note(localStorage.getItem(doomedKey) === null, "削除した保管庫の記録が残っている");
    note(await countBlobsFor(doomed) === 0, "削除した保管庫の画像実体が残っている");
    note(!abWsIndex().workspaces.some((w) => w.id === doomed.id), "削除した保管庫が索引に残っている");
    note(abWsIndex().workspaces.some((w) => w.id === oldWs.id), "ほかの保管庫まで索引から消えた");
    note(localStorage.getItem(oldKey) === oldRaw, "ほかの保管庫の記録が削除で変わった");
    note(await countBlobsFor(oldWs) === oldBlobs, "ほかの保管庫の画像実体が削除で消えた");

    // --- (7) 公称上限のA/B各5枚でも、10枚すべてを保持・保存できる ---
    drop(a.changed, "changed-definition.json");
    await waitFor(() => /新しい保管庫を作りました/.test(byId("abPackageStatus").textContent), "reloaded after delete");
    await waitFor(() => byId("abSetup").hidden === false, "setup after reload");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench for max images");
    for (let i = 1; i <= 5; i += 1) {
      await pickImage("A", "max-a" + i + ".png", 100 + i);
      reviewSide("A", i % 2 ? "accept" : "hold", String((i % 5) + 1), String(((i + 1) % 5) + 1), "A" + i);
      await pickImage("B", "max-b" + i + ".png", 120 + i);
      reviewSide("B", i % 2 ? "hold" : "accept", String(((i + 2) % 5) + 1), String(((i + 3) % 5) + 1), "B" + i);
    }
    await delay(150);
    now = read();
    note(now.images.length === 10 && Object.keys(now.reviewDrafts || {}).length === 10,
      "上限10画像の入力が保持されていない: " + JSON.stringify({ images: now.images.length, drafts: Object.keys(now.reviewDrafts || {}).length }));
    note(byId("abThumbsA").querySelectorAll("img").length === 5
      && byId("abThumbsB").querySelectorAll("img").length === 5, "A/B各5枚のサムネイルが出ていない");
    await pickImage("A", "max-a6.png", 199);
    note(/上限/.test(st()) && read().images.length === 10, "6枚目が上限で拒否されていない");
    setVal("abPreference", "tie");
    await waitFor(() => !byId("abSaveNext").disabled, "max images ready");
    note(byId("abSaveNext").textContent === "全10枚の評価と比較を保存して次へ",
      "上限時の保存対象枚数が明示されていない: " + byId("abSaveNext").textContent);
    byId("abSaveNext").click();
    await waitFor(() => read().reviews.length === 10 && read().comparisons.length === 1, "max images saved");
    now = read();
    note(Object.keys(now.reviewDrafts || {}).length === 0, "上限10画像の保存後に下書きが残っている");
    byId("abPrev").click();
    await waitFor(() => byId("abThumbsA").querySelectorAll("img").length === 5, "max case restored");

    return { pass: problems.length === 0, problems, blobsBefore, maxImages: now.images.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ4: iPhoneの主要画面幅・横向きで崩れない
// ---------------------------------------------------------------------------
function phaseMobile(spec) {
  return (async (a) => {
    __PRELUDE__
    byId("abTab").click();
    await delay(600);
    const label = a.label;
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note(overflow <= 1, label + " で横溢れしている: " + overflow + "px");
    const view = byId("abView");
    const wide = [];
    view.querySelectorAll("*").forEach((n) => {
      if (n.scrollWidth > document.documentElement.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, label + " で画面幅より広い要素がある: " + wide.slice(0, 5).join(", "));
    note(byId("abThumbsA").querySelectorAll("img").length === 5
      && byId("abThumbsB").querySelectorAll("img").length === 5,
      label + " で上限5枚のサムネイルが欠けている");
    // 比較画像が極端に縮まない(縦並びで幅を確保する)。直前フェーズの上限5枚状態で測る。
    if (byId("abSetup").hidden === false) {
      byId("abSetupChatgpt").click();
      await waitFor(() => byId("abWorkbench").hidden === false, "workbench for mobile");
    }
    if (byId("abBigA").hidden) await pickImage("A", "m1.png", 71);
    await waitFor(() => byId("abBigA").hidden === false && byId("abBigA").naturalWidth > 0,
      "big image decoded");
    const imageRect = byId("abBigA").getBoundingClientRect();
    const minImageRatio = viewportWidth < 720 ? 0.6 : 0.35;
    note(imageRect.width >= viewportWidth * minImageRatio,
      label + " で比較画像が小さすぎる: " + Math.round(imageRect.width) + "px");
    if (viewportWidth >= 720) {
      const copyA = byId("abCopyA").getBoundingClientRect();
      const copyB = byId("abCopyB").getBoundingClientRect();
      const dropA = byId("abDropA").getBoundingClientRect();
      const dropB = byId("abDropB").getBoundingClientRect();
      note(Math.abs(copyA.top - copyB.top) <= 1,
        label + " でA/Bの操作上端がずれている");
      note(Math.abs(dropA.top - dropB.top) <= 1,
        label + " でA/Bの画像登録欄がずれている");
    }
    // 主要操作が押せる
    ["abPrev", "abNext", "abJumpIncomplete", "abSaveNext", "abCopyA", "abCopyB"].forEach((id) => {
      const r = byId(id).getBoundingClientRect();
      note(r.width > 0 && r.height >= 44, label + " の " + id + " が44px未満: " + JSON.stringify({ w: r.width, h: r.height }));
    });
    ["abProvider", "abModel", "abSeedSupport", "abSeed"].forEach((id) => {
      const fontSize = parseFloat(getComputedStyle(byId(id)).fontSize);
      note(fontSize >= 16, label + " の " + id + " がiOSズームを招く文字サイズ: " + fontSize + "px");
    });
    return {
      pass: problems.length === 0,
      problems,
      label,
      overflow,
      viewportWidth,
      bigWidth: Math.round(byId("abBigA").getBoundingClientRect().width)
    };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// フェーズ5: 既存 PCEXPORT レビュー機能が壊れていないこと
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
    const n = byId("reviewImages");
    n.files = await files("legacy.png", 31);
    n.dispatchEvent(new Event("change", { bubbles: true }));
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
    note(!!localStorage.getItem(abKey()), "A/B側の保存が消えている");

    return { pass: problems.length === 0, problems, legacySchema: legacy.schemaVersion };
  })();
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const pkg = buildFixturePackage();
  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fc-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r3fc-dl-"));
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

    const loaded = await run(phaseLoad, "package load, one-time source, collapsed body", pkg);
    const worked = await run(phaseWorkbench, "drop-to-register, inline review, save-and-next");

    await client.send("Page.reload", { ignoreCache: false }, sessionId);
    await wait(2000);
    const c0 = pkg.cases[0];
    const reloaded = await run(phaseReloadExport, "reload restore and export compatibility", {
      no1: c0.sourceNo, no2: pkg.cases[1].sourceNo,
      promptA: c0.arms.A.prompt, promptB: c0.arms.B.prompt,
      shaA: c0.arms.A.promptSha256, shaB: c0.arms.B.promptSha256
    });

    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.cases[0].arms.B.prompt += "改ざん";
    const same = derivePackage(pkg, { generatedAt: "2027-05-06T07:08:09.000Z" });
    const changed = derivePackage(pkg, {
      mutate: (p) => {
        p.cases[0].arms.B.prompt += "\n追記された行";
        p.cases[0].arms.B.promptSha256 = sha(p.cases[0].arms.B.prompt);
      }
    });
    const regressed = await run(phaseRegression, "tamper/definition/removal/clear regressions",
      { tampered, same, changed });

    const iphoneSpecs = [
      { label: "iPhone 320 portrait", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375 portrait", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390 portrait", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430 portrait", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone landscape", width: 844, height: 390, deviceScaleFactor: 3, mobile: true },
    ];
    const mobileResults = [];
    for (const spec of iphoneSpecs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      mobileResults.push(await run(phaseMobile, spec.label + " layout", spec));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(500);

    const legacy = await run(phaseLegacy, "existing PCEXPORT review flow");

    const leftovers = fs.readdirSync(downloadDir).filter((f) => f.indexOf("facial-fusion-ab-") === 0);
    if (leftovers.length) fail("unexpected downloads landed on disk", leftovers);

    console.log("R3-FC COMPARISON WORKBENCH BROWSER ACCEPTANCE PASSED");
    console.log(`  3 tabs intact | package loaded, source recorded once, body collapsed (${loaded.promptBytes}B kept byte-exact on copy)`);
    console.log(`  picking or dropping an image registers it immediately and shows it side by side (desktop 2-col: ${worked.wide})`);
    console.log(`  required fields gate the single action; it wrote ${worked.reviews} reviews + ${worked.comparisons} comparison and advanced`);
    console.log(`  one-sided case saved a standalone reject review without any comparison or rank-1 meaning`);
    console.log(`  reload restored source/images/reviews/comparison/progress and resumed at the incomplete case`);
    console.log(`  exports unchanged: ${reloaded.reviewRows} review rows (v2) + ${reloaded.cmpRows} comparison row + copy list`);
    console.log(`  tampered package refused without replacing the loaded one; same definition kept ${regressed.blobsBefore} blobs`);
    console.log(`  declined swap changed nothing; approved swap created a separate workspace and left the old records+blobs intact (switch back and forth verified)`);
    console.log(`  removing an image made the comparison stale: dropped from progress and both exports`);
    console.log(`  deleting the open experiment removed only its records and blobs; every other workspace stayed in the index unchanged`);
    console.log(`  public maximum covered: ${regressed.maxImages} images (A/B 5 each) retained, gated, saved, and rendered on every viewport`);
    console.log(`  iPhone matrix passed: ${mobileResults.map((m) => `${m.viewportWidth}px overflow ${m.overflow}px/image ${m.bigWidth}px`).join(" | ")}; controls >=44px`);
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
