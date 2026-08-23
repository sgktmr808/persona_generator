#!/usr/bin/env node
// 追加レビュー項目(policy.reviewChoiceItems)と交互キュー(slotSequencing)の**実ブラウザ**受入検査。
//  合成フィクスチャのみを使い、実験の実データ・本文・ID・語彙・評価値・閾値は一切含まない。
//
//  確かめること:
//   1. 宣言の無い既存パッケージでは項目も保存キーも1つも増えない
//   2. 壊れた宣言(識別子・重複・選択肢不足・説明の空・並べ方の不整合)は1つずつ拒否される
//   3. 交互キューが12手順・A/B交互・各面6枚で提示され、同じ面が連続しない
//   4. まとめ撮りの宣言（従来型）は従来どおりの並びのまま
//   5. 押した「この本文をコピー」自身に成功・失敗・再試行が出る
//   6. 各選択肢の意味がその場に表示される（専門語だけに依存しない）
//   7. 画像切替・ケース移動・再読み込みで全評価値が復元する
//   8. 必須項目が1つでも空なら保存・書き出しを拒否し、残数を画面へ出す（任意項目は止めない）
//   9. 書き出し・再取込で画像数・SHA-256・全評価値が一致する
//  10. 1280 / 320 / 375 / 390 / 430 / 844x390 で横溢れ0・操作44px以上・入力16px以上
//  11. 検査の書き出しが利用者の Downloads へ1件も出ない
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
// 合成フィクスチャは受入検査と公開反映の確認で共有する(片方だけ古くならないようにする)。
const { buildChoicePackage, buildLegacyPackage, buildGroupedPackage, buildRejectFixtures,
  REQUIRED_ITEM, OPTIONAL_ITEM, PER_ARM } = require("./_review_choice_fixtures.cjs");

const PRELUDE = `
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (p, l, t = 30000) => {
    const s = Date.now();
    while (Date.now() - s < t) { try { if (await p()) return true; } catch (_) {} await delay(100); }
    throw new Error("timeout " + l + " :: " + ((document.getElementById("abStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abPackageStatus")||{}).textContent||"")
      + " / " + ((document.getElementById("abGuidedMsg")||{}).textContent||""));
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
  const confirmVisible = () => { const n = byId("abConfirm"); return !!n && n.hidden === false; };
  const startConfirmed = async () => {
    await waitFor(() => confirmVisible(), "confirm card");
    byId("abConfirmStart").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after confirm");
  };
  const rid = (arm, name) => "abRev" + arm + "_" + name;
  const choiceHost = (arm) => byId(rid(arm, "choices"));
  const choiceGroup = (arm, key) => byId(rid(arm, "choiceGroup_" + key));
  const choiceHead = (arm, key) => byId(rid(arm, "choiceHead_" + key));
  const getChoice = (arm, key) => {
    const g = choiceGroup(arm, key);
    if (!g) return null;
    const rows = g.querySelectorAll("input[type=radio]");
    for (let i = 0; i < rows.length; i += 1) if (rows[i].checked) return rows[i].value;
    return "";
  };
  const setChoice = (arm, key, value) => {
    const g = choiceGroup(arm, key);
    if (!g) { problems.push("missing choice group " + arm + "/" + key); return; }
    const rows = g.querySelectorAll("input[type=radio]");
    let hit = false;
    for (let i = 0; i < rows.length; i += 1) {
      const want = rows[i].value === value && !!value;
      if (rows[i].checked !== want) rows[i].checked = want;
      if (want) hit = true;
    }
    if (value && !hit) problems.push("missing choice value " + value);
    g.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setSide = (arm, verdict, aes, intent, notes, required, optional, failures) => {
    setVal(rid(arm, "verdict"), verdict);
    setVal(rid(arm, "aestheticSatisfaction"), aes);
    setVal(rid(arm, "intentMatch"), intent);
    if (notes !== undefined) setVal(rid(arm, "notes"), notes);
    if (required !== undefined) setChoice(arm, "fixtureJointState", required);
    if (optional !== undefined) setChoice(arm, "fixtureOptionalNote", optional);
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
    required: getChoice(arm, "fixtureJointState"),
    optional: getChoice(arm, "fixtureOptionalNote"),
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
    await delay(200);
  };
  const flowText = () => (byId("abFlowState") || {}).textContent || "";
  const gTarget = () => (byId("abGuidedTarget")||{}).textContent || "";
  const gMsg = () => (byId("abGuidedMsg")||{}).textContent || "";
  const gCardVisible = () => { const n = byId("abGuided"); return !!n && n.hidden === false; };
  const imagesOf = () => (store().images || []);
  const guidedPut = async (name, seed) => {
    const before = imagesOf().length;
    byId("abGuidedMsg").textContent = "";
    const n = byId("abGuidedFile");
    n.files = await files(name, seed);
    n.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => imagesOf().length !== before || gMsg() !== "", "guided put " + name);
    await delay(70);
  };
  const parseTarget = () => {
    const m = gTarget().match(/ケース\\s*([A-Z]+-\\d+)・([AB])・(\\d+)枚目/);
    return m ? { caseId: m[1], slot: m[2], rank: Number(m[3]) } : null;
  };
`;

