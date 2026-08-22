#!/usr/bin/env node
// [R4C/R4F] A/B レビューUI リリースゲート — 逐次実行ランナー。
//
//  役割は検証の指揮だけ。UIの状態・実験データ・期待値・アサーションには一切触れない。
//
//  なぜ逐次か:
//    ブラウザ受入検査を同時に走らせると、Chrome が画面幅を取り合って
//    レイアウト検査が間欠的に落ちる(R4C ブリーフ §4 の観測)。
//    したがって1本ずつ順番に流す。
//
//  [R4F] 「静かに何時間も居座る」ことを構造的に不可能にする:
//    - 上限時間は**実測した所要**から1本ずつ導く(全部に同じ数字を当てない)
//    - 実行中は心拍を出す(現在の検査・経過・実測基準・直近の出力)
//    - 心拍そのものは停止の証拠ではない。停止は「実測に基づく上限超過」で判定する
//    - 盲目的な再試行はしない(retries = 0)
//    - 成功・失敗・タイムアウト・シグナル・例外のどれでも後始末する
//    - 終了後に自分が起こしたプロセスが残っていないことを確かめて報告する
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const HERE = __dirname;

// 上限時間の決め方(2026-08-21 に clean 実行を2回測った値から導出):
//   watchdog = 10秒単位へ切り上げた max(baseline x 4, baseline + 90s)
//   x4 は同時に別の作業が走っている端末での揺れ、+90s は起動・Chrome確保の固定費。
// baselineMs は2回のうち**遅い方**を採る。
const CHECKS = [
  { file: "check_ab_focus_assessment.cjs", marker: "R4B FOCUS ASSESSMENT BROWSER ACCEPTANCE PASSED",
    baselineMs: 17800, timeoutMs: 110000 },
  { file: "check_ab_workspace_entry.cjs", marker: "R4F WORKSPACE ENTRY BROWSER ACCEPTANCE PASSED",
    baselineMs: 51700, timeoutMs: 210000 },
  { file: "check_ab_guided_generation.cjs", marker: "R4E GUIDED WORKFLOW BROWSER ACCEPTANCE PASSED",
    baselineMs: 47400, timeoutMs: 190000 },
  { file: "check_ab_resample_plan.cjs", marker: "R3-FG RESAMPLE PLAN BROWSER ACCEPTANCE PASSED",
    baselineMs: 64000, timeoutMs: 260000 },
  { file: "check_ab_comparison_drafts.cjs", marker: "R3-FE COMPARISON DRAFT BROWSER ACCEPTANCE PASSED",
    baselineMs: 51200, timeoutMs: 210000 },
  { file: "check_ab_priority_checks.cjs", marker: "R3-FD PRIORITY CHECK BROWSER ACCEPTANCE PASSED",
    baselineMs: 47100, timeoutMs: 190000 },
  { file: "check_ab_resample_round.cjs", marker: "R3-FF RESAMPLE ROUND BROWSER ACCEPTANCE PASSED",
    baselineMs: 15900, timeoutMs: 110000 },
  { file: "check_ab_r3fb_record_compatibility.cjs", marker: "PASS",
    baselineMs: 4800, timeoutMs: 100000 },
  { file: "check_ab_comparison_workbench.cjs", marker: "R3-FC COMPARISON WORKBENCH BROWSER ACCEPTANCE PASSED",
    baselineMs: 15700, timeoutMs: 110000 },
  { file: "check_no_experiment_data.cjs", marker: "PASS",
    baselineMs: 200, timeoutMs: 60000 }
];

const EXPECTED_MS = CHECKS.reduce((n, c) => n + c.baselineMs, 0);
// 個々の検査が上限まで粘っても、ランナー自身は必ずその合計で終われるようにする。
const RUNNER_WATCHDOG_MS = CHECKS.reduce((n, c) => n + c.timeoutMs, 0) + 90000;

const live = { index: -1, spec: null, startedAt: 0, lastLine: "-" };
let runnerTimer = null;
let heartbeat = null;
let currentChild = null;
let abortedBy = "";

function secs(ms) { return (ms / 1000).toFixed(1) + "s"; }
function tail(text) {
  const lines = String(text || "").trim().split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 120) : "-";
}
function killChild(signal) {
  if (!currentChild) return;
  try { currentChild.kill(signal); } catch (_) { /* already gone */ }
}
function stopTimers() {
  if (runnerTimer) { clearTimeout(runnerTimer); runnerTimer = null; }
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
}

