#!/usr/bin/env node
// [R4F] 実験ワークスペースの移行・切替・案内付き専用入口・単一導線の**実ブラウザ**受入検査。
//  合成フィクスチャのみを使い、実験の実データ・本文・IDは一切含まない。
//
//  確かめること:
//   R4F より前の「唯一の保管庫」(画像12件・実体12件)がそのままの意味で移行される ->
//   何度読み込み直しても移行結果が変わらない(冪等) ->
//   通常の入口では再開した実験の身元が画面の先頭に出る ->
//   ?ab=new-guided は保存済みを1件も操作せず、選択画面だけを出す ->
//   その画面には「見えていて押せる本文コピー」も「見えていて使える画像入力」も0個 ->
//   案内付きでないパッケージは拒否され、保存済みは変わらない ->
//   案内付きパッケージは開始確認を経てから作業台へ入り、旧保管庫は消えない ->
//   生成中はどの手順でも本文コピー1個・画像入力1個ちょうど。ほかは隠して無効化して
//     キーボードからも触れない ->
//   コピーは今の手順の本文ちょうど。手動コピー欄も同じ本文 ->
//   保管庫の切替・保存済み定義の不一致・本文ハッシュの不一致では登録を断り、
//     ファイルはどこにも割り当てられず手順も進まない ->
//   旧保管庫へ戻すと記録も実体もそのまま読める。案内付きへ戻すと進捗が独立して戻る ->
//   再読み込みは「明示的に開いている実験」だけを復元する ->
//   移行の保存に失敗したら閉じ、移行前の記録はそのまま残る ->
//   N-1 では評価画面が出ず、ちょうど N で生成完了の画面になる ->
//   デスクトップとiPhone各幅で横溢れ0・44px操作領域・入力は16px以上。
//
//  使い捨てプロファイルのみ。外部ネットワークへは出ない。
//  長い工程は標準エラーへ心拍(現在の工程・完了/全体・経過)を出す。
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
// 心拍。長い工程でも「止まったのか、進んでいるのか」を外から見分けられるようにする。
// ---------------------------------------------------------------------------
const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + "s"; }
let beat = null;
let beatState = { phase: "起動", done: 0, total: 0, last: "-" };
function startHeartbeat() {
  beat = setInterval(() => {
    process.stderr.write(`  [heartbeat] ${beatState.phase}`
      + (beatState.total ? ` ${beatState.done}/${beatState.total}` : "")
      + ` elapsed=${elapsed()} last=${beatState.last}\n`);
  }, 15000);
  if (beat.unref) beat.unref();
}
function stopHeartbeat() { if (beat) { clearInterval(beat); beat = null; } }

// 合成フィクスチャは受入検査と公開反映の確認で共有する(片方だけ古くならないようにする)。
const { buildStalePackage, buildGuidedPackage, buildStaleStore } = require("./_r4f_fixtures.cjs");

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abGuidedMsg")||{}).textContent||"")
      + " / " + ((document.getElementById("abPackageStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abWorkspacesStatus")||{}).textContent||""));
  };
  const byId = (id) => document.getElementById(id);
  const problems = [];
  const note = (c, m) => { if (!c) problems.push(m); };
  const st = () => (byId("abStatus") || {}).textContent || "";

  const WS_INDEX_KEY = "personaGenerator.abWorkspaces.v1";
  const LEGACY_STORE_KEY = "personaGenerator.abExperiment.v1";
  const idx = () => { try { return JSON.parse(localStorage.getItem(WS_INDEX_KEY)); } catch (_) { return null; } };
  const wsOf = (id) => { const i = idx(); return i ? (i.workspaces || []).filter((w) => w.id === id)[0] || null : null; };
  const activeWs = () => { const i = idx(); return i && i.activeId ? wsOf(i.activeId) : null; };
  const storeKeyOf = (w) => (w ? w.storeKey : LEGACY_STORE_KEY);
  const rawOf = (w) => localStorage.getItem(storeKeyOf(w));
  const storeOf = (w) => { const r = rawOf(w); return r ? JSON.parse(r) : null; };
  const store = () => storeOf(activeWs());
  const legacyRaw = () => localStorage.getItem(LEGACY_STORE_KEY);
  const blobKeyFor = (w, imageId) =>
    (!w || w.blobKeyMode === "legacyBlobKeys") ? String(imageId) : w.id + "::" + String(imageId);

  const IMG_DB = "personaGeneratorAbImages", IMG_STORE = "abImagesV1";
  const withStore = (mode, fn) => new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(IMG_DB, 1); } catch (_) { resolve(null); return; }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(IMG_STORE)) d.createObjectStore(IMG_STORE, { keyPath: "imageId" });
    };
    req.onsuccess = (e) => {
      const d = e.target.result;
      let tx;
      try { tx = d.transaction([IMG_STORE], mode); } catch (_) { d.close(); resolve(null); return; }
      const r = fn(tx.objectStore(IMG_STORE));
      tx.oncomplete = () => { d.close(); resolve(r && r.result !== undefined ? r.result : true); };
      tx.onerror = () => { d.close(); resolve(null); };
    };
  });
  const allBlobKeys = () => withStore("readonly", (s) => s.getAllKeys()).then((k) => (k || []).map(String));
  const getBlobSize = (w, imageId) => withStore("readonly", (s) => s.get(blobKeyFor(w, imageId)))
    .then((v) => (v && v.blob ? v.blob.size : -1));

  const makePng = (seed) => new Promise((resolve) => {
    const cv = document.createElement("canvas");
    cv.width = 40; cv.height = 30;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "rgb(" + (seed % 256) + "," + ((seed * 7) % 256) + "," + ((seed * 13) % 256) + ")";
    ctx.fillRect(0, 0, 40, 30);
    ctx.fillRect(seed % 20, seed % 10, 3, 3);
    cv.toBlob(resolve, "image/png");
  });
  const oneFile = async (name, seed) => {
    const blob = await makePng(seed);
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: "image/png" }));
    return dt.files;
  };
  const loadPkg = (pkg, name) => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(pkg, null, 2) + "\\n"], name, { type: "application/json" }));
    const input = byId("abFileInput");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // ---- 見えていて操作できる部品の機械的な数え上げ -------------------------
  const isVisible = (n) => !!n && n.getClientRects().length > 0;
  const isEnabled = (n) => !!n && n.disabled !== true;
  const abNodes = (sel) => Array.prototype.slice.call(byId("abView").querySelectorAll(sel));
  const copyControls = () => abNodes("button").filter((b) => /コピー/.test(b.textContent || ""));
  const imageInputs = () => abNodes('input[type="file"]')
    .filter((i) => String(i.accept || "").indexOf("image") >= 0);
  const liveCopyControls = () => copyControls().filter((n) => isVisible(n) && isEnabled(n));
  const liveImageInputs = () => imageInputs().filter((n) => isVisible(n) && isEnabled(n));
  const focusable = (n) => {
    if (!n || n.disabled === true) return false;
    if (n.getAttribute("tabindex") === "-1") return false;
    if (!isVisible(n)) return false;
    let p = n;
    while (p) { if (p.inert === true || p.getAttribute && p.getAttribute("aria-hidden") === "true") return false; p = p.parentElement; }
    return true;
  };
  const lockedOut = (id) => {
    const n = byId(id);
    if (!n) return true;
    return !isVisible(n) && !focusable(n);
  };

  const gTarget = () => (byId("abGuidedTarget")||{}).textContent || "";
  const gProgress = () => (byId("abGuidedProgress")||{}).textContent || "";
  const gMsg = () => (byId("abGuidedMsg")||{}).textContent || "";
  const parseTarget = () => {
    const m = gTarget().match(/ケース\\s*([A-Z]+-\\d+)・([AB])・(\\d+)枚目/);
    return m ? { caseId: m[1], slot: m[2], rank: Number(m[3]) } : null;
  };
  const imagesOf = () => ((store() || {}).images || []);
  const guidedPut = async (name, seed) => {
    const before = imagesOf().length;
    byId("abGuidedMsg").textContent = "";
    const n = byId("abGuidedFile");
    n.files = await oneFile(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => imagesOf().length !== before || gMsg() !== "", "guided put " + name);
    await delay(90);
  };
  const startConfirmed = async () => {
    await waitFor(() => byId("abConfirm").hidden === false, "confirm card");
    byId("abConfirmStart").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after confirm");
    await delay(120);
  };
  const openAbTab = async () => {
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    await delay(250);
  };