// ---------------------------------------------------------------------------
// 1: 宣言の無いパッケージでは項目も保存キーも1つも増えない
// ---------------------------------------------------------------------------
function phaseLegacy(pkg) {
  return (async (p) => {
    __PRELUDE__
    await openAbTab();
    loadPkg(p, "legacy-choice.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "legacy loaded");
    await waitFor(() => byId("abSetup").hidden === false, "setup");
    byId("abSetupChatgpt").click();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench");
    note(!!choiceHost("A") && choiceHost("A").hidden === true, "宣言が無いのに追加項目の入れ物が出ている");
    note(!choiceGroup("A", "fixtureJointState") && !choiceGroup("B", "fixtureJointState"),
      "宣言が無いのに追加項目が出ている");
    await pickImage("A", "lg-a1.png", 11); await pickImage("A", "lg-a2.png", 12);
    await pickImage("B", "lg-b1.png", 13); await pickImage("B", "lg-b2.png", 14);
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 2; i += 1) {
        await selectThumb(arm, i);
        setVal(rid(arm, "verdict"), "accept");
        setVal(rid(arm, "aestheticSatisfaction"), "4");
        setVal(rid(arm, "intentMatch"), "4");
        setVal(rid(arm, "notes"), "従来の記録 " + arm + i);
        await delay(70);
      }
    }
    setVal("abPreference", "tie");
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled (legacy)");
    byId("abSaveNext").click();
    await waitFor(() => (store().reviews || []).length === 4, "legacy reviews saved");
    const saved = store().reviews;
    note(saved.every((r) => !("reviewChoices" in r)), "宣言の無いパッケージの保存へ新しいキーが入った");
    note(saved.every((r) => !("opticalIntentAlignment" in r) && !("focusAssessment" in r)),
      "宣言の無いパッケージへ他の追加項目が入った");
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
// 3: まとめ撮りの宣言（従来型）は従来どおりの並び
// ---------------------------------------------------------------------------
function phaseGrouped(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(a.pkg, "grouped-choice.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "grouped loaded");
    await startConfirmed();
    note(gCardVisible(), "まとめ撮りの案内カードが出ていない");
    const first = parseTarget();
    note(!!first && first.slot === "B" && first.rank === 1,
      "最初の手順が B1 でない: " + gTarget());
    await guidedPut("gp-1.png", 501);
    await delay(120);
    const second = parseTarget();
    note(!!second && second.slot === "B" && second.rank === 2,
      "まとめ撮りなのに2手順目が同じ面でない: " + gTarget());
    return { pass: problems.length === 0, problems, first: gTarget() };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 4: 交互キュー — 12手順・A/B交互・各面6枚
// ---------------------------------------------------------------------------
function phaseAlternating(arg) {
  return (async (a) => {
    __PRELUDE__
    window.confirm = () => true;
    loadPkg(a.pkg, "review-choice.json");
    await waitFor(() => /読み込みました/.test(byId("abPackageStatus").textContent), "choice loaded");
    await startConfirmed();
    note(gCardVisible(), "案内カードが出ていない");
    note(!/control|treatment|対照|処理群/.test(byId("abGuided").textContent),
      "案内カードに役割語が出ている");

    // 「この本文をコピー」— 成功・失敗・再試行が**押したボタン自身**に出る
    {
      const btn = byId("abGuidedCopy");
      note(btn.textContent === "この本文をコピー", "コピーボタンの文言が違う: " + btn.textContent);
      const label = btn.textContent;
      const realClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
        || Object.getOwnPropertyDescriptor(navigator, "clipboard");
      const realExec = document.execCommand;
      let copied = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true, value: { writeText: (t) => { copied = t; return Promise.resolve(); } }
      });
      btn.click();
      await waitFor(() => btn.getAttribute("data-copy-state") === "success", "guided copy success state");
      note(/コピーしました/.test(btn.textContent), "成功が押したボタンに出ていない: " + btn.textContent);
      note(btn.classList.contains("flash-ok"), "成功の色が押したボタンに付いていない");
      note(typeof copied === "string" && copied.length > 0, "本文が渡っていない");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) }
      });
      document.execCommand = () => false;
      btn.click();
      await waitFor(() => btn.getAttribute("data-copy-state") === "error", "guided copy error state");
      note(/再試行/.test(btn.textContent), "再試行の案内が押したボタンに出ていない: " + btn.textContent);
      note(btn.classList.contains("flash-err"), "失敗の色が押したボタンに付いていない");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true, value: { writeText: () => Promise.resolve() }
      });
      document.execCommand = realExec;
      btn.click();
      await waitFor(() => btn.getAttribute("data-copy-state") === "success", "guided copy success again");
      await waitFor(() => btn.getAttribute("data-copy-state") === "idle", "guided copy returns to idle", 9000);
      note(btn.textContent === label, "ボタンの文言が元へ戻らない: " + btn.textContent);
      if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
      else delete navigator.clipboard;
    }

    const seen = [];
    for (let step = 1; step <= a.total; step += 1) {
      const t = parseTarget();
      if (!t) { problems.push("手順 " + step + " の目標を読めない: " + gTarget()); break; }
      seen.push(t.slot + t.rank);
      note(gTarget().indexOf(String(step)) >= 0, "手順 " + step + " の通し番号が出ていない: " + gTarget());
      await guidedPut("alt-" + step + ".png", 600 + step);
      await delay(60);
    }
    note(seen.length === a.total, "12手順を回れていない: " + seen.join(" "));
    note(JSON.stringify(seen) === JSON.stringify(a.expected),
      "並びが交互でない: " + seen.join(" ") + " 期待 " + a.expected.join(" "));
    for (let i = 1; i < seen.length; i += 1) {
      note(seen[i][0] !== seen[i - 1][0], "同じ面が連続した: " + seen.join(" "));
    }
    ["A", "B"].forEach((slot) => {
      note(seen.filter((s) => s[0] === slot).length === 6,
        slot + " 面が6枚でない: " + seen.filter((s) => s[0] === slot).length);
    });
    await waitFor(() => byId("abGuidedDone").hidden === false, "start review appears");
    byId("abGuidedStartReview").click();
    await waitFor(() => byId("abGuidedDone").hidden === true || !gCardVisible()
      || /評価中/.test((byId("abGuidedPhase")||{}).textContent||""), "review phase");
    await delay(300);
    note(thumbs("A").length === 6 && thumbs("B").length === 6,
      "評価画面の枚数が6/6でない: " + thumbs("A").length + "/" + thumbs("B").length);
    return { pass: problems.length === 0, problems, seen };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 5: 押した「この本文をコピー」自身に成功・失敗・再試行が出る