function runOne(spec, index) {
  return new Promise((resolve) => {
    const started = Date.now();
    live.index = index;
    live.spec = spec;
    live.startedAt = started;
    live.lastLine = "-";
    const child = spawn(process.execPath, [path.join(HERE, spec.file)], {
      cwd: path.resolve(HERE, ".."),
      stdio: ["ignore", "pipe", "pipe"]
    });
    currentChild = child;
    let out = "";
    let err = "";
    let timedOut = false;
    let hardKilled = false;
    let hardTimer = null;

    const softTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch (_) { /* noop */ }
      // 猶予後も生きていれば強制終了する(検査を残したまま次へ進まない)
      hardTimer = setTimeout(() => {
        hardKilled = true;
        try { child.kill("SIGKILL"); } catch (_) { /* noop */ }
      }, 10000);
      if (hardTimer.unref) hardTimer.unref();
    }, spec.timeoutMs);

    child.stdout.on("data", (b) => { out += b.toString("utf8"); live.lastLine = tail(out); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); live.lastLine = tail(err); });

    child.on("error", (e) => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      currentChild = null;
      resolve({ spec, ok: false, code: null, signal: null, durationMs: Date.now() - started,
        reason: "spawn error: " + (e && e.message), out, err });
    });

    child.on("close", (code, signal) => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      currentChild = null;
      const durationMs = Date.now() - started;
      const hasMarker = out.indexOf(spec.marker) >= 0 || err.indexOf(spec.marker) >= 0;
      let ok = true;
      let reason = "";
      if (timedOut) {
        ok = false;
        reason = `実測基準 ${secs(spec.baselineMs)} に対する上限 ${secs(spec.timeoutMs)} を超過`
          + `${hardKilled ? "（SIGKILL が必要）" : ""}`;
      } else if (signal) { ok = false; reason = `シグナル ${signal} で終了`; }
      else if (code !== 0) { ok = false; reason = `終了コード ${code}`; }
      else if (!hasMarker) { ok = false; reason = `PASS マーカーが見つからない: ${spec.marker}`; }
      resolve({ spec, ok, code, signal, durationMs, reason, out, err, timedOut, hardKilled });
    });
  });
}

// 自分が起こしたブラウザが残っていないことの確認。
//  検査ごとの接頭辞を並べるのは取りこぼしやすいので、
//  「実行前後の使い捨てプロファイル付き headless Chrome」の差分で見る。
function headlessSnapshot() {
  const out = new Map();
  try {
    const ps = execSync("ps -Ao pid=,command=", { encoding: "utf8" });
    ps.split("\n").forEach((line) => {
      if (line.indexOf("--headless") < 0) return;
      // この検査群が起こす Chrome の目印。ポートは必ず 0（自動割り当て）で、
      // プロファイルは使い捨ての一時ディレクトリ。ほかの用途の headless Chrome
      // （別プロジェクトが固定ポートで起こしたものなど）を巻き込まない。
      if (line.indexOf("--remote-debugging-port=0") < 0) return;
      if (!/--user-data-dir=(\/var\/folders|\/tmp)/.test(line)) return;
      const pid = line.trim().split(/\s+/)[0];
      if (pid) out.set(pid, line.trim().slice(0, 160));
    });
  } catch (_) { out.set("?", "(ps を実行できなかった)"); }
  return out;
}
function strayProcesses(before) {
  const after = headlessSnapshot();
  const stray = [];
  after.forEach((line, pid) => { if (!before.has(pid)) stray.push(pid + " " + line.slice(0, 120)); });
  return stray;
}

// ブラウザ検査の合成書き出しを利用者のDownloadsへ混ぜない。各検査は一時保存先へ
// 固定するが、ゲート自身も開始前後を照合し、将来の検査追加で設定を忘れても公開を止める。
function downloadArtifactSnapshot() {
  const dir = path.join(os.homedir(), "Downloads");
  const out = new Set();
  try {
    fs.readdirSync(dir).forEach((name) => {
      if (/^(fixture-|facial-fusion-ab-)/.test(name)) out.add(name);
    });
  } catch (_) { /* Downloads が無い環境では個別検査の一時保存だけで守る */ }
  return out;
}
function newDownloadArtifacts(before) {
  const after = downloadArtifactSnapshot();
  return [...after].filter((name) => !before.has(name)).sort();
}

