#!/usr/bin/env node
// [R5B] 公開反映の確認。GitHub Pages に載った版そのものを実ブラウザで通す。
//
//   node scripts/verify_deployed_r5b.cjs [URL]
//   既定 URL = https://sgktmr808.github.io/persona_generator/
//
//  確かめること:
//   1. 配信されている HTML が R5B の版であること(古いキャッシュを完成扱いしない)
//   2. 合成の宣言付きパッケージで「狙いとの一致」が出て、設問文も選択肢もパッケージから読むこと
//   3. A/B 各2枚を登録し、画像を往復しても全入力が復元すること
//   4. 未入力が1枚でも残る間は保存も書き出しも通らず、残数が画面へ出ること
//   5. 埋めれば保存でき、書き出しに診断値と画像ハッシュが出ること
//   6. デスクトップと iPhone 各幅・横向きで横溢れ0・44px以上・入力16px以上
//
//  使うのは合成フィクスチャのみ。公開先へ実験の中身は送らない
//  (ページはサーバーを持たない静的サイトで、記録は端末内にしか保存されない)。
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


const { buildIntentPackage, INTENT_STATUSES, INTENT_QUESTION } = require("./_r5b_fixtures.cjs");

const DEPLOYED_URL = process.argv[2] || "https://sgktmr808.github.io/persona_generator/";
const REVISION_MARKERS = [
  "opticalIntentAlignmentRequired",
  "opticalIntentAlignmentStatuses",
  "syncOpticalIntentForm",
  "unevaluatedImages",
  "すべて評価するまで書き出せません",
  "failureCodeLabels"
];

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then((t) => { clearTimeout(timer); resolve(t); })
      .catch((e) => { clearTimeout(timer); reject(e); });
  });
}

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(120); }
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
  const activeWsEntry = () => {
    let i = null;
    try { i = JSON.parse(localStorage.getItem(WS_INDEX_KEY)); } catch (_) { i = null; }
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
  const rid = (arm, name) => "abRev" + arm + "_" + name;
  const intentSelect = (arm) => byId(rid(arm, "opticalIntentValue"));
  const intentHead = (arm) => byId(rid(arm, "opticalIntentHead"));
  const setIntent = (arm, v) => setVal(rid(arm, "opticalIntentValue"), v);
  const setSide = (arm, verdict, aes, intent, notes, intentValue) => {
    setVal(rid(arm, "verdict"), verdict);
    setVal(rid(arm, "aestheticSatisfaction"), aes);
    setVal(rid(arm, "intentMatch"), intent);
    setVal(rid(arm, "notes"), notes);
    if (intentValue !== undefined) setIntent(arm, intentValue);
  };
  const readSide = (arm) => ({
    verdict: byId(rid(arm, "verdict")).value,
    aes: byId(rid(arm, "aestheticSatisfaction")).value,
    intent: byId(rid(arm, "intentMatch")).value,
    notes: byId(rid(arm, "notes")).value,
    intentValue: intentSelect(arm) ? intentSelect(arm).value : null
  });
  const thumbs = (arm) => Array.prototype.slice.call(byId("abThumbs" + arm).querySelectorAll("img"));
  const selectThumb = async (arm, i) => { thumbs(arm)[i].click(); await delay(220); };
  const flowText = () => (byId("abFlowState") || {}).textContent || "";
  const openAbTab = async () => {
    await waitFor(() => document.readyState === "complete", "ready");
    byId("abTab").click();
    await waitFor(() => byId("abView").hidden === false, "ab view");
    await delay(300);
  };
`;

function phaseRun(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    await openAbTab();
    // 使い捨てプロファイルなので保存済みは無い。選択画面からそのまま読み込む。
    loadPkg(a.pkg, "deployed-optical-intent.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "package loaded");
    await waitFor(() => byId("abSetup").hidden === false, "setup");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    await delay(250);

    note(!!intentSelect("A") && !!intentSelect("B"), "狙いとの一致が出ていない");
    note(intentHead("A").textContent === a.question,
      "設問文がパッケージのものでない: " + intentHead("A").textContent);
    const opts = Array.prototype.slice.call(intentSelect("A").options).map((o) => o.value);
    note(JSON.stringify(opts) === JSON.stringify([""].concat(a.statuses)),
      "選択肢がパッケージと違う: " + JSON.stringify(opts));

    await pickImage("A", "d-a1.png", 61); await pickImage("A", "d-a2.png", 62);
    await pickImage("B", "d-b1.png", 63); await pickImage("B", "d-b2.png", 64);
    note(thumbs("A").length === 2 && thumbs("B").length === 2,
      "A/B各2枚になっていない: " + thumbs("A").length + "/" + thumbs("B").length);

    await selectThumb("A", 0);
    setSide("A", "accept", "5", "4", "1枚目", a.statuses[0]);
    await delay(120);
    const first = readSide("A");
    await selectThumb("A", 1);
    setSide("A", "hold", "2", "3", "2枚目", a.statuses[2]);
    await delay(120);
    await selectThumb("A", 0);
    note(JSON.stringify(readSide("A")) === JSON.stringify(first),
      "画像を往復すると入力が復元しない: " + JSON.stringify(readSide("A")));

    await selectThumb("B", 0);
    setSide("B", "accept", "4", "5", "B1", a.statuses[1]);
    await delay(100);
    await selectThumb("B", 1);
    setSide("B", "reject", "1", "2", "B2", "");
    await delay(200);

    // 未入力が1枚残る間は保存も書き出しも通らない
    setVal("abPreference", "tie");
    await delay(200);
    note(/狙いとの一致が 1 件/.test(flowText()), "未入力の残数が出ていない: " + flowText());
    note(byId("abSaveNext").disabled === true, "未入力なのに保存が押せる");
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await delay(400);
    note(/未評価の画像が 1 枚あります/.test(st()), "未入力なのに書き出しが通った: " + st());

    // 埋めると保存でき、書き出しに診断値と画像ハッシュが出る
    setIntent("B", a.statuses[4]);
    await delay(250);
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled");
    byId("abSaveNext").click();
    await waitFor(() => (store().reviews || []).length >= 4, "saved");
    const saved = store().reviews;
    note(saved.filter((r) => !!r.opticalIntentAlignment).length === 4,
      "保存へ診断値が入っていない: " + saved.filter((r) => !!r.opticalIntentAlignment).length);

    const orig = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "exported");
    const text = await captured.text();
    URL.createObjectURL = orig;
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    const images = rows.reduce((acc, r) => acc.concat(r.images), []);
    note(images.length === 4, "書き出しの画像が4枚でない: " + images.length);
    note(images.every((im) => a.statuses.indexOf(im.evaluation.opticalIntentAlignment) >= 0),
      "書き出しへ診断値が出ていない");
    note(images.every((im) => /^[0-9a-f]{64}$/.test(im.metadata.sha256)), "画像ハッシュが欠けている");
    return { pass: problems.length === 0, problems, rows: rows.length, images: images.length };
  })(__ARG__);
}

// レイアウトは「画像も評価もある状態」で測る。保存すると次のケースへ進むので戻す。
function phaseBackToEvaluated() {
  return (async () => {
    __PRELUDE__
    if (!/ケース 1 \/ 2/.test((byId("abCaseCounter") || {}).textContent || "")) {
      byId("abPrev").click();
      await waitFor(() => /ケース 1 \/ 2/.test((byId("abCaseCounter") || {}).textContent || ""), "case 1");
    }
    await delay(300);
    await selectThumb("A", 0);
    await selectThumb("B", 0);
    await delay(250);
    note(!!intentSelect("A") && intentSelect("A").getClientRects().length > 0,
      "レイアウト測定の前提が整っていない（項目が見えていない）");
    return { pass: problems.length === 0, problems };
  })();
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
    ["A", "B"].forEach((arm) => {
      const n = intentSelect(arm);
      note(!!n, a.label + " の " + arm + " に項目が無い");
      if (!n) return;
      const r = n.getBoundingClientRect();
      note(r.height >= 44, a.label + " の " + arm + " の入力が44px未満: " + Math.round(r.height));
      note(parseFloat(getComputedStyle(n).fontSize) >= 16, a.label + " の " + arm + " の入力が16px未満");
      const head = intentHead(arm);
      note(head.scrollWidth <= head.clientWidth + 1, a.label + " の設問文が横に溢れている");
    });
    if (de.clientWidth >= 720) {
      const ra = intentSelect("A").getBoundingClientRect();
      const rb = intentSelect("B").getBoundingClientRect();
      note(Math.abs(ra.top - rb.top) <= 1, a.label + " で A/B の項目の上端がずれている");
    }
    return { pass: problems.length === 0, problems, label: a.label, overflow, vw: de.clientWidth };
  })(__ARG__);
}

async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (typeof fetch !== "function") fail("Node.js fetch global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  console.log("=== R5B 公開反映の確認 ===");
  console.log("URL: " + DEPLOYED_URL);
  const html = await fetchText(DEPLOYED_URL + (DEPLOYED_URL.indexOf("?") >= 0 ? "&" : "?")
    + "cachebust=" + Date.now(), 30000);
  const missing = REVISION_MARKERS.filter((m) => html.indexOf(m) < 0);
  if (missing.length) fail("配信されている版が R5B ではありません（キャッシュされた旧版の可能性）", missing);
  const htmlSha = crypto.createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");
  console.log(`  R5B の目印 ${REVISION_MARKERS.length} 件すべてを確認  配信 HTML SHA-256=${htmlSha}`);

  const pkg = buildIntentPackage();
  const statuses = INTENT_STATUSES.map((s) => s.value);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b-deployed-"));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "r5b-deployed-dl-"));
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
    const target = await client.send("Target.createTarget", { url: DEPLOYED_URL });
    const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Page.enable", {}, sessionId);
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await wait(2500);

    const run = async (fn, label, arg, timeout = 240000) => {
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

    const ran = await run(phaseRun, "deployed page records the item end to end",
      { pkg, question: INTENT_QUESTION, statuses });

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    await run(phaseBackToEvaluated, "return to the evaluated case for layout");
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layout.push(await run(phaseLayout, "deployed layout / " + spec.label, { label: spec.label }, 90000));
    }

    const captured = fs.readdirSync(downloadDir);
    const leaked = [...snapshotDownloads()].filter((n) => !beforeDownloads.has(n));
    if (leaked.length) fail("確認の書き出しが利用者の Downloads へ出た", leaked);

    console.log("R5B DEPLOYED VERIFICATION PASSED");
    console.log(`  deployed revision carries every R5B marker (html sha256 ${htmlSha})`);
    console.log(`  the item read its question and five options from the package on the deployed page`);
    console.log(`  two images per arm; image round trip restored every value`);
    console.log(`  one unanswered image blocked save and export and printed the remaining count`);
    console.log(`  export carried ${ran.rows} rows / ${ran.images} images with the item and the image hashes`);
    console.log(`  layout: ${layout.map((l) => `${l.vw}px overflow ${l.overflow}px`).join(" | ")}`);
    console.log(`  ${captured.length} export downloads stayed in the disposable directory; user Downloads gained 0 files`);
  } finally {
    if (client) {
      try { await client.send("Browser.setDownloadBehavior", { behavior: "deny" }); } catch (_) { /* noop */ }
      client.close();
    }
    await closeChrome(chrome);
    await removeDirWithRetry(userDataDir);
    await removeDirWithRetry(downloadDir);
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  if (error && error.detail !== undefined) console.error(JSON.stringify(error.detail, null, 2));
  process.exit(1);
});
