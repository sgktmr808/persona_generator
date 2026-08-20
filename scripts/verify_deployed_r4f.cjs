#!/usr/bin/env node
// [R4F] 公開反映の確認。GitHub Pages に載った版そのものを実ブラウザで通す。
//
//  使い方:
//    node scripts/verify_deployed_r4f.cjs [URL]
//    既定 URL = https://sgktmr808.github.io/persona_generator/
//
//  確かめること:
//   1. 配信されている HTML が R4F の版であること(古いキャッシュを完成扱いしない)
//   2. R4F 以前の単一保管庫(画像12件)を仕込んで開くと、記録も実体も変えずに移行すること
//   3. 汎用の案内付き入口 `?ab=new-guided` が、保存済みを操作せず選択画面だけを出すこと
//      ・見えていて押せる本文コピー 0個 / 見えていて使える画像入力 0個
//   4. 合成の案内付きパッケージを開始確認のうえ読み込み、1枚登録できること
//      ・生成中は本文コピー1個・画像入力1個ちょうど
//   5. 旧実験へ戻すと、以前の画像が引き続き読めること
//   6. デスクトップと iPhone 各幅・横向きで横溢れ 0
//
//  使う実験データは**合成フィクスチャのみ**。公開先へ実験の中身は送らない
//  (ページはサーバを持たない静的サイトで、記録は端末内にしか保存されない)。
//
//  工程ごとに上限時間を分け、長い工程では心拍を出す。成功・失敗・例外のどれでも後始末する。
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


const { buildStalePackage, buildGuidedPackage, buildStaleStore } = require("./_r4f_fixtures.cjs");

const DEPLOYED_URL = process.argv[2] || "https://sgktmr808.github.io/persona_generator/";

// 配信された版が R4F であることの目印(公開UIの中身であって実験の中身ではない)。
const REVISION_MARKERS = [
  'id="abIdentity"',
  'id="abWorkspaces"',
  'id="abConfirmStart"',
  'id="abWsDanger"',
  "personaGenerator.abWorkspaces.v1",
  "ab=new-guided",
  "workspaceIdFor",
  "registrationGuard",
  "GUIDED_LOCK_IDS"
];