// ---------------------------------------------------------------------------
function phaseCopyState() {
  return (async () => {
    __PRELUDE__
    // 評価画面側の「本文をコピー」も、押したボタン自身に状態が出る（波及の確認）。
    const btn = byId("abCopyA");
    const label = btn.textContent;
    const realClipboard = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard")
      || Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const realExec = document.execCommand;

    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: () => Promise.resolve() }
    });
    btn.click();
    await waitFor(() => btn.getAttribute("data-copy-state") === "success", "copy success state");
    note(/コピーしました/.test(btn.textContent), "成功が押したボタンに出ていない: " + btn.textContent);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) }
    });
    document.execCommand = () => false;
    btn.click();
    await waitFor(() => btn.getAttribute("data-copy-state") === "error", "copy error state");
    note(/再試行/.test(btn.textContent), "再試行の案内が押したボタンに出ていない: " + btn.textContent);

    Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: () => Promise.resolve() }
    });
    document.execCommand = realExec;
    btn.click();
    await waitFor(() => btn.getAttribute("data-copy-state") === "success", "copy success again");
    await waitFor(() => btn.getAttribute("data-copy-state") === "idle", "copy state returns to idle", 9000);
    note(btn.textContent === label, "ボタンの文言が元へ戻らない: " + btn.textContent);

    if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
    else delete navigator.clipboard;
    return { pass: problems.length === 0, problems };
  })();
}