`;

// ---------------------------------------------------------------------------
// 1: R4F より前の保管庫を仕込む(索引を作らない = 移行前の状態)
// ---------------------------------------------------------------------------
function phaseSeedStale(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    localStorage.removeItem(WS_INDEX_KEY);
    localStorage.setItem(LEGACY_STORE_KEY, a.raw);
    // 実体は「移行前の鍵」= imageId そのまま で置く
    for (const row of a.images) {
      const blob = await makePng(row.seed);
      await withStore("readwrite", (s) => s.put({ imageId: row.imageId, blob, updatedAt: "2026-08-09T01:00:00.000Z" }));
    }
    const keys = await allBlobKeys();
    note(keys.length === a.images.length, "仕込んだ実体の件数が違う: " + keys.length);
    note(keys.every((k) => k.indexOf("::") < 0), "仕込んだ実体に名前空間が付いている");
    note(legacyRaw() === a.raw, "仕込んだ記録が一致しない");
    note(idx() === null, "移行前なのに索引がある");
    return { pass: problems.length === 0, problems, blobs: keys.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 2: 通常の入口 —— 移行して再開し、記録も実体も意味を変えない
// ---------------------------------------------------------------------------
function phaseMigrate(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after migration");
    const i = idx();
    note(!!i && i.schemaVersion === "persona-ab-workspaces.v1", "索引が作られていない");
    note(i.workspaces.length === 1, "保管庫が1つでない: " + i.workspaces.length);
    const w = activeWs();
    note(!!w, "開いている保管庫が無い");
    note(w.experimentId === a.experimentId, "保管庫の実験IDが違う: " + w.experimentId);
    note(w.definitionSha256 === a.definitionSha256, "保管庫の定義ハッシュが違う");
    note(w.blobKeyMode === "legacyBlobKeys", "移行した保管庫の実体の鍵が変わっている: " + w.blobKeyMode);
    note(w.workflow === "legacy", "移行した保管庫の種別が違う: " + w.workflow);
    note(!!w.confirmedAt, "移行した保管庫が確認待ちになっている");
    // 移行前のキーは1バイトも変えずに残す(移行前へ戻せる控え)
    note(legacyRaw() === a.raw, "移行前の保管庫が書き換えられた");
    // 記録は意味を変えずに移る
    const s = store();
    note(JSON.stringify(s.images) === JSON.stringify(a.expect.images), "画像の記録が変わった");
    note(JSON.stringify(s.reviews) === JSON.stringify(a.expect.reviews), "評価の記録が変わった");
    note(JSON.stringify(s.comparisons) === JSON.stringify(a.expect.comparisons), "比較の記録が変わった");
    note(JSON.stringify(s.conditions) === JSON.stringify(a.expect.conditions), "生成条件の記録が変わった");
    note(JSON.stringify(s.pkg) === JSON.stringify(a.expect.pkg), "パッケージが変わった");
    // 実体はそのまま読める
    const sizes = [];
    for (const row of a.expect.images) sizes.push(await getBlobSize(w, row.imageId));
    note(sizes.every((n) => n > 0), "移行後に読めない実体がある: " + JSON.stringify(sizes));
    const keys = await allBlobKeys();
    note(keys.length === a.expect.images.length, "移行で実体の件数が変わった: " + keys.length);
    // 再開している実験の身元が画面の先頭に出る
    note(byId("abIdentity").hidden === false, "身元パネルが出ていない");
    const idText = byId("abIdentityId").textContent;
    note(idText.indexOf(a.experimentId) >= 0, "身元パネルの実験IDが違う: " + idText);
    note(/再開/.test(byId("abIdentityState").textContent), "再開と表示されていない: "
      + byId("abIdentityState").textContent);
    note(/登録画像 12 件/.test(byId("abIdentityProgress").textContent),
      "身元パネルの進捗が違う: " + byId("abIdentityProgress").textContent);
    const identityTop = byId("abIdentity").getBoundingClientRect().top;
    const workTop = byId("abWork").getBoundingClientRect().top;
    note(identityTop < workTop, "身元パネルが本文・画像の操作より下にある");
    note(byId("abSwitchExperiment").getBoundingClientRect().height >= 44, "切替ボタンが44px未満");
    return { pass: problems.length === 0, problems, workspaceId: w.id, storeKey: w.storeKey,
      images: s.images.length, reviews: s.reviews.length, blobs: keys.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 3: 移行は冪等 —— 何度読み直しても索引も記録も実体も変わらない
// ---------------------------------------------------------------------------
function phaseIdempotent(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    const i = idx();
    note(i.workspaces.length === 1, "読み直しで保管庫が増えた: " + i.workspaces.length);
    note(i.activeId === a.workspaceId, "読み直しで開く保管庫が変わった: " + i.activeId);
    note(i.legacyMigratedAt === a.migratedAt, "移行時刻が上書きされた");
    note(rawOf(activeWs()) === a.storeRaw, "読み直しで記録が変わった");
    note(legacyRaw() === a.raw, "読み直しで移行前の控えが変わった");
    const keys = await allBlobKeys();
    note(keys.length === a.blobs, "読み直しで実体の件数が変わった: " + keys.length);
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 4: 案内付き専用の入口 —— 保存済みを操作せず、選択画面だけを出す
// ---------------------------------------------------------------------------
function phaseCleanEntry(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    await waitFor(() => byId("abView").hidden === false, "ab view auto-opened");
    await delay(300);
    note(byId("abWorkbench").hidden === true, "案内付き入口で作業台が開いている");
    note(byId("abIdentity").hidden === true, "案内付き入口で前の実験の身元が出ている");
    note(byId("abConfirm").hidden === true, "案内付き入口で開始確認が出ている");
    note(byId("abWorkspaces").hidden === false, "保存済み実験の一覧が出ていない");
    note(byId("abIntro").hidden === false, "パッケージ読み込みの導線が出ていない");
    // 見えていて押せる本文コピーも、見えていて使える画像入力も0個
    note(liveCopyControls().length === 0, "案内付き入口に本文コピーが出ている: " + liveCopyControls().length);
    note(liveImageInputs().length === 0, "案内付き入口に画像入力が出ている: " + liveImageInputs().length);
    ["abPromptA", "abPromptB", "abGuidedPrompt", "abPrev", "abNext", "abJumpIncomplete",
      "abSaveNext", "abPreference", "abReviewA", "abReviewB", "abClear"].forEach((id) => {
      note(lockedOut(id), "案内付き入口で " + id + " が使える");
    });
    // 保存済みは1件も変わっていない
    note(rawOf(wsOf(a.workspaceId)) === a.storeRaw, "案内付き入口で保存済みの記録が変わった");
    note(legacyRaw() === a.raw, "案内付き入口で移行前の控えが変わった");
    note(idx().activeId === a.workspaceId, "案内付き入口で開いている実験が変わった");
    const keys = await allBlobKeys();
    note(keys.length === a.blobs, "案内付き入口で実体の件数が変わった: " + keys.length);
    // 一覧には保存済みが出て、再開できる
    const resume = byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.workspaceId + '"]');
    note(!!resume, "保存済み実験に再開の導線が無い");
    note(/画像 12 件/.test(byId("abWorkspaceList").textContent), "一覧に保存件数が出ていない: "
      + byId("abWorkspaceList").textContent.slice(0, 160));
    note(/既存データを保管して新しい実験を開始/.test(byId("abStartNewExperiment").textContent),
      "新規開始の文言が違う: " + byId("abStartNewExperiment").textContent);
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 5: 案内付き入口は案内付きでないパッケージを受け取らない
// ---------------------------------------------------------------------------
function phaseRefuseLegacyPackage(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => { problems.push("拒否されるはずの読み込みで確認ダイアログが出た"); return false; };
    const beforeIndex = localStorage.getItem(WS_INDEX_KEY);
    loadPkg(a.pkg, "stale-again.json");
    await waitFor(() => /案内付き生成パッケージではありません/.test(byId("abPackageStatus").textContent),
      "legacy package refused");
    note(byId("abWorkbench").hidden === true, "拒否したのに作業台が開いた");
    note(byId("abWorkspaces").hidden === false, "拒否したのに選択画面から出た");
    note(localStorage.getItem(WS_INDEX_KEY) === beforeIndex, "拒否で索引が変わった");
    note(rawOf(wsOf(a.workspaceId)) === a.storeRaw, "拒否で保存済みの記録が変わった");
    note(liveCopyControls().length === 0 && liveImageInputs().length === 0,
      "拒否のあとに操作が開いた");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 6: 案内付きパッケージ —— 開始確認を経てから作業台へ。旧保管庫は消えない
// ---------------------------------------------------------------------------
function phaseConfirmAndStart(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => { problems.push("新しい実験の開始で削除の確認が出た"); return true; };
    loadPkg(a.pkg, "guided-r4f.json");
    await waitFor(() => byId("abConfirm").hidden === false, "confirm card");
    note(byId("abWorkbench").hidden === true, "確認前に作業台が開いている");
    note(liveCopyControls().length === 0, "確認前に本文コピーが押せる: " + liveCopyControls().length);
    note(liveImageInputs().length === 0, "確認前に画像入力が使える: " + liveImageInputs().length);
    const facts = byId("abConfirmFacts").textContent;
    note(/fixture-guided-r4f/.test(facts), "確認カードに実験IDが無い: " + facts);
    note(/2 件/.test(facts), "確認カードにケース数が無い: " + facts);
    note(/8 枚/.test(facts), "確認カードに必要枚数が無い: " + facts);
    note(/合成モデルUI/.test(facts) && /固定/.test(facts), "確認カードに固定の生成条件が無い: " + facts);
    note(/合成 案内付き実験/.test(byId("abConfirmTitle").textContent),
      "確認カードの表題が違う: " + byId("abConfirmTitle").textContent);
    // 旧保管庫はこの時点でも無傷
    note(rawOf(wsOf(a.staleId)) === a.staleRaw, "確認の時点で旧保管庫が変わった");
    byId("abConfirmStart").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after confirm");
    await delay(200);
    const i = idx();
    note(i.workspaces.length === 2, "保管庫が2つになっていない: " + i.workspaces.length);
    note(i.activeId !== a.staleId, "旧保管庫を開いたままになっている");
    note(rawOf(wsOf(a.staleId)) === a.staleRaw, "新しい実験の開始で旧保管庫が変わった");
    const keys = await allBlobKeys();
    note(keys.length === a.blobs, "新しい実験の開始で実体の件数が変わった: " + keys.length);
    note(byId("abIdentity").hidden === false, "身元パネルが出ていない");
    note(/案内付き生成/.test(byId("abIdentityKind").textContent), "種別表示が違う: "
      + byId("abIdentityKind").textContent);
    note(/画像生成 0 \/ 8/.test(byId("abIdentityProgress").textContent),
      "進捗表示が違う: " + byId("abIdentityProgress").textContent);
    // URL から案内付き入口の指定が外れる(次の再読み込みはこの実験を復元する)
    note(location.search.indexOf("ab=new-guided") < 0, "開始後も案内付き入口の指定が残っている: " + location.search);
    return { pass: problems.length === 0, problems, guidedId: i.activeId, guidedKey: activeWs().storeKey };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 7: 生成中は「本文コピー1個・画像入力1個」ちょうど。ほかは触れない
// ---------------------------------------------------------------------------
function phaseSingleTask(arg) {
  return (async (a) => {
    __PRELUDE__
    const expected = [
      ["GD-01","A",1],["GD-01","A",2],["GD-01","B",1],["GD-01","B",2],
      ["GD-02","A",1],["GD-02","A",2],["GD-02","B",1],["GD-02","B",2]
    ];
    const HIDDEN_IDS = ["abCopyA","abCopyB","abCopySettingsA","abCopySettingsB","abPromptA","abPromptB",
      "abFileA","abFileB","abDropA","abDropB","abRemoveA","abRemoveB","abReviewA","abReviewB",
      "abPrev","abNext","abJumpIncomplete","abPreference","abCompareNotes","abSaveNext",
      "abExportReviews","abExportComparisons","abExportCopyList","abLoadResamplePlan",
      "abEditCondition","abLoadAnother","abClear"];
    const counts = [];
    for (let i = 0; i < expected.length; i += 1) {
      const t = parseTarget();
      note(t && t.caseId === expected[i][0] && t.slot === expected[i][1] && t.rank === expected[i][2],
        "手順" + (i + 1) + " の目標が違う: " + JSON.stringify(t));
      const copies = liveCopyControls();
      const inputs = liveImageInputs();
      counts.push(copies.length + "/" + inputs.length);
      note(copies.length === 1, "手順" + (i + 1) + " で押せる本文コピーが " + copies.length + " 個");
      note(copies[0] && copies[0].id === "abGuidedCopy",
        "手順" + (i + 1) + " の本文コピーが案内カードのものでない: " + (copies[0] || {}).id);
      note(inputs.length === 1, "手順" + (i + 1) + " で使える画像入力が " + inputs.length + " 個");
      note(inputs[0] && inputs[0].id === "abGuidedFile",
        "手順" + (i + 1) + " の画像入力が案内カードのものでない: " + (inputs[0] || {}).id);
      note(inputs[0] && (inputs[0].multiple !== true), "案内カードの画像入力が複数選択を受け付ける");
      // キーボード・支援技術から辿れるのも「1つの本文コピー」と「1つの画像登録先」だけ
      const reachable = abNodes('button, input, select, textarea, a[href], summary, [tabindex]')
        .filter(focusable);
      //  コピーを「行う」部品だけを数える。読み取り専用の本文欄とその開閉見出しは
      //  R4E が要求した手動コピーの受け皿で、別のコピー操作ではない。
      const reachableCopy = reachable.filter((n) => (n.tagName === "BUTTON" || n.tagName === "A")
        && /コピー/.test(n.textContent || n.getAttribute("aria-label") || ""));
      const reachableFile = reachable.filter((n) => n.tagName === "INPUT" && n.type === "file"
        && String(n.accept || "").indexOf("image") >= 0);
      note(reachableCopy.length === 1 && reachableCopy[0].id === "abGuidedCopy",
        "手順" + (i + 1) + " で辿れる本文コピーが " + reachableCopy.length + " 個: "
        + reachableCopy.map((n) => n.id).join(","));
      note(reachableFile.length === 1 && reachableFile[0].id === "abGuidedFile",
        "手順" + (i + 1) + " で辿れる画像登録先が " + reachableFile.length + " 個: "
        + reachableFile.map((n) => n.id).join(","));
      note((reachableFile[0].getAttribute("aria-label") || "").length > 0,
        "画像登録先に名前が無い");
      note((reachableCopy[0].textContent || "").length > 0, "本文コピーに名前が無い");
      note(byId("abGuidedPrompt").readOnly === true, "手動コピー欄が編集できる(辿れる経路)");
      note(reachable.every((n) => HIDDEN_IDS.indexOf(n.id) < 0),
        "手順" + (i + 1) + " で閉じたはずの操作が辿れる: "
        + reachable.filter((n) => HIDDEN_IDS.indexOf(n.id) >= 0).map((n) => n.id).join(","));
      HIDDEN_IDS.forEach((id) => {
        note(lockedOut(id), "手順" + (i + 1) + " で " + id + " が見える/押せる");
      });
      // 評価の導線は生成中に一切出ない
      note(byId("abVerdictCard").hidden === true, "生成中に比較カードが出ている");
      note(byId("abWork").hidden === true, "生成中にA/B作業台が出ている");
      note(byId("abHeader").hidden === true, "生成中にケース移動が出ている");
      note(!/勝ち|優劣|順位1|採用/.test(byId("abGuided").textContent), "生成中に順位・採用の語が出ている");
      // 本文コピーは今の手順の本文ちょうど
      let copied = null;
      const realClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
        || Object.getOwnPropertyDescriptor(navigator, "clipboard");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true, value: { writeText: (x) => { copied = x; return Promise.resolve(); } }
      });
      byId("abGuidedCopy").click();
      await waitFor(() => copied !== null, "copy step " + (i + 1));
      if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
      else delete navigator.clipboard;
      const want = a.prompts[expected[i][0] + expected[i][1]];
      note(copied === want, "手順" + (i + 1) + " のコピー本文が違う");
      note(byId("abGuidedPrompt").value === want, "手順" + (i + 1) + " の手動コピー欄が本文と違う");
      note(byId("abGuidedPrompt").readOnly === true, "手動コピー欄が編集できる");
      // 1枚登録すると、保存が終わってから次の手順へ進む
      await guidedPut("g" + (i + 1) + ".png", 300 + i);
      const rows = imagesOf();
      note(rows.length === i + 1, "手順" + (i + 1) + " で画像数が " + rows.length);
      const last = rows[rows.length - 1];
      note(last.caseKey === "p" + Number(expected[i][0].slice(3)) && last.arm === expected[i][1]
        && last.rank === expected[i][2] && last.guidedSequence === i + 1,
        "手順" + (i + 1) + " の登録先が違う: " + JSON.stringify(last));
      const size = await getBlobSize(activeWs(), last.imageId);
      note(size > 0, "手順" + (i + 1) + " の実体が保存されていない");
      if (i === expected.length - 2) {
        note(byId("abGuidedDone").hidden === true, "7/8 なのに評価開始が出ている");
        note(byId("abWork").hidden === true, "7/8 なのに評価画面が出ている");
      }
    }
    note(/8 \/ 8 枚 登録済み/.test(gProgress()), "完了進捗が違う: " + gProgress());
    note(byId("abGuidedDone").hidden === false, "8/8 で評価開始が出ない");
    note(/画像生成が完了しました/.test(byId("abGuidedDoneText").textContent),
      "生成完了の言葉が無い: " + byId("abGuidedDoneText").textContent);
    note(/評価/.test(byId("abGuidedDoneText").textContent), "評価へ移る案内が無い");
    note(!/採用/.test(byId("abGuidedDoneText").textContent.replace("採用の決定ではありません", "")),
      "順位1枚目を採用と読める文言がある");
    note(byId("abWork").hidden === true, "評価を始める前に評価画面が出ている");
    note(liveImageInputs().length === 0, "完了後も画像入力が開いている");
    // 名前で辿れる操作は「1つの本文コピー」と「1つの画像登録先」だけだった
    return { pass: problems.length === 0, problems, counts: counts.join(" ") };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 8: 保管庫を行き来しても、どちらの記録も実体も欠けない
// ---------------------------------------------------------------------------
function phaseSwitchBack(arg) {
  return (async (a) => {
    __PRELUDE__
    const recordsOf = (w) => {
      const d = storeOf(w) || {};
      return JSON.stringify({ pkg: d.pkg, images: d.images, reviews: d.reviews,
        comparisons: d.comparisons, conditions: d.conditions, invalidations: d.invalidations,
        phase: d.phase, defaultCondition: d.defaultCondition });
    };
    const guidedRecords = recordsOf(wsOf(a.guidedId));
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "workspace list");
    note(byId("abIdentity").hidden === true, "選択画面で身元パネルが残っている");
    note(liveCopyControls().length === 0 && liveImageInputs().length === 0,
      "選択画面で操作が開いている");
    byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.staleId + '"]').click();
    await waitFor(() => idx().activeId === a.staleId, "stale resumed");
    await waitFor(() => byId("abWorkbench").hidden === false, "stale workbench");
    await delay(250);
    const s = store();
    note(s.images.length === 12 && s.reviews.length === 12 && s.comparisons.length === 3,
      "旧保管庫の記録が欠けた: " + JSON.stringify({ i: s.images.length, r: s.reviews.length, c: s.comparisons.length }));
    note(rawOf(activeWs()) === a.staleRaw, "旧保管庫の記録が書き換わった");
    const sizes = [];
    for (const row of s.images) sizes.push(await getBlobSize(activeWs(), row.imageId));
    note(sizes.every((n) => n > 0), "旧保管庫の実体が読めない: " + JSON.stringify(sizes));
    note(byId("abIdentityId").textContent.indexOf(a.staleExperimentId) >= 0,
      "戻したのに身元パネルが別の実験を指している: " + byId("abIdentityId").textContent);
    // 案内付きへ戻すと、進捗が独立して戻る
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "workspace list again");
    byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.guidedId + '"]').click();
    await waitFor(() => idx().activeId === a.guidedId, "guided resumed");
    await waitFor(() => byId("abWorkbench").hidden === false, "guided workbench");
    await delay(250);
    const g = store();
    note(g.images.length === 8, "案内付きの記録が欠けた: " + g.images.length);
    note(recordsOf(activeWs()) === guidedRecords, "案内付きの記録が書き換わった");
    note(g.images.every((r) => r.experimentId === "fixture-guided-r4f"),
      "案内付きの保管庫に別実験の記録が混ざった");
    // 実体の鍵は保管庫ごとに分かれている
    const keys = await allBlobKeys();
    const namespaced = keys.filter((k) => k.indexOf(a.guidedId + "::") === 0);
    const bare = keys.filter((k) => k.indexOf("::") < 0);
    note(namespaced.length === 8, "案内付きの実体が名前空間に無い: " + namespaced.length);
    note(bare.length === 12, "旧保管庫の実体が変わった: " + bare.length);
    note(keys.length === 20, "実体の総数が違う: " + keys.length);
    note(/8 \/ 8 枚 登録済み|評価中/.test(gProgress() + byId("abGuidedPhase").textContent),
      "案内付きの進捗が戻っていない: " + gProgress());
    return { pass: problems.length === 0, problems, blobKeys: keys.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 9: 再読み込みは「明示的に開いている実験」だけを復元する
// ---------------------------------------------------------------------------
function phaseReloadRestores(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after reload");
    note(idx().activeId === a.guidedId, "再読み込みで別の実験が開いた: " + idx().activeId);
    note(byId("abIdentityId").textContent.indexOf("fixture-guided-r4f") >= 0,
      "再読み込みで身元が変わった: " + byId("abIdentityId").textContent);
    note(store().images.length === 8, "再読み込みで記録が変わった: " + store().images.length);
    note(rawOf(wsOf(a.staleId)) === a.staleRaw, "再読み込みで旧保管庫が変わった");
    note(byId("abConfirm").hidden === true, "確認済みの実験で開始確認が出た");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 10: 登録先の取り違えを断る —— 保管庫の切替 / 保存済み定義の不一致 / 本文ハッシュの不一致
// ---------------------------------------------------------------------------
function phaseResetToGeneration(arg) {
  return (async (a) => {
    __PRELUDE__
    // 生成中の状態を作り直す(この保管庫だけを削除して読み込み直す)。
    // 削除は生成中の画面には出ない。選択画面の別の開閉欄からだけ行える。
    window.confirm = () => true;
    const doomed = activeWs();
    note(lockedOut("abClear"), "生成中に削除の導線が使える");
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "selection screen");
    const danger = byId("abWsDanger");
    note(danger.open === false, "削除欄が最初から開いている");
    const startRow = byId("abStartNewExperiment").getBoundingClientRect();
    const dangerRow = danger.getBoundingClientRect();
    note(dangerRow.top >= startRow.bottom, "削除欄が新規開始の導線と並んでいる");
    danger.open = true;
    await delay(120);
    byId("abWsDangerList").querySelector('[data-ab-delete="' + doomed.id + '"]').click();
    await waitFor(() => byId("abWorkspaces").hidden === false && !idx().activeId, "workspace deleted");
    await delay(200);
    note(!idx().workspaces.some((w) => w.id === doomed.id), "削除した保管庫が索引に残っている");
    note(idx().workspaces.some((w) => w.id === a.staleId), "旧保管庫まで消えた");
    note(rawOf(wsOf(a.staleId)) === a.staleRaw, "削除で旧保管庫の記録が変わった");
    const keys = await allBlobKeys();
    note(keys.length === 12 && keys.every((k) => k.indexOf("::") < 0),
      "削除で旧保管庫の実体が巻き添えになった: " + keys.length);
    loadPkg(a.pkg, "guided-r4f-again.json");
    await startConfirmed();
    await guidedPut("fresh-1.png", 811);
    note(imagesOf().length === 1, "作り直しの1枚が登録されていない");
    return { pass: problems.length === 0, problems, guidedId: idx().activeId };
  })(__ARG__);
}

function phaseWrongTarget(arg) {
  return (async (a) => {
    __PRELUDE__
    const guided = activeWs();
    const before = imagesOf().length;
    const beforeTarget = JSON.stringify(parseTarget());
    const beforeKeys = (await allBlobKeys()).length;

    // --- (1) 保存の途中で別の実験へ切り替えたら、そのファイルは受け取らない ---
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release = null;
    const gate = new Promise((r) => { release = r; });
    crypto.subtle.digest = function (alg, data) {
      const gated = !(data instanceof Uint8Array);   // ファイル(ArrayBuffer)だけ足止めする
      return realDigest(alg, data).then((out) => (gated ? gate.then(() => out) : out));
    };
    byId("abGuidedMsg").textContent = "";
    const input = byId("abGuidedFile");
    input.files = await oneFile("switched.png", 901);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(150);
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "switched away");
    byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.staleId + '"]').click();
    await waitFor(() => idx().activeId === a.staleId, "stale opened mid-flight");
    release();
    await delay(400);
    crypto.subtle.digest = realDigest;
    note(storeOf(wsOf(a.guidedId)).images.length === before,
      "切替中のファイルが元の実験へ登録された: " + storeOf(wsOf(a.guidedId)).images.length);
    note(store().images.length === 12, "切替中のファイルが旧実験へ登録された: " + store().images.length);
    note((await allBlobKeys()).length === beforeKeys,
      "切替中のファイルの実体が残った: " + (await allBlobKeys()).length);
    // 案内付きへ戻す
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "back to list");
    byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.guidedId + '"]').click();
    await waitFor(() => idx().activeId === a.guidedId, "guided reopened");
    await waitFor(() => byId("abWorkbench").hidden === false, "guided workbench");
    await delay(200);
    note(JSON.stringify(parseTarget()) === beforeTarget, "切替のあとで手順が進んだ: " + gTarget());

    // --- (2) 端末に保存されている実験定義が食い違うと受け取らない ---
    const key = storeKeyOf(guided);
    const goodRaw = localStorage.getItem(key);
    const tampered = JSON.parse(goodRaw);
    tampered.pkg.definitionSha256 = "0".repeat(64);
    localStorage.setItem(key, JSON.stringify(tampered));
    byId("abGuidedMsg").textContent = "";
    input.files = await oneFile("defmismatch.png", 902);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => gMsg() !== "", "definition mismatch verdict");
    note(/保存されている実験定義と一致しない/.test(gMsg()), "定義不一致が断られていない: " + gMsg());
    localStorage.setItem(key, goodRaw);
    note(JSON.parse(localStorage.getItem(key)).images.length === before,
      "定義不一致でファイルが割り当てられた");
    note(JSON.stringify(parseTarget()) === beforeTarget, "定義不一致で手順が進んだ: " + gTarget());
    note((await allBlobKeys()).length === beforeKeys, "定義不一致で実体が増えた");

    // --- (3) 本文ハッシュが食い違うと受け取らない ---
    crypto.subtle.digest = function (alg, data) {
      return realDigest(alg, data).then((out) => {
        if (!(data instanceof Uint8Array)) return out;
        const bad = new Uint8Array(out.slice(0));
        bad[0] = bad[0] ^ 0xff;
        return bad.buffer;
      });
    };
    byId("abGuidedMsg").textContent = "";
    input.files = await oneFile("prompthash.png", 903);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => gMsg() !== "", "prompt hash verdict");
    crypto.subtle.digest = realDigest;
    note(/本文が手順の本文と一致しない/.test(gMsg()), "本文ハッシュ不一致が断られていない: " + gMsg());
    note(imagesOf().length === before, "本文ハッシュ不一致でファイルが割り当てられた");
    note(JSON.stringify(parseTarget()) === beforeTarget, "本文ハッシュ不一致で手順が進んだ");
    note((await allBlobKeys()).length === beforeKeys, "本文ハッシュ不一致で実体が増えた");

    // --- (4) 保存に失敗しても手順は進まず、記録も実体も増えない ---
    const realSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error("QuotaExceededError"); };
    byId("abGuidedMsg").textContent = "";
    input.files = await oneFile("quota.png", 904);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => gMsg() !== "", "quota verdict");
    Storage.prototype.setItem = realSet;
    note(/保存領域へ記録できなかった/.test(gMsg()), "保存失敗が伝わっていない: " + gMsg());
    note(imagesOf().length === before, "保存失敗でファイルが割り当てられた");
    note(JSON.stringify(parseTarget()) === beforeTarget, "保存失敗で手順が進んだ");
    note((await allBlobKeys()).length === beforeKeys, "保存失敗で実体が残った");
    // 旧保管庫は全部の失敗を通しても無傷
    note(rawOf(wsOf(a.staleId)) === a.staleRaw, "取り違えの検査で旧保管庫が変わった");
    return { pass: problems.length === 0, problems, target: parseTarget() };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 11: 移行の保存に失敗したら閉じる。移行前の記録はそのまま残る
// ---------------------------------------------------------------------------
function phaseMigrationFailure(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await delay(400);
    note(byId("abWorkbench").hidden === true, "移行に失敗したのに作業台が開いた");
    note(byId("abWorkspaces").hidden === false, "移行に失敗したのに選択画面が出ない");
    note(/安全に読み込めませんでした/.test(byId("abPackageStatus").textContent),
      "移行失敗が伝わっていない: " + byId("abPackageStatus").textContent);
    note(liveCopyControls().length === 0 && liveImageInputs().length === 0,
      "移行に失敗したのに操作が開いている");
    note(legacyRaw() === a.raw, "移行に失敗して移行前の記録が壊れた");
    const keys = await allBlobKeys();
    note(keys.length === a.blobs, "移行に失敗して実体が変わった: " + keys.length);
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 12: 画面幅ごとの表示
// ---------------------------------------------------------------------------
function phaseLayout(spec) {
  return (async (a) => {
    __PRELUDE__
    await delay(250);
    const label = a.label + " / " + a.screen;
    const de = document.documentElement;
    const overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow <= 1, label + " で横溢れ: " + overflow + "px");
    const wide = [];
    byId("abView").querySelectorAll("*").forEach((n) => {
      if (n.getClientRects().length && n.scrollWidth > de.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, label + " で幅超過要素: " + wide.slice(0, 4).join(", "));
    // 見えている操作は画面内に収まり、44px以上
    const controls = Array.prototype.slice.call(byId("abView").querySelectorAll("button, summary"))
      .filter((n) => n.getClientRects().length > 0);
    controls.forEach((n) => {
      const r = n.getBoundingClientRect();
      note(r.height >= 44, label + " の " + (n.id || n.className) + " が44px未満: " + Math.round(r.height));
      note(r.width <= de.clientWidth + 1, label + " の " + (n.id || n.className) + " が画面幅を超えている");
    });
    // 文字が切れていない(折り返して収まっている)。
    //  行末の全角の閉じ括弧・句点は、Chrome が**字送りだけ**を content box の外へ
    //  はみ出させる(字面は内側に収まる)。この分だけを許容幅として測る。
    //  実測: 13px の「）」で 6px。1文字ぶん(16px)を上限にする。
    const HANGING_SLACK = 16;
    const texts = ["abIdentityTitle","abIdentityId","abIdentityProgress","abGuidedTarget",
      "abGuidedCond","abConfirmTitle","abWorkspacesLead"];
    texts.forEach((id) => {
      const n = byId(id);
      if (!n || !n.getClientRects().length) return;
      const over = n.scrollWidth - n.clientWidth;
      const tail = (n.textContent || "").slice(-1);
      const hangs = /[）」』】〉》。、]/.test(tail);
      const allow = hangs ? HANGING_SLACK : 1;
      note(over <= allow, label + " の " + id + " が横に溢れている: "
        + n.scrollWidth + " > " + n.clientWidth + " (over " + over + "px, tail=" + tail + ") text="
        + (n.textContent || "").slice(0, 60));
    });
    // 入力欄はiOSの自動ズームを招かない
    const fields = Array.prototype.slice.call(byId("abView").querySelectorAll("input, select, textarea"))
      .filter((n) => n.getClientRects().length > 0 && n.type !== "file");
    fields.forEach((n) => {
      const fs = parseFloat(getComputedStyle(n).fontSize);
      note(fs >= 16, label + " の " + (n.id || n.name) + " が16px未満: " + fs);
    });
    // 主導線は1つだけ
    const primaries = Array.prototype.slice.call(byId("abView").querySelectorAll("button.primary"))
      .filter((n) => n.getClientRects().length > 0 && n.disabled !== true);
    note(primaries.length <= 1, label + " で主要ボタンが " + primaries.length + " 個: "
      + primaries.map((n) => n.id).join(","));
    return { pass: problems.length === 0, problems, label, overflow, vw: de.clientWidth,
      copies: liveCopyControls().length, inputs: liveImageInputs().length };
  })(__ARG__);
}

// レイアウト測定のための小さな移動
function phaseLoadForConfirm(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(a.pkg, "layout-guided.json");
    await waitFor(() => byId("abConfirm").hidden === false, "confirm for layout");
    await delay(150);
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}
function phaseEnterGeneration() {
  return (async () => {
    __PRELUDE__
    byId("abConfirmStart").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench for layout");
    await guidedPut("layout.png", 950);
    await waitFor(() => imagesOf().length === 1, "one image for layout");
    await delay(200);
    note(/生成中/.test(byId("abGuidedPhase").textContent), "生成中でない: " + byId("abGuidedPhase").textContent);
    return { pass: problems.length === 0, problems };
  })();
}
// 検査用プロファイルの初期化(使い捨てプロファイル。利用者の保存内容とは無関係)
function phaseWipe() {
  return (async () => {
    __PRELUDE__
    await withStore("readwrite", (s2) => s2.clear());
    Object.keys(localStorage).filter((k) => k.indexOf("personaGenerator.ab") === 0)
      .forEach((k) => localStorage.removeItem(k));
    const keys = await allBlobKeys();
    note(keys.length === 0, "初期化しきれていない実体がある: " + keys.length);
    note(!localStorage.getItem(WS_INDEX_KEY), "初期化しきれていない索引がある");
    return { pass: problems.length === 0, problems };
  })();
}
function phaseOpenNormal() {
  return (async () => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after normal open");
    note(idx().workspaces.length === 1, "通常の入口で保管庫が1つでない: " + idx().workspaces.length);
    return { pass: problems.length === 0, problems };
  })();
}
function phaseDropGuidedWorkspace() {
  return (async () => {
    __PRELUDE__
    window.confirm = () => true;
    const doomed = activeWs();
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "selection screen");
    byId("abWsDanger").open = true;
    await delay(100);
    byId("abWsDangerList").querySelector('[data-ab-delete="' + doomed.id + '"]').click();
    await waitFor(() => byId("abWorkspaces").hidden === false && !idx().activeId, "guided workspace dropped");
    await delay(150);
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const stalePkg = buildStalePackage();
  const staleStore = buildStaleStore(stalePkg);
  const staleRaw = JSON.stringify(staleStore);
  const guidedPkg = buildGuidedPackage("v1");
  const prompts = {};
  guidedPkg.cases.forEach((c) => {
    prompts[c.caseId + "A"] = c.arms.A.prompt;
    prompts[c.caseId + "B"] = c.arms.B.prompt;
  });
  const seedRows = staleStore.images.map((r, i) => ({ imageId: r.imageId, seed: 500 + i }));

  // 移行前のブラウザ内容の控え(受入フィクスチャ)。復旧手順の証拠として残す。
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4f-backup-"));
  const backupFile = path.join(backupDir, "pre-r4f-browser-store.json");
  fs.writeFileSync(backupFile, staleRaw, "utf8");
  const backupSha = crypto.createHash("sha256").update(fs.readFileSync(backupFile)).digest("hex");

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4f-workspace-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4f-workspace-dl-"));
  const chrome = spawn(CHROME_PATH, [
    "--headless=new", "--disable-background-networking", "--disable-default-apps",
    "--disable-extensions", "--disable-gpu", "--disable-sync",
    "--no-default-browser-check", "--no-first-run", "--window-size=1280,900",
    "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let client = null;
  startHeartbeat();
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

    // 工程ごとに上限時間を分ける。中身も所要も違うものへ同じ数字を当てない。
    const run = async (fn, label, arg, timeout) => {
      const at = Date.now();
      beatState.phase = label;
      beatState.last = "start";
      process.stderr.write(`  [phase] ${label} ... (limit ${Math.round(timeout / 1000)}s, elapsed ${elapsed()})\n`);
      let source = fn.toString().replace("__PRELUDE__", PRELUDE);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      const ev = await client.send("Runtime.evaluate",
        { expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout }, sessionId);
      const took = ((Date.now() - at) / 1000).toFixed(1);
      beatState.last = label + " " + took + "s";
      process.stderr.write(`  [phase] ${label} done in ${took}s\n`);
      if (ev.exceptionDetails) fail(`${label} threw`, ev.exceptionDetails);
      const v = ev.result && ev.result.value;
      if (!v || !v.pass) fail(`${label} failed`, v);
      return v;
    };
    const goto = async (url, settle = 2200) => {
      await client.send("Page.navigate", { url }, sessionId);
      await wait(settle);
    };
    const reload = async (settle = 2200) => {
      await client.send("Page.reload", { ignoreCache: false }, sessionId);
      await wait(settle);
    };

    // 1) 移行前の状態を作る
    const seeded = await run(phaseSeedStale, "seed a pre-R4F singleton workspace",
      { raw: staleRaw, images: seedRows }, 120000);

    // 2) 移行
    await reload();
    const migrated = await run(phaseMigrate, "migrate the singleton without changing records or blobs", {
      raw: staleRaw, experimentId: stalePkg.experiment.experimentId,
      definitionSha256: stalePkg.definitionSha256,
      expect: { images: staleStore.images, reviews: staleStore.reviews,
        comparisons: staleStore.comparisons, conditions: staleStore.conditions, pkg: stalePkg }
    }, 180000);

    // 3) 冪等
    const migratedAt = (await client.send("Runtime.evaluate", {
      expression: `JSON.parse(localStorage.getItem("personaGenerator.abWorkspaces.v1")).legacyMigratedAt`,
      returnByValue: true
    }, sessionId)).result.value;
    const storeRaw = (await client.send("Runtime.evaluate", {
      expression: `localStorage.getItem(${JSON.stringify(migrated.storeKey)})`, returnByValue: true
    }, sessionId)).result.value;
    for (let i = 0; i < 2; i += 1) {
      await reload();
      await run(phaseIdempotent, `migration idempotent / reload ${i + 1}`,
        { workspaceId: migrated.workspaceId, migratedAt, storeRaw, raw: staleRaw, blobs: seeded.blobs }, 120000);
    }

    // 4) 案内付き専用の入口
    await goto(baseUrl + "/?ab=new-guided", 2600);
    await run(phaseCleanEntry, "clean guided entry shows only the selection screen",
      { workspaceId: migrated.workspaceId, storeRaw, raw: staleRaw, blobs: seeded.blobs }, 120000);

    // 5) 案内付きでないパッケージは拒否
    await run(phaseRefuseLegacyPackage, "non-guided package refused in clean guided entry",
      { pkg: stalePkg, workspaceId: migrated.workspaceId, storeRaw }, 120000);

    // 6) 開始確認
    const started = await run(phaseConfirmAndStart, "guided package confirmed and started without deleting anything",
      { pkg: guidedPkg, staleId: migrated.workspaceId, staleRaw: storeRaw, blobs: seeded.blobs }, 180000);

    // 7) 単一導線
    const single = await run(phaseSingleTask, "exactly one copy control and one file input at every step",
      { prompts }, 420000);

    // 8) 行き来
    await run(phaseSwitchBack, "switching workspaces keeps both record sets and blobs", {
      guidedId: started.guidedId, staleId: migrated.workspaceId, staleRaw: storeRaw,
      staleExperimentId: stalePkg.experiment.experimentId
    }, 180000);

    // 9) 再読み込み
    await reload();
    await run(phaseReloadRestores, "reload restores only the explicitly active workspace",
      { guidedId: started.guidedId, staleId: migrated.workspaceId, staleRaw: storeRaw }, 120000);

    // 10) 取り違えを断る
    const reset = await run(phaseResetToGeneration, "delete only the open workspace and start a fresh guided run",
      { pkg: guidedPkg, staleId: migrated.workspaceId, staleRaw: storeRaw }, 240000);
    const wrong = await run(phaseWrongTarget, "wrong workspace / definition / prompt hash / storage failure refuse the file",
      { guidedId: reset.guidedId, staleId: migrated.workspaceId, staleRaw: storeRaw }, 300000);

    // 11) 移行の失敗は閉じる
    const hook = await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (String(k).indexOf("personaGenerator.abWorkspaces") === 0) throw new Error("QuotaExceededError");
          return real.call(this, k, v);
        };
      })();`
    }, sessionId);
    await run(phaseWipe, "reset the throwaway test profile", undefined, 60000);
    const failureSeed = await run(phaseSeedStale, "re-seed a pre-R4F singleton for the failure case",
      { raw: staleRaw, images: seedRows }, 180000);
    await reload();
    await run(phaseMigrationFailure, "failed migration fails closed and keeps the original readable",
      { raw: staleRaw, blobs: failureSeed.blobs }, 120000);
    await client.send("Page.removeScriptToEvaluateOnNewDocument",
      { identifier: hook.identifier }, sessionId);

    // 12) 画面幅。保存の妨害を外した文書で、移行をやり直してから測る。
    await goto(baseUrl + "/", 2200);
    await run(phaseOpenNormal, "normal entry migrates once the storage failure is gone", undefined, 120000);

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    const layout = [];
    beatState.total = specs.length * 3;
    beatState.done = 0;
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      // (a) 選択画面
      await goto(baseUrl + "/?ab=new-guided", 2400);
      layout.push(await run(phaseLayout, "layout / " + spec.label + " / select",
        { label: spec.label, screen: "select" }, 90000));
      beatState.done += 1;
      // (b) 開始確認
      await run(phaseLoadForConfirm, "load guided package / " + spec.label, { pkg: guidedPkg }, 120000);
      layout.push(await run(phaseLayout, "layout / " + spec.label + " / confirm",
        { label: spec.label, screen: "confirm" }, 90000));
      beatState.done += 1;
      // (c) 生成中
      await run(phaseEnterGeneration, "enter generation / " + spec.label, undefined, 120000);
      layout.push(await run(phaseLayout, "layout / " + spec.label + " / generation",
        { label: spec.label, screen: "generation" }, 90000));
      beatState.done += 1;
      // 次の幅のために保管庫を片付ける(旧保管庫には触れない)
      await run(phaseDropGuidedWorkspace, "drop the guided workspace / " + spec.label, undefined, 120000);
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    beatState.total = 0;

    const generationLayouts = layout.filter((l) => /generation/.test(l.label));
    const badCounts = generationLayouts.filter((l) => l.copies !== 1 || l.inputs !== 1);

    console.log("R4F WORKSPACE ENTRY BROWSER ACCEPTANCE PASSED");
    console.log(`  pre-R4F singleton (${migrated.images} images / ${migrated.reviews} reviews / ${seeded.blobs} blobs) migrated with records, blobs and the original key byte-identical`);
    console.log(`  pre-migration backup fixture: ${path.basename(backupFile)} sha256=${backupSha}`);
    console.log(`  migration idempotent across 2 further reloads; workspace index stayed at 1 entry`);
    console.log(`  normal entry named the resumed legacy experiment above every prompt/image control`);
    console.log(`  ?ab=new-guided showed only the selection screen: 0 visible enabled copy controls, 0 visible enabled image inputs, legacy records/blobs untouched`);
    console.log(`  a non-guided package was refused in clean guided entry without touching any workspace`);
    console.log(`  the guided package required an explicit start confirmation and created a second workspace (legacy kept)`);
    console.log(`  guided generation exposed exactly 1 copy control / 1 file input at all 8 steps: ${single.counts}`);
    console.log(`  switching legacy <-> guided kept 12 legacy blobs (bare keys) and 8 guided blobs (namespaced keys); total ${20}`);
    console.log(`  reload restored only the explicitly active workspace`);
    console.log(`  refused registration on workspace switch, persisted-definition mismatch, prompt-hash mismatch and storage failure; queue stayed at ${JSON.stringify(wrong.target)}`);
    console.log(`  a failed workspace-index write failed closed and left the pre-R4F record readable`);
    console.log(`  layout (${layout.length} passes): ${layout.map((l) => `${l.label} ${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
    console.log(`  generation-screen control counts per viewport: ${generationLayouts.map((l) => l.copies + "/" + l.inputs).join(" ")} (mismatches: ${badCounts.length})`);
    if (badCounts.length) fail("generation screen control counts are not 1/1", badCounts);
  } finally {
    stopHeartbeat();
    if (client) client.close();
    await closeChrome(chrome);
    await closeServer(server);
    await removeDirWithRetry(userDataDir);
    await removeDirWithRetry(downloadDir);
    await removeDirWithRetry(backupDir);
  }
}

main().catch((error) => {
  stopHeartbeat();
  console.error(error && error.stack ? error.stack : error);
  if (error && error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
  process.exit(1);
});