const T0 = Date.now();
function elapsed() { return ((Date.now() - T0) / 1000).toFixed(1) + "s"; }
let beat = null;
let beatPhase = "起動";
function startHeartbeat() {
  beat = setInterval(() => {
    process.stderr.write(`  [heartbeat] ${beatPhase} elapsed=${elapsed()}\n`);
  }, 15000);
  if (beat.unref) beat.unref();
}
function stopHeartbeat() { if (beat) { clearInterval(beat); beat = null; } }

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then((t) => { clearTimeout(timer); resolve(t); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(120); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abPackageStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abGuidedMsg")||{}).textContent||""));
  };
  const byId = (id) => document.getElementById(id);
  const problems = [];
  const note = (c, m) => { if (!c) problems.push(m); };
  const WS_INDEX_KEY = "personaGenerator.abWorkspaces.v1";
  const LEGACY_STORE_KEY = "personaGenerator.abExperiment.v1";
  const idx = () => { try { return JSON.parse(localStorage.getItem(WS_INDEX_KEY)); } catch (_) { return null; } };
  const wsOf = (id) => { const i = idx(); return i ? (i.workspaces || []).filter((w) => w.id === id)[0] || null : null; };
  const activeWs = () => { const i = idx(); return i && i.activeId ? wsOf(i.activeId) : null; };
  const storeOf = (w) => { const r = w ? localStorage.getItem(w.storeKey) : null; return r ? JSON.parse(r) : null; };
  const store = () => storeOf(activeWs());
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
  const isVisible = (n) => !!n && n.getClientRects().length > 0;
  const isEnabled = (n) => !!n && n.disabled !== true;
  const abNodes = (sel) => Array.prototype.slice.call(byId("abView").querySelectorAll(sel));
  const liveCopyControls = () => abNodes("button")
    .filter((b) => /コピー/.test(b.textContent || "")).filter((n) => isVisible(n) && isEnabled(n));
  const liveImageInputs = () => abNodes('input[type="file"]')
    .filter((i) => String(i.accept || "").indexOf("image") >= 0).filter((n) => isVisible(n) && isEnabled(n));
  const openAbTab = async () => {
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    await delay(300);
  };
`;

function phaseSeed(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => document.readyState === "complete", "ready");
    localStorage.removeItem(WS_INDEX_KEY);
    localStorage.setItem(LEGACY_STORE_KEY, a.raw);
    await withStore("readwrite", (s) => s.clear());
    for (const row of a.images) {
      const blob = await makePng(row.seed);
      await withStore("readwrite", (s) => s.put({ imageId: row.imageId, blob, updatedAt: "2026-08-09T01:00:00.000Z" }));
    }
    const keys = await allBlobKeys();
    note(keys.length === a.images.length, "仕込んだ実体の件数が違う: " + keys.length);
    note(idx() === null, "仕込みの時点で索引がある");
    return { pass: problems.length === 0, problems, blobs: keys.length };
  })(__ARG__);
}

function phaseMigrate(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after migration");
    const w = activeWs();
    note(!!w && w.experimentId === a.experimentId, "移行先の実験IDが違う");
    note(!!w && w.blobKeyMode === "legacyBlobKeys", "移行で実体の鍵が変わった");
    note(localStorage.getItem(LEGACY_STORE_KEY) === a.raw, "移行前の保管庫が書き換えられた");
    const s = store();
    note(s.images.length === 12 && s.reviews.length === 12 && s.comparisons.length === 3,
      "移行で記録が欠けた: " + JSON.stringify({ i: s.images.length, r: s.reviews.length, c: s.comparisons.length }));
    const sizes = [];
    for (const row of s.images) sizes.push(await getBlobSize(w, row.imageId));
    note(sizes.every((n) => n > 0), "移行後に読めない実体がある");
    note(byId("abIdentity").hidden === false, "身元パネルが出ていない");
    note(/再開/.test(byId("abIdentityState").textContent), "再開と表示されていない: "
      + byId("abIdentityState").textContent);
    note(byId("abIdentityId").textContent.indexOf(a.experimentId) >= 0, "身元パネルの実験IDが違う");
    return { pass: problems.length === 0, problems, staleId: w.id, blobs: sizes.length };
  })(__ARG__);
}

function phaseCleanEntry(arg) {
  return (async (a) => {
    __PRELUDE__
    await waitFor(() => byId("abView").hidden === false, "ab view auto-opened", 40000);
    await delay(400);
    note(byId("abWorkbench").hidden === true, "案内付き入口で作業台が開いている");
    note(byId("abIdentity").hidden === true, "案内付き入口で前の実験の身元が出ている");
    note(byId("abWorkspaces").hidden === false, "保存済み実験の一覧が出ていない");
    note(liveCopyControls().length === 0, "案内付き入口に本文コピーが出ている: " + liveCopyControls().length);
    note(liveImageInputs().length === 0, "案内付き入口に画像入力が出ている: " + liveImageInputs().length);
    note(idx().activeId === a.staleId, "案内付き入口で開いている実験が変わった");
    note((await allBlobKeys()).length === a.blobs, "案内付き入口で実体が変わった");
    note(!!byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.staleId + '"]'),
      "保存済み一覧に旧実験が無い");
    return { pass: problems.length === 0, problems,
      copies: liveCopyControls().length, inputs: liveImageInputs().length };
  })(__ARG__);
}

function phaseGuidedRun(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => { problems.push("新しい実験の開始で削除の確認が出た"); return true; };
    loadPkg(a.pkg, "deployed-guided.json");
    await waitFor(() => byId("abConfirm").hidden === false, "confirm card");
    note(liveCopyControls().length === 0 && liveImageInputs().length === 0,
      "確認前に操作が開いている");
    const facts = byId("abConfirmFacts").textContent;
    note(/8 枚/.test(facts), "確認カードに必要枚数が無い: " + facts);
    byId("abConfirmStart").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after confirm");
    await delay(250);
    note(liveCopyControls().length === 1 && liveCopyControls()[0].id === "abGuidedCopy",
      "生成中の本文コピーが1個でない: " + liveCopyControls().map((n) => n.id).join(","));
    note(liveImageInputs().length === 1 && liveImageInputs()[0].id === "abGuidedFile",
      "生成中の画像入力が1個でない: " + liveImageInputs().map((n) => n.id).join(","));
    note(byId("abWork").hidden === true, "生成中にA/B作業台が出ている");
    note(byId("abHeader").hidden === true, "生成中にケース移動が出ている");
    // 1枚登録する
    const before = (store().images || []).length;
    const input = byId("abGuidedFile");
    input.files = await oneFile("deployed-1.png", 4242);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => (store().images || []).length === before + 1, "one image registered");
    const guided = activeWs();
    const row = store().images[0];
    note(row.rank === 1 && row.guidedSequence === 1, "登録先が違う: " + JSON.stringify(row));
    note((await getBlobSize(guided, row.imageId)) > 0, "登録した実体が読めない");
    note(/画像生成 1 \/ 8/.test(byId("abIdentityProgress").textContent),
      "進捗表示が違う: " + byId("abIdentityProgress").textContent);
    // 旧実験へ戻すと、以前の画像がそのまま読める
    byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "workspace list");
    byId("abWorkspaceList").querySelector('[data-ab-resume="' + a.staleId + '"]').click();
    await waitFor(() => idx().activeId === a.staleId, "stale resumed");
    await waitFor(() => byId("abWorkbench").hidden === false, "stale workbench");
    await delay(300);
    const s = store();
    note(s.images.length === 12, "旧実験の記録が欠けた: " + s.images.length);
    const stale = activeWs();
    const sizes = [];
    for (const r of s.images) sizes.push(await getBlobSize(stale, r.imageId));
    note(sizes.every((n) => n > 0), "旧実験の画像が読めなくなった: " + JSON.stringify(sizes));
    const keys = await allBlobKeys();
    note(keys.filter((k) => k.indexOf("::") < 0).length === 12, "旧実験の実体の鍵が変わった");
    note(keys.filter((k) => k.indexOf(guided.id + "::") === 0).length === 1, "案内付きの実体が名前空間に無い");
    return { pass: problems.length === 0, problems, guidedId: guided.id, staleBlobs: sizes.length };
  })(__ARG__);
}

function phaseEnterGeneration(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    await waitFor(() => byId("abWorkspaces").hidden === false, "selection screen");
    loadPkg(a.pkg, "deployed-layout.json");
    // 未確認の保管庫なら開始確認を通る。確認済みの保管庫はそのまま作業台へ戻る。
    await waitFor(() => byId("abConfirm").hidden === false || byId("abWorkbench").hidden === false,
      "confirm or workbench for layout");
    if (byId("abConfirm").hidden === false) {
      byId("abConfirmStart").click();
      await waitFor(() => byId("abWorkbench").hidden === false, "workbench for layout");
    }
    const before = (store().images || []).length;
    const input = byId("abGuidedFile");
    input.files = await oneFile("layout.png", 5150);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => (store().images || []).length === before + 1, "one image for layout");
    await delay(250);
    note(/生成中/.test(byId("abGuidedPhase").textContent), "生成中でない: " + byId("abGuidedPhase").textContent);
    return { pass: problems.length === 0, problems, guidedId: activeWs().id };
  })(__ARG__);
}
function phaseDropGuided(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    if (byId("abWorkspaces").hidden !== false) byId("abSwitchExperiment").click();
    await waitFor(() => byId("abWorkspaces").hidden === false, "selection screen");
    byId("abWsDanger").open = true;
    await delay(150);
    const target = byId("abWsDangerList").querySelector('[data-ab-delete="' + a.guidedId + '"]');
    if (!target) { note(!wsOf(a.guidedId), "削除対象が一覧に無い"); return { pass: problems.length === 0, problems }; }
    target.click();
    // 開いていた保管庫でも、そうでなくても「索引から消えた」ことで判定する。
    await waitFor(() => !wsOf(a.guidedId), "guided workspace dropped");
    note(!!wsOf(a.staleId), "旧実験まで消えた");
    await delay(150);
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}
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
    const controls = Array.prototype.slice.call(byId("abView").querySelectorAll("button, summary"))
      .filter((n) => n.getClientRects().length > 0);
    controls.forEach((n) => {
      const r = n.getBoundingClientRect();
      note(r.height >= 44, a.label + " の " + (n.id || n.className) + " が44px未満: " + Math.round(r.height));
    });
    return { pass: problems.length === 0, problems, label: a.label, overflow, vw: de.clientWidth,
      copies: liveCopyControls().length, inputs: liveImageInputs().length };
  })(__ARG__);
}

async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (typeof fetch !== "function") fail("Node.js fetch global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  console.log("=== R4F 公開反映の確認 ===");
  console.log("URL: " + DEPLOYED_URL);

  startHeartbeat();
  beatPhase = "配信されている版の確認";
  const html = await fetchText(DEPLOYED_URL + (DEPLOYED_URL.indexOf("?") >= 0 ? "&" : "?")
    + "cachebust=" + Date.now(), 30000);
  const missing = REVISION_MARKERS.filter((m) => html.indexOf(m) < 0);
  if (missing.length) {
    stopHeartbeat();
    fail("配信されている版が R4F ではありません（キャッシュされた旧版の可能性）", missing);
  }
  const htmlSha = crypto.createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");
  console.log(`  R4F の目印 ${REVISION_MARKERS.length} 件すべてを確認  配信 HTML SHA-256=${htmlSha}`);

  const stalePkg = buildStalePackage();
  const staleStore = buildStaleStore(stalePkg);
  const staleRaw = JSON.stringify(staleStore);
  const guidedPkg = buildGuidedPackage("deployed");
  const seedRows = staleStore.images.map((r, i) => ({ imageId: r.imageId, seed: 600 + i }));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r4f-deployed-"));
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
    const target = await client.send("Target.createTarget", { url: DEPLOYED_URL });
    const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(2500);

    const run = async (fn, label, arg, timeout) => {
      const at = Date.now();
      beatPhase = label;
      process.stderr.write(`  [phase] ${label} ... (limit ${Math.round(timeout / 1000)}s, elapsed ${elapsed()})\n`);
      let source = fn.toString().replace("__PRELUDE__", PRELUDE);
      source = source.replace("__ARG__", arg === undefined ? "undefined" : JSON.stringify(arg));
      const ev = await client.send("Runtime.evaluate",
        { expression: `(${source})()`, awaitPromise: true, returnByValue: true, timeout }, sessionId);
      process.stderr.write(`  [phase] ${label} done in ${((Date.now() - at) / 1000).toFixed(1)}s\n`);
      if (ev.exceptionDetails) fail(`${label} threw`, ev.exceptionDetails);
      const v = ev.result && ev.result.value;
      if (!v || !v.pass) fail(`${label} failed`, v);
      return v;
    };
    const goto = async (url, settle = 3000) => {
      await client.send("Page.navigate", { url }, sessionId);
      await wait(settle);
    };

    const seeded = await run(phaseSeed, "seed a pre-R4F singleton on the deployed page",
      { raw: staleRaw, images: seedRows }, 120000);
    await goto(DEPLOYED_URL);
    const migrated = await run(phaseMigrate, "deployed migration keeps records and blobs",
      { raw: staleRaw, experimentId: stalePkg.experiment.experimentId }, 180000);

    const cleanUrl = DEPLOYED_URL + (DEPLOYED_URL.indexOf("?") >= 0 ? "&" : "?") + "ab=new-guided";
    await goto(cleanUrl, 3200);
    const clean = await run(phaseCleanEntry, "clean guided entry on the deployed page",
      { staleId: migrated.staleId, blobs: seeded.blobs }, 120000);

    const guided = await run(phaseGuidedRun, "guided single-task run and switch back on the deployed page",
      { pkg: guidedPkg, staleId: migrated.staleId }, 240000);

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    // レイアウト測定は毎回まっさらな案内付き保管庫で行う。
    await goto(cleanUrl, 2600);
    await run(phaseDropGuided, "drop the guided workspace before the layout matrix",
      { guidedId: guided.guidedId, staleId: migrated.staleId }, 120000);
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await goto(cleanUrl, 2600);
      layout.push(await run(phaseLayout, "deployed layout / " + spec.label + " / select",
        { label: spec.label + " select" }, 90000));
      const gen = await run(phaseEnterGeneration, "deployed generation screen / " + spec.label,
        { pkg: guidedPkg }, 150000);
      layout.push(await run(phaseLayout, "deployed layout / " + spec.label + " / generation",
        { label: spec.label + " generation" }, 90000));
      await run(phaseDropGuided, "drop the guided workspace / " + spec.label,
        { guidedId: gen.guidedId, staleId: migrated.staleId }, 120000);
    }

    console.log("R4F DEPLOYED VERIFICATION PASSED");
    console.log(`  deployed revision carries every R4F marker (html sha256 ${htmlSha})`);
    console.log(`  pre-R4F singleton with ${seeded.blobs} blobs migrated on the deployed page; records and blobs unchanged; resumed experiment named on screen`);
    console.log(`  ?ab=new-guided: ${clean.copies} visible enabled copy controls / ${clean.inputs} visible enabled image inputs; active workspace and blobs untouched`);
    console.log(`  guided run: exactly 1 copy control + 1 file input, one image registered, then ${guided.staleBlobs} legacy blobs still readable after switching back`);
    console.log(`  layout (${layout.length} passes): ${layout.map((l) => `${l.label} ${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
    const genLayouts = layout.filter((l) => /generation/.test(l.label));
    console.log(`  deployed generation-screen control counts per viewport: ${genLayouts.map((l) => l.copies + "/" + l.inputs).join(" ")}`);
    const bad = genLayouts.filter((l) => l.copies !== 1 || l.inputs !== 1);
    if (bad.length) fail("deployed generation screen control counts are not 1/1", bad);
  } finally {
    stopHeartbeat();
    if (client) client.close();
    await closeChrome(chrome);
    await removeDirWithRetry(userDataDir);
  }
}

main().catch((error) => {
  stopHeartbeat();
  console.error(error && error.stack ? error.stack : error);
  if (error && error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
  process.exit(1);
});
