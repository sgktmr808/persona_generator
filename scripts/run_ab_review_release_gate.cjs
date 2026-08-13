#!/usr/bin/env node
// [R4C] A/B レビューUI リリースゲート — 逐次実行ランナー。
//
//  役割は検証の指揮だけ。UIの状態・実験データ・期待値・アサーションには一切触れない。
//
//  なぜ逐次か:
//    ブラウザ受入検査を同時に走らせると、Chrome が画面幅を取り合って
//    レイアウト検査が間欠的に落ちる(R4C ブリーフ §4 の観測)。
//    したがって1本ずつ順番に流す。
//
//  各検査に対して:
//    - 開始/終了/所要時間/終了コードを記録する
//    - 明示的な上限時間を与える
//    - タイムアウト・シグナル終了・PASSマーカー欠落・非ゼロ終了はすべて失敗として扱う
//    - 自分自身も最後に自然終了する(Chrome・HTTPサーバ・子Nodeを残さない)
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const HERE = __dirname;

// 実行順は R4C ブリーフ §6 の並び。
const CHECKS = [
  { file: "check_ab_focus_assessment.cjs", marker: "R4B FOCUS ASSESSMENT BROWSER ACCEPTANCE PASSED", timeoutMs: 600000 },
  { file: "check_ab_resample_plan.cjs", marker: "R3-FG RESAMPLE PLAN BROWSER ACCEPTANCE PASSED", timeoutMs: 600000 },
  { file: "check_ab_comparison_drafts.cjs", marker: "R3-FE COMPARISON DRAFT BROWSER ACCEPTANCE PASSED", timeoutMs: 600000 },
  { file: "check_ab_priority_checks.cjs", marker: "R3-FD PRIORITY CHECK BROWSER ACCEPTANCE PASSED", timeoutMs: 600000 },
  { file: "check_ab_resample_round.cjs", marker: "R3-FF RESAMPLE ROUND BROWSER ACCEPTANCE PASSED", timeoutMs: 600000 },
  { file: "check_ab_r3fb_record_compatibility.cjs", marker: "PASS", timeoutMs: 300000 },
  { file: "check_ab_comparison_workbench.cjs", marker: "R3-FC COMPARISON WORKBENCH BROWSER ACCEPTANCE PASSED", timeoutMs: 600000 },
  { file: "check_no_experiment_data.cjs", marker: "PASS", timeoutMs: 120000 }
];

function runOne(spec) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, spec.file)], {
      cwd: path.resolve(HERE, ".."),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    let timedOut = false;
    let hardKilled = false;

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
    let hardTimer = null;

    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });

    child.on("error", (e) => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ spec, ok: false, code: null, signal: null, durationMs: Date.now() - started,
        reason: "spawn error: " + (e && e.message), out, err });
    });

    child.on("close", (code, signal) => {
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      const durationMs = Date.now() - started;
      const hasMarker = out.indexOf(spec.marker) >= 0 || err.indexOf(spec.marker) >= 0;
      let ok = true;
      let reason = "";
      if (timedOut) { ok = false; reason = `timeout after ${spec.timeoutMs}ms${hardKilled ? " (SIGKILL required)" : ""}`; }
      else if (signal) { ok = false; reason = `terminated by signal ${signal}`; }
      else if (code !== 0) { ok = false; reason = `exit code ${code}`; }
      else if (!hasMarker) { ok = false; reason = `PASS marker not found: ${spec.marker}`; }
      resolve({ spec, ok, code, signal, durationMs, reason, out, err, timedOut, hardKilled });
    });
  });
}

(async () => {
  console.log("=== A/B レビューUI リリースゲート（逐次実行） ===");
  console.log(`検査 ${CHECKS.length} 本を1本ずつ実行します。並列実行はしません。`);
  console.log("");
  const results = [];
  for (const spec of CHECKS) {
    const startedAt = new Date().toISOString();
    process.stdout.write(`▶ ${spec.file} ... `);
    const r = await runOne(spec);
    r.startedAt = startedAt;
    r.finishedAt = new Date().toISOString();
    results.push(r);
    const secs = (r.durationMs / 1000).toFixed(1);
    if (r.ok) {
      console.log(`PASS  exit=${r.code}  ${secs}s`);
    } else {
      console.log(`FAIL  ${r.reason}  ${secs}s`);
      const tail = (r.err || r.out || "").trim().split("\n").slice(-12).join("\n");
      if (tail) console.log(tail.split("\n").map((l) => "      " + l).join("\n"));
    }
  }

  console.log("");
  console.log("=== 結果 ===");
  console.log("check".padEnd(42) + "exit".padEnd(6) + "duration".padEnd(11) + "result");
  results.forEach((r) => {
    console.log(r.spec.file.padEnd(42)
      + String(r.code === null ? "-" : r.code).padEnd(6)
      + ((r.durationMs / 1000).toFixed(1) + "s").padEnd(11)
      + (r.ok ? "PASS" : "FAIL: " + r.reason));
  });
  const passed = results.filter((r) => r.ok).length;
  const totalSecs = (results.reduce((n, r) => n + r.durationMs, 0) / 1000).toFixed(1);
  console.log("");
  console.log(`合計: ${passed} / ${results.length} PASS   総所要 ${totalSecs}s`);
  console.log(`外部からの停止: 不要（全検査が自分で終了）= ${results.every((r) => !r.timedOut) ? "はい" : "いいえ"}`);
  if (passed !== results.length) {
    console.log("RELEASE GATE FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("AB REVIEW RELEASE GATE PASSED");
})();