// ---------------------------------------------------------------------------
// 6: 項目が出る・意味がその場に出る・往復で復元する
// ---------------------------------------------------------------------------
function phaseRoundTrip(arg) {
  return (async (a) => {
    __PRELUDE__
    note(!!choiceGroup("A", "fixtureJointState") && !!choiceGroup("B", "fixtureJointState"),
      "必須の追加項目が出ていない");
    note(!!choiceGroup("A", "fixtureOptionalNote"), "任意の追加項目が出ていない");
    note(choiceHead("A", "fixtureJointState").textContent === a.question,
      "設問文がパッケージのものでない: " + choiceHead("A", "fixtureJointState").textContent);
    const rows = Array.prototype.slice.call(
      choiceGroup("A", "fixtureJointState").querySelectorAll("[data-ab-choice-value]"));
    note(rows.length === a.options.length, "選択肢の数が違う: " + rows.length);
    note(JSON.stringify(rows.map((r) => r.getAttribute("data-ab-choice-value"))) === JSON.stringify(a.values),
      "選択肢の値がパッケージと違う");
    rows.forEach((r, i) => {
      const label = r.querySelector(".ab-choice-label");
      const desc = r.querySelector(".ab-choice-desc");
      note(!!label && label.textContent === a.labels[i], "選択肢の短文が違う: " + (label && label.textContent));
      note(!!desc && desc.textContent === a.descriptions[i],
        "選択肢の意味がその場に出ていない: " + (desc && desc.textContent));
      const rect = r.getBoundingClientRect();
      note(rect.height >= 44, "選択肢の操作領域が44px未満: " + Math.round(rect.height));
    });
    note(!/control|treatment|対照|処理群/.test(byId("abReviewA").textContent),
      "レビュー欄に役割語が出ている");

    await selectThumb("A", 0);
    setSide("A", "accept", "5", "4", "1枚目のコメント", a.values[0], "fx_yes", ["composition"]);
    await delay(120);
    const first = readSide("A");
    note(first.required === a.values[0], "1枚目の必須項目が入っていない: " + first.required);

    await selectThumb("A", 1);
    const blank = readSide("A");
    note(blank.verdict === "" && blank.required === "",
      "2枚目へ切替えたのに1枚目の入力が残っている: " + JSON.stringify(blank));
    setSide("A", "hold", "2", "3", "2枚目のコメント", a.values[1], "", ["anatomy"]);
    await delay(120);

    await selectThumb("A", 0);
    const back = readSide("A");
    note(JSON.stringify(back) === JSON.stringify(first),
      "1枚目へ戻したのに入力が復元しない: " + JSON.stringify(back) + " 期待 " + JSON.stringify(first));

    // 残り4枚と B 面をすべて埋める（必須項目は全枚数で埋める）
    for (let i = 2; i < 6; i += 1) {
      await selectThumb("A", i);
      setSide("A", "accept", "3", "3", "A" + i, a.values[i % a.values.length], "");
      await delay(70);
    }
    for (let i = 0; i < 6; i += 1) {
      await selectThumb("B", i);
      setSide("B", "accept", "4", "4", "B" + i, a.values[(i + 1) % a.values.length], "");
      await delay(70);
    }
    return { pass: problems.length === 0, problems, first };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 7: 必須が空なら保存も書き出しも止まる。任意は止めない
// ---------------------------------------------------------------------------
function phaseIncomplete(arg) {
  return (async (a) => {
    __PRELUDE__
    await selectThumb("B", 5);
    setChoice("B", "fixtureJointState", "");
    await delay(200);
    note(new RegExp(a.label + "が 1 件").test(flowText()),
      "未入力の残数が画面へ出ていない: " + flowText());
    setVal("abPreference", "tie");
    await delay(150);
    note(byId("abSaveNext").disabled === true, "必須項目が空でも保存が押せる");
    const beforeReviews = (store().reviews || []).length;
    byId("abStatus").textContent = "";
    byId("abSaveNext").click();
    await delay(300);
    note((store().reviews || []).length === beforeReviews, "未入力なのに保存された");

    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await delay(400);
    note(/未評価の画像が 1 枚あります/.test(st()), "未入力なのに書き出しが通った: " + st());
    note(/すべて評価するまで書き出せません/.test(st()), "書き出せない理由が出ていない: " + st());

    setChoice("B", "fixtureJointState", a.values[0]);
    await delay(250);
    note(!new RegExp(a.label + "が").test(flowText()), "埋めたのに残数が残っている: " + flowText());
    // 任意項目はどこも空のままだが、完了を止めない
    note(getChoice("B", "fixtureOptionalNote") === "", "任意項目に値が入っている");
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled after filling");
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 8: ケース復帰・再読み込みで全値が復元する
// ---------------------------------------------------------------------------
function phaseSnapshot() {
  return (async () => {
    __PRELUDE__
    const before = { A: [], B: [] };
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 6; i += 1) { await selectThumb(arm, i); before[arm].push(readSide(arm)); }
    }
    return { pass: problems.length === 0, problems, before };
  })(__ARG__);
}
function phaseAfterReload(arg) {
  return (async (a) => {
    __PRELUDE__
    await openAbTab();
    await waitFor(() => byId("abWorkbench").hidden === false, "workbench after reload");
    await delay(400);
    note(!!choiceGroup("A", "fixtureJointState"), "再読み込みで項目が消えた");
    note(choiceHead("A", "fixtureJointState").textContent === a.question, "再読み込みで設問文が変わった");
    note(thumbs("A").length === 6 && thumbs("B").length === 6,
      "再読み込みで画像が復元しない: " + thumbs("A").length + "/" + thumbs("B").length);
    const after = { A: [], B: [] };
    for (const arm of ["A", "B"]) {
      for (let i = 0; i < 6; i += 1) { await selectThumb(arm, i); after[arm].push(readSide(arm)); }
    }
    note(JSON.stringify(after) === JSON.stringify(a.before),
      "再読み込みで入力が復元しない: " + JSON.stringify(after));
    return { pass: problems.length === 0, problems };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 9: 保存 → 書き出し → 再取込で件数・SHA-256・全評価値が一致する
// ---------------------------------------------------------------------------
function phaseSaveAndExport(arg) {
  return (async (a) => {
    __PRELUDE__
    setVal("abPreference", "A");
    await waitFor(() => byId("abSaveNext").disabled === false, "save enabled");
    byId("abSaveNext").click();
    await waitFor(() => (store().reviews || []).length >= 12, "reviews saved");
    const saved = (store().reviews || []);
    const withChoice = saved.filter((r) => r.reviewChoices && r.reviewChoices.fixtureJointState);
    note(withChoice.length === 12, "追加項目つきの記録が12件でない: " + withChoice.length);
    note(withChoice.every((r) => a.values.indexOf(r.reviewChoices.fixtureJointState) >= 0),
      "宣言外の値が保存された");
    note(Object.keys(store().reviewDrafts || {}).length === 0, "保存後に下書きが残っている");

    const orig = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = function (b) { captured = b; return orig.call(URL, b); };
    byId("abStatus").textContent = "";
    byId("abExportReviews").click();
    await waitS(/書き出しました/, "reviews exported");
    const text = await captured.text();
    URL.createObjectURL = orig;
    const rows = text.trim().split("\n").map((l) => JSON.parse(l));
    note(rows.length === 2, "書き出し行数が2でない: " + rows.length);
    const images = rows.reduce((acc, r) => acc.concat(r.images), []);
    note(images.length === 12, "書き出しの画像が12枚でない: " + images.length);
    note(images.every((im) => a.values.indexOf(im.evaluation.fixtureJointState) >= 0),
      "書き出しへ必須項目が出ていない: "
      + JSON.stringify(images.map((im) => im.evaluation.fixtureJointState)));
    note(images.every((im) => !("focusAssessment" in im.evaluation)
      && !("opticalIntentAlignment" in im.evaluation)),
      "宣言していない項目が書き出しへ出た");
    note(images.filter((im) => im.evaluation.fixtureOptionalNote).length === 1,
      "任意項目が入れた1件だけになっていない: "
      + images.filter((im) => im.evaluation.fixtureOptionalNote).length);
    note(images.every((im) => im.metadata && /^[0-9a-f]{64}$/.test(im.metadata.sha256)),
      "書き出しの画像に SHA-256 が無い");
    note(new Set(images.map((im) => im.metadata.sha256)).size === 12, "画像の SHA-256 が一意でない");

    // 端末の記録と書き出しの突き合わせ（画像単位）
    const byImage = new Map(images.map((im) => [im.imageId, im]));
    const mismatches = [];
    saved.forEach((r) => {
      const im = byImage.get(r.imageId);
      if (!im) { mismatches.push(r.imageId + ":missing"); return; }
      if (String(im.evaluation.verdict) !== String(r.verdict)) mismatches.push(r.imageId + ":verdict");
      if (String(im.evaluation.aestheticSatisfaction) !== String(r.scores.aestheticSatisfaction)) {
        mismatches.push(r.imageId + ":aes");
      }
      if (String(im.evaluation.intentMatch) !== String(r.scores.intentMatch)) mismatches.push(r.imageId + ":intent");
      if (String(im.evaluation.fixtureJointState || "")
        !== String((r.reviewChoices || {}).fixtureJointState || "")) mismatches.push(r.imageId + ":choice");
      if (JSON.stringify((im.evaluation.failures || []).slice().sort())
        !== JSON.stringify((r.failures || []).slice().sort())) mismatches.push(r.imageId + ":failures");
      if (String(im.notes || "") !== String(r.notes || "")) mismatches.push(r.imageId + ":notes");
    });
    note(mismatches.length === 0, "端末の記録と書き出しが食い違う: " + mismatches.join(", "));
    const exported = images.map((im) => ({
      imageId: im.imageId, rank: im.rank, sha256: im.metadata.sha256,
      verdict: im.evaluation.verdict,
      aes: im.evaluation.aestheticSatisfaction, intent: im.evaluation.intentMatch,
      required: im.evaluation.fixtureJointState || "",
      optional: im.evaluation.fixtureOptionalNote || "",
      failures: (im.evaluation.failures || []).slice().sort(), notes: im.notes || ""
    })).sort((x, y) => (x.imageId < y.imageId ? -1 : 1));
    return { pass: problems.length === 0, problems, rows: rows.length, images: images.length, exported };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 10: 再取込 — 書き出したものを読み直して端末の記録と全一致
// ---------------------------------------------------------------------------
function phaseReimport(arg) {
  return (async (a) => {
    __PRELUDE__
    const current = [];
    (store().images || []).forEach((r) => {
      const rev = (store().reviews || []).filter((x) => x.imageId === r.imageId).slice(-1)[0];
      if (!rev) return;
      current.push({
        imageId: r.imageId, rank: r.rank, sha256: r.metadata.sha256,
        verdict: rev.verdict,
        aes: String(rev.scores.aestheticSatisfaction), intent: String(rev.scores.intentMatch),
        required: String((rev.reviewChoices || {}).fixtureJointState || ""),
        optional: String((rev.reviewChoices || {}).fixtureOptionalNote || ""),
        failures: (rev.failures || []).slice().sort(), notes: rev.notes || ""
      });
    });
    current.sort((x, y) => (x.imageId < y.imageId ? -1 : 1));
    note(current.length === a.exported.length,
      "再取込の件数が違う: " + current.length + " / " + a.exported.length);
    note(JSON.stringify(current) === JSON.stringify(a.exported),
      "再取込で値が一致しない: " + JSON.stringify(current.slice(0, 2)));
    return { pass: problems.length === 0, problems, count: current.length };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
// 11: レイアウト
// ---------------------------------------------------------------------------
function phaseLayout(arg) {
  return (async (a) => {
    __PRELUDE__
    await delay(220);
    const de = document.documentElement;
    const overflow = Math.max(0, de.scrollWidth - de.clientWidth);
    note(overflow === 0, a.label + " で横溢れ " + overflow + "px");
    const wide = [];
    document.querySelectorAll("#abView *").forEach((n) => {
      if (!n.getClientRects().length) return;
      const r = n.getBoundingClientRect();
      if (r.width > de.clientWidth + 1) wide.push(n.id || n.className || n.tagName);
    });
    note(wide.length === 0, a.label + " で幅を超える要素: " + wide.slice(0, 4).join(", "));
    // A/B の追加項目が同じ基準線・高さ
    const ga = choiceGroup("A", "fixtureJointState");
    const gb = choiceGroup("B", "fixtureJointState");
    if (ga && gb && ga.getClientRects().length && gb.getClientRects().length
      && de.clientWidth >= 720) {
      const ra = ga.getBoundingClientRect();
      const rb = gb.getBoundingClientRect();
      note(Math.abs(ra.top - rb.top) <= 1, a.label + " で A/B の追加項目の上端がずれている: "
        + Math.abs(ra.top - rb.top));
      note(Math.abs(ra.height - rb.height) <= 1, a.label + " で A/B の追加項目の高さが違う");
    }
    // 選択肢はどの幅でも44px以上
    if (ga) {
      Array.prototype.slice.call(ga.querySelectorAll("[data-ab-choice-value]")).forEach((r) => {
        if (!r.getClientRects().length) return;
        note(r.getBoundingClientRect().height >= 44,
          a.label + " の選択肢が44px未満: " + Math.round(r.getBoundingClientRect().height));
      });
    }
    ["abSaveNext", "abCopyA", "abCopyB", "abPrev", "abNext"].forEach((id) => {
      const n = byId(id);
      if (!n || !n.getClientRects().length) return;
      note(n.getBoundingClientRect().height >= 44,
        a.label + " の " + id + " が44px未満: " + Math.round(n.getBoundingClientRect().height));
    });
    // 入力欄は16px以上（Safari の自動ズーム対策）
    document.querySelectorAll("#abReviewA select, #abReviewA textarea").forEach((n) => {
      if (!n.getClientRects().length) return;
      const size = parseFloat(getComputedStyle(n).fontSize);
      note(size >= 16, a.label + " の入力欄が16px未満: " + size);
    });
    return { pass: problems.length === 0, problems, label: a.label, overflow, vw: de.clientWidth };
  })(__ARG__);
}

// ---------------------------------------------------------------------------
async function main() {
  if (typeof WebSocket !== "function") fail("Node.js WebSocket global is unavailable");
  if (!fs.existsSync(CHROME_PATH)) fail(`Chrome executable not found: ${CHROME_PATH}`);

  const legacyPkg = buildLegacyPackage();
  const choicePkg = buildChoicePackage();
  const groupedPkg = buildGroupedPackage();
  const rejects = buildRejectFixtures(choicePkg);
  const values = REQUIRED_ITEM.options.map((o) => o.value);
  const expectedQueue = choicePkg.experiment.generationExecution.items.map((i) => i.slot + i.rank);

  const server = trackSockets(createServer());
  const baseUrl = await listen(server);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-choice-"));
  // 書き出しは使い捨ての保存先へ固定する。利用者の Downloads へ1件も出さない。
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-choice-dl-"));
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
    const reload = async (settle = 2200) => {
      await client.send("Page.reload", { ignoreCache: false }, sessionId);
      await wait(settle);
    };

    const legacy = await run(phaseLegacy, "declaration-free package gains no field", legacyPkg);
    const rejected = await run(phaseReject, "broken declarations refused one at a time",
      rejects.map((f) => ({ label: f.label, expectField: f.expectField, pkg: f.pkg, name: f.name })));
    const grouped = await run(phaseGrouped, "grouped-by-slot package keeps the old order", { pkg: groupedPkg });
    const alt = await run(phaseAlternating, "alternating queue: 12 steps, six per arm, never twice in a row",
      { pkg: choicePkg, total: expectedQueue.length, expected: expectedQueue });
    await run(phaseCopyState, "the pressed copy button shows success, failure and retry");
    const round = await run(phaseRoundTrip, "options carry their meaning; image round trip restores every value",
      { question: REQUIRED_ITEM.question, options: REQUIRED_ITEM.options, values,
        labels: REQUIRED_ITEM.options.map((o) => o.label),
        descriptions: REQUIRED_ITEM.options.map((o) => o.description) });
    await run(phaseIncomplete, "an unanswered required item blocks save and export; optional does not",
      { label: REQUIRED_ITEM.label, values });
    const snap = await run(phaseSnapshot, "capture every value before reload");
    await reload();
    await run(phaseAfterReload, "reload keeps every value and every image",
      { question: REQUIRED_ITEM.question, before: snap.before });
    const exported = await run(phaseSaveAndExport, "save and export carry every value and every hash", { values });
    const reimported = await run(phaseReimport, "re-import matches counts, hashes and every value",
      { exported: exported.exported });

    const specs = [
      { label: "desktop 1280", width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { label: "iPhone 320", width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { label: "iPhone 375", width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 390", width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
      { label: "iPhone 430", width: 430, height: 932, deviceScaleFactor: 3, mobile: true },
      { label: "landscape 844x390", width: 844, height: 390, deviceScaleFactor: 3, mobile: true }
    ];
    const layout = [];
    for (const spec of specs) {
      await client.send("Emulation.setDeviceMetricsOverride", spec, sessionId);
      await wait(500);
      layout.push(await run(phaseLayout, "layout / " + spec.label, { label: spec.label }, 90000));
    }
    await client.send("Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

    const captured = fs.readdirSync(downloadDir);
    const leaked = [...snapshotDownloads()].filter((n) => !beforeDownloads.has(n));
    if (leaked.length) fail("検査の書き出しが利用者の Downloads へ出た", leaked);

    console.log("REVIEW CHOICE ITEMS BROWSER ACCEPTANCE PASSED");
    console.log(`  declaration-free package unchanged: no new field, no new saved key (${legacy.reviews} reviews saved the old way)`);
    console.log(`  ${rejected.rejected} broken declarations refused one at a time; package and records unchanged after every rejection`);
    console.log(`  grouped-by-slot package still asks the same slot twice in a row (${grouped.first})`);
    console.log(`  alternating queue walked ${alt.seen.length} steps: ${alt.seen.join(" ")}`);
    console.log(`  the pressed copy button showed success, then failure with retry, then returned to its label`);
    console.log(`  every option printed its meaning in place; image round trip restored every value`);
    console.log(`  an unanswered required item blocked save and export and printed the remaining count; the optional item did not`);
    console.log(`  reload restored all 12 images and every value`);
    console.log(`  export carried ${exported.rows} rows / ${exported.images} images with hashes; re-import matched ${reimported.count} records`);
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
