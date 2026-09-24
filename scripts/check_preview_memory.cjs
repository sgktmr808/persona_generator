#!/usr/bin/env node
// [メモリ対策 2026-09-23] 画像プレビューのメモリ抑制の**実ブラウザ**受入検査。
//  背景: iPhone で「ファイルを読み込んでしばらく使うと再読み込みが繰り返される」現象。原寸画像の
//  デコードと解放されない object URL の蓄積で WebKit のタブ上限を超え、Safari が強制終了→自動再読み込み
//  していた。ここでは合成画像(4000x3000)だけを使い、実データは一切含まない。
//
//  確かめること:
//   1. 追加した画像のプレビューは長辺 1280px 以下の縮小 JPEG で表示され、原寸の object URL を作らない
//   2. 項目を移動すると、表示していない項目のプレビュー URL が解放される(蓄積しない)
//   3. 保存時のハッシュ計算・保存は1枚ずつ順番に行われる(同時に全画像を読み込まない)
//   4. 再読み込み後も IndexedDB の実体(原寸)から縮小プレビューが再生成され、実体は原寸のまま
//   5. A/B 側のプレビューも縮小され、ケース移動で解放される(setPreview/hydratePreviews が同じ器を使う)
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function fail(message, detail) { const e = new Error(message); if (detail !== undefined) e.detail = detail; throw e; }
function contentType(f) { return f.endsWith(".html") ? "text/html; charset=utf-8" : f.endsWith(".js") ? "text/javascript; charset=utf-8" : f.endsWith(".json") ? "application/json; charset=utf-8" : "application/octet-stream"; }
function createServer() {
  return http.createServer((req, res) => {
    const clean = decodeURIComponent(String(req.url || "/").split("?")[0]);
    const target = path.resolve(ROOT, "." + (clean === "/" ? "/index.html" : clean));
    if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": contentType(target), "cache-control": "no-store" });
    fs.createReadStream(target).pipe(res);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Chrome は終了を待ってから戻る(SIGTERM→3秒で SIGKILL)。待たずに戻るとゲートが残存プロセスとして検出する。
function closeChrome(chrome) {
  return new Promise((resolve) => {
    if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) { resolve(); return; }
    const timeout = setTimeout(() => { if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL"); resolve(); }, 3000);
    chrome.once("exit", () => { clearTimeout(timeout); resolve(); });
    chrome.kill("SIGTERM");
  });
}

// --- 静的検査(ソース契約): 逐次保存と縮小器の配線 ---
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
if (!/window\.PersonaPreview = \(function \(\) \{/.test(html)) fail("PersonaPreview helper is missing");
if (!/draft\.images\.reduce\(function \(chain, image\) \{\s*return chain\.then\(function \(\) \{ return persistOneImage\(image\); \}\);/.test(html)) fail("review save is not sequential");
if (/Promise\.all\(draft\.images\.map/.test(html)) fail("review save still uses Promise.all over images");
if (!/var abPreviews = window\.PersonaPreview\.create\(\);/.test(html)) fail("A/B previews do not use PersonaPreview");
if (/Promise\.all\(rows\.map\(function \(r\) \{\s*if \(previewUrl/.test(html)) fail("hydratePreviews still decodes all rows concurrently");
if (/reviewBlobUrls/.test(html)) fail("legacy reviewBlobUrls cache still referenced");
if (!/reviewPreviews\.releaseExcept\(keepPreview\)/.test(html)) fail("review view does not release previews of other items");

const PCEXPORT = ["<<<PCEXPORT v1 count=2>>>",
  "<<<PROMPT 01>>>", "検査用の本文その1。合成データであり実験の本文ではない。", "<<<SETTINGS 01>>>", JSON.stringify({ probe: 1 }),
  "<<<PROMPT 02>>>", "検査用の本文その2。合成データであり実験の本文ではない。", "<<<SETTINGS 02>>>", JSON.stringify({ probe: 2 }),
  "<<<PCEXPORT END>>>"].join("\n");

async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);
  const server = createServer();
  const baseUrl = await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)); });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgmem-"));
  const chrome = spawn(CHROME_PATH, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let sock = null;
  try {
    const wsUrl = await new Promise((resolve, reject) => { let s = ""; const t = setTimeout(() => reject(new Error("Timed out waiting for DevTools")), 15000); chrome.stderr.on("data", (c) => { s += c; const m = s.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); });
    sock = new WebSocket(wsUrl);
    await new Promise((r, j) => { sock.addEventListener("open", r, { once: true }); sock.addEventListener("error", j, { once: true }); });
    let nextId = 1; const pending = new Map(); const events = [];
    sock.addEventListener("message", (e) => { const m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8")); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } else if (m.method) events.push(m); });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); sock.send(JSON.stringify({ id, method, params, sessionId })); });
    const target = await send("Target.createTarget", { url: baseUrl + "/" });
    const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sid = attached.sessionId;
    await send("Runtime.enable", {}, sid); await send("Page.enable", {}, sid);
    await wait(1500);
    const run = async (fn, label, arg) => {
      const expr = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 }, sid);
      if (r.exceptionDetails) fail(`${label} threw`, r.exceptionDetails);
      const v = r.result && r.result.value;
      if (!v || !v.pass) fail(`${label} failed`, v);
      return v;
    };

    // ---- フェーズ1: 貼り付け→レビュー→合成画像3枚を追加→縮小プレビュー・URL数 ----
    const phase1 = await run(async function (pc) {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const problems = []; const note = (c, m) => { if (!c) problems.push(m); };
      // object URL の作成/解放を数える(原寸 blob から URL を作っていないことの証拠)
      window.__urls = { created: [], revoked: 0 };
      const oc = URL.createObjectURL.bind(URL), orv = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = function (b) { window.__urls.created.push(b && b.size || 0); return oc(b); };
      URL.revokeObjectURL = function (u) { window.__urls.revoked += 1; return orv(u); };
      document.getElementById("pasteArea").value = pc;
      document.getElementById("parseButton").click();
      await delay(300);
      document.getElementById("reviewTab").click();
      await delay(300);
      // 合成の大きな PNG(4000x3000)を3枚作る(実データではない)
      const files = [];
      for (let i = 0; i < 3; i++) {
        const c = document.createElement("canvas"); c.width = 4000; c.height = 3000;
        const ctx = c.getContext("2d");
        for (let y = 0; y < 3000; y += 50) for (let x = 0; x < 4000; x += 50) { ctx.fillStyle = `hsl(${(x + y + i * 40) % 360},70%,${40 + ((x * 7 + y * 3) % 30)}%)`; ctx.fillRect(x, y, 50, 50); }
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        files.push(new File([blob], `probe-${i}.png`, { type: "image/png" }));
        c.width = 0; c.height = 0;
      }
      const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f));
      const input = document.getElementById("reviewImages");
      input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      // プレビューが出るまで待つ
      const ok = await (async () => { for (let i = 0; i < 100; i++) { const imgs = [...document.querySelectorAll("#reviewImageList img")]; if (imgs.length === 3 && imgs.every((im) => im.src && im.complete && im.naturalWidth > 0)) return true; await delay(150); } return false; })();
      note(ok, "3 previews did not load");
      const imgs = [...document.querySelectorAll("#reviewImageList img")];
      const dims = imgs.map((im) => [im.naturalWidth, im.naturalHeight]);
      note(dims.every((d) => d[0] <= 1280 && d[1] <= 1280), "preview larger than 1280px: " + JSON.stringify(dims));
      const sizes = await Promise.all(imgs.map((im) => fetch(im.src).then((r) => r.blob()).then((b) => b.size)));
      const originals = files.map((f) => f.size);
      note(sizes.every((s, i) => s < originals[i] / 3), "preview blob not smaller than original/3: " + JSON.stringify([sizes, originals]));
      const created = window.__urls.created.slice();
      note(created.length === 3 && created.every((s) => s < Math.min(...originals) / 3), "object URLs created from full-size blobs: " + JSON.stringify(created));
      return { pass: problems.length === 0, problems, dims, sizes, originals };
    }, "phase1 add images", PCEXPORT);

    // ---- フェーズ2: 項目移動で解放、戻ると再生成。保存は逐次。 ----
    const phase2 = await run(async function () {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const problems = []; const note = (c, m) => { if (!c) problems.push(m); };
      const before = window.__urls.revoked;
      document.getElementById("nextButton").click(); await delay(400);
      note(window.__urls.revoked - before >= 3, "previews of the previous item were not released: revoked=" + (window.__urls.revoked - before));
      note(document.querySelectorAll("#reviewImageList img").length === 0, "item 2 should have no images");
      document.getElementById("prevButton").click();
      const back = await (async () => { for (let i = 0; i < 100; i++) { const imgs = [...document.querySelectorAll("#reviewImageList img")]; if (imgs.length === 3 && imgs.every((im) => im.complete && im.naturalWidth > 0 && im.naturalWidth <= 1280)) return true; await delay(150); } return false; })();
      note(back, "previews did not come back after returning to item 1");
      // 保存: ハッシュ→保存が同時に走らない(arrayBuffer の同時実行数を数える)
      let concurrent = 0, peak = 0;
      const oab = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () { concurrent += 1; peak = Math.max(peak, concurrent); return oab.call(this).then((b) => { concurrent -= 1; return b; }, (e) => { concurrent -= 1; throw e; }); };
      document.getElementById("saveReviewOnlyButton").click();
      const saved = await (async () => { for (let i = 0; i < 200; i++) { const t = (document.getElementById("reviewStatus") || {}).textContent || ""; if (/保存|記録しました|更新/.test(t) && !/記録しています/.test(t)) return t; await delay(150); } return ""; })();
      File.prototype.arrayBuffer = oab;
      note(!!saved, "save did not complete");
      note(peak === 1, "hashing ran concurrently: peak=" + peak);
      return { pass: problems.length === 0, problems, saved, peak };
    }, "phase2 navigate + sequential save");

    // ---- フェーズ3: 再読み込み後、IndexedDB の原寸実体から縮小プレビューが再生成される ----
    await send("Page.reload", {}, sid); await wait(2000);
    const phase3 = await run(async function (originals) {
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const problems = []; const note = (c, m) => { if (!c) problems.push(m); };
      document.getElementById("reviewTab").click();
      const ok = await (async () => { for (let i = 0; i < 100; i++) { const imgs = [...document.querySelectorAll("#reviewImageList img")]; if (imgs.length === 3 && imgs.every((im) => im.complete && im.naturalWidth > 0)) return true; await delay(150); } return false; })();
      note(ok, "previews did not rehydrate after reload");
      const imgs = [...document.querySelectorAll("#reviewImageList img")];
      note(imgs.every((im) => im.naturalWidth <= 1280 && im.naturalHeight <= 1280), "rehydrated preview not downscaled");
      // 実体は原寸のまま(IndexedDB)
      const stored = await new Promise((resolve) => { const req = indexedDB.open("personaGeneratorReviewImages"); req.onsuccess = () => { const db = req.result; const tx = db.transaction(db.objectStoreNames[0], "readonly"); const all = tx.objectStore(db.objectStoreNames[0]).getAll(); all.onsuccess = () => { resolve(all.result.map((r) => r.blob && r.blob.size)); db.close(); }; }; req.onerror = () => resolve([]); });
      const sortedStored = stored.slice().sort((a, b) => a - b), sortedOrig = originals.slice().sort((a, b) => a - b);
      note(JSON.stringify(sortedStored) === JSON.stringify(sortedOrig), "stored blobs are not the full-size originals: " + JSON.stringify([stored, originals]));
      return { pass: problems.length === 0, problems, stored };
    }, "phase3 reload rehydrate", phase1.originals);

    // ---- フェーズ4: A/B 側の縮小器(合成 blob を setPreview 相当の経路で確認: ケース移動時の解放) ----
    const phase4 = await run(async function () {
      const problems = []; const note = (c, m) => { if (!c) problems.push(m); };
      const c = document.createElement("canvas"); c.width = 3000; c.height = 2000; const ctx = c.getContext("2d"); ctx.fillStyle = "#4a6"; ctx.fillRect(0, 0, 3000, 2000); ctx.fillStyle = "#fff"; ctx.fillRect(500, 500, 900, 700);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const cache = window.PersonaPreview.create();
      const url = await cache.urlFor("probe", blob);
      const small = await fetch(url).then((r) => r.blob());
      const bmp = await createImageBitmap(small);
      note(bmp.width <= 1280 && bmp.height <= 1280, "PersonaPreview did not downscale: " + bmp.width + "x" + bmp.height);
      note(small.size < blob.size, "downscaled blob not smaller");
      note(cache.size() === 1, "cache size mismatch");
      cache.releaseExcept({}); note(cache.size() === 0, "releaseExcept did not clear");
      const tiny = new Blob([new Uint8Array(1000)], { type: "image/png" });
      const u2 = await cache.urlFor("tiny", tiny); note(!!u2, "small/undecodable blob must still yield a URL (fallback to original)");
      return { pass: problems.length === 0, problems, size: [blob.size, small.size], dims: [bmp.width, bmp.height] };
    }, "phase4 PersonaPreview unit");

    const errs = events.filter((m) => m.method === "Runtime.exceptionThrown");
    if (errs.length) fail("page threw exceptions", errs.map((m) => m.params.exceptionDetails.text).slice(0, 3));
    console.log("phase1:", JSON.stringify({ dims: phase1.dims, sizes: phase1.sizes, originals: phase1.originals }));
    console.log("phase2:", JSON.stringify({ saved: phase2.saved, peakConcurrentReads: phase2.peak }));
    console.log("phase3:", JSON.stringify({ storedSizes: phase3.stored }));
    console.log("phase4:", JSON.stringify({ size: phase4.size, dims: phase4.dims }));
    console.log("PREVIEW MEMORY BROWSER ACCEPTANCE PASSED");
  } finally {
    if (sock) sock.close();
    await closeChrome(chrome);
    await new Promise((r) => server.close(r));
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}
main().catch((e) => { console.error("FAIL:", e.message); if (e.detail !== undefined) console.error(JSON.stringify(e.detail, null, 1).slice(0, 2000)); process.exit(1); });