(async () => {
  const runStarted = Date.now();
  const beforeProcs = headlessSnapshot();
  const beforeDownloads = downloadArtifactSnapshot();
  console.log("=== A/B レビューUI リリースゲート（逐次実行） ===");
  console.log(`検査 ${CHECKS.length} 本を1本ずつ実行します。並列実行はしません。`);
  console.log(`実測基準の合計: ${secs(EXPECTED_MS)}（目安 ${secs(EXPECTED_MS)} 〜 ${secs(EXPECTED_MS * 1.3)}）`);
  console.log(`ランナー全体の上限: ${secs(RUNNER_WATCHDOG_MS)}（各検査の上限の合計 + 90s）`);
  console.log("再試行はしません（同じ原因を盲目的に繰り返さないため retries = 0）。");
  console.log("");

  runnerTimer = setTimeout(() => {
    abortedBy = "runner-watchdog";
    console.log("");
    console.log(`RUNNER WATCHDOG: 全体の上限 ${secs(RUNNER_WATCHDOG_MS)} を超えました。`);
    console.log(`  実行中の検査: ${live.spec ? live.spec.file : "(なし)"}`
      + `  経過 ${secs(Date.now() - live.startedAt)}  直近の出力: ${live.lastLine}`);
    killChild("SIGKILL");
    stopTimers();
    console.log("RELEASE GATE FAILED");
    process.exit(1);
  }, RUNNER_WATCHDOG_MS);

  heartbeat = setInterval(() => {
    if (!live.spec) return;
    const elapsed = Date.now() - live.startedAt;
    process.stdout.write(`   [heartbeat] ${live.spec.file}`
      + ` 経過 ${secs(elapsed)} / 実測基準 ${secs(live.spec.baselineMs)} / 上限 ${secs(live.spec.timeoutMs)}`
      + ` (${live.index + 1}/${CHECKS.length})  直近: ${live.lastLine}\n`);
  }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  const onSignal = (sig) => {
    abortedBy = sig;
    console.log("");
    console.log(`SIGNAL ${sig}: 実行中の検査を止めて後始末します（${live.spec ? live.spec.file : "-"}）。`);
    killChild("SIGKILL");
    stopTimers();
    console.log("RELEASE GATE ABORTED（合格ではありません）");
    process.exit(130);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const results = [];
  try {
    for (let i = 0; i < CHECKS.length; i += 1) {
      const spec = CHECKS[i];
      const startedAt = new Date().toISOString();
      console.log(`▶ [${i + 1}/${CHECKS.length}] ${spec.file}`
        + `  実測基準 ${secs(spec.baselineMs)} / 上限 ${secs(spec.timeoutMs)}`);
      const r = await runOne(spec, i);
      r.startedAt = startedAt;
      r.finishedAt = new Date().toISOString();
      results.push(r);
      if (r.ok) {
        console.log(`   PASS  exit=${r.code}  ${secs(r.durationMs)}`
          + `  (実測基準比 ${(r.durationMs / spec.baselineMs).toFixed(2)}x)`);
      } else {
        console.log(`   FAIL  ${r.reason}  ${secs(r.durationMs)}`);
        const t = (r.err || r.out || "").trim().split("\n").slice(-12).join("\n");
        if (t) console.log(t.split("\n").map((l) => "      " + l).join("\n"));
      }
    }
  } catch (e) {
    abortedBy = "exception";
    killChild("SIGKILL");
    stopTimers();
    console.log("RUNNER EXCEPTION: " + (e && e.stack ? e.stack : e));
    console.log("RELEASE GATE FAILED");
    process.exit(1);
  } finally {
    stopTimers();
    killChild("SIGKILL");
  }
  live.spec = null;

  const totalMs = Date.now() - runStarted;
  console.log("");
  console.log("=== 結果 ===");
  console.log("check".padEnd(42) + "exit".padEnd(6) + "duration".padEnd(11) + "baseline".padEnd(11) + "result");
  results.forEach((r) => {
    console.log(r.spec.file.padEnd(42)
      + String(r.code === null ? "-" : r.code).padEnd(6)
      + secs(r.durationMs).padEnd(11)
      + secs(r.spec.baselineMs).padEnd(11)
      + (r.ok ? "PASS" : "FAIL: " + r.reason));
  });
  const passed = results.filter((r) => r.ok).length;
  const slowest = results.slice().sort((a, b) => b.durationMs - a.durationMs)[0];
  const stray = strayProcesses(beforeProcs);
  const leakedDownloads = newDownloadArtifacts(beforeDownloads);
  console.log("");
  console.log(`合計: ${passed} / ${results.length} PASS   総所要 ${secs(totalMs)}`
    + `（目安 ${secs(EXPECTED_MS)} 〜 ${secs(EXPECTED_MS * 1.3)}）`);
  console.log(`最も遅い検査: ${slowest.spec.file} ${secs(slowest.durationMs)}`);
  console.log(`再試行: 0 件（盲目的な再実行はしない設計）`);
  console.log(`停止の判定: ${results.some((r) => r.timedOut) ? "上限超過あり" : "なし（全検査が自分で終了）"}`);
  console.log(`外部からの停止: ${abortedBy ? abortedBy : "不要"}`);
  console.log(`残存プロセス（実行前後の差分）: ${stray.length ? stray.join(" | ") : "なし"}`
    + `　実行前から居たもの ${beforeProcs.size} 件は対象外`);
  console.log(`Downloadsへの検査成果物流出: ${leakedDownloads.length ? leakedDownloads.join(" / ") : "なし"}`);
  if (stray.length) {
    console.log("RELEASE GATE FAILED（検査が起こしたプロセスが残っています）");
    process.exitCode = 1;
    return;
  }
  if (leakedDownloads.length) {
    console.log("RELEASE GATE FAILED（検査成果物がDownloadsへ生成されました）");
    process.exitCode = 1;
    return;
  }
  if (passed !== results.length) {
    console.log("RELEASE GATE FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("AB REVIEW RELEASE GATE PASSED");
})();
