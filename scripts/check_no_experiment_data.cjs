#!/usr/bin/env node
// [R3-FB] 公開リポジトリに実験の中身が入っていないことの常設検査。
//
//  このリポジトリへ置いてよいのは「汎用UIとスキーマ処理」だけ。
//  特定の実験の本文・追加文・凍結データセット・生成アルゴリズム・キーワードDBは、
//  1バイトも入れない。実験の中身は利用者が手渡すパッケージファイルの中だけに存在する。
//
//  検査対象は追跡済みファイル全体(= このリポジトリが公開する内容そのもの)。
"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
let ok = true;
let checks = 0;
function check(name, pass, detail) {
  checks += 1;
  if (!pass) { console.log(`NG: ${name}${detail ? " — " + detail : ""}`); ok = false; }
}

// 公開される内容 = 追跡済み + 未追跡かつ ignore されていないファイル。
// コミット前でも意味のある検査にするため、これから入る新規ファイルも見る。
const tracked = execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, encoding: "utf8" })
  .trim().split("\n").filter(Boolean);
const blob = tracked.map(function (f) {
  const full = path.join(ROOT, f);
  try {
    if (!fs.statSync(full).isFile()) return "";
    return fs.readFileSync(full, "utf8");
  } catch (_) { return ""; }
}).join("\n");

// 1. 実験固有の語彙 —— どれか1つでも入っていたら実験の中身が漏れている。
//    (この検査ファイル自身は「語そのもの」を持つので、他ファイルだけを見る)
const SELF = "scripts/check_no_experiment_data.cjs";
const others = tracked.filter(function (f) { return f !== SELF; }).map(function (f) {
  try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (_) { return ""; }
}).join("\n");

//  注: "PCEXPORT v1" は既存機能が扱う**書式マーカー**であって実験の中身ではないので含めない。
const FORBIDDEN_PHRASES = [
  "顔の融合を最優先",      // 実験の追加文の冒頭
  "彼女は人間ではなく",    // 伝承ブロックの開始行
  "伝承の意匠を忠実に",    // 伝承ブロックの本体行
  "facial_fusion_ab",      // 実験ID / 凍結データセット名
  // 視覚指示の優先順位実験。本文・実験ID・実際の優先項目のいずれも公開しない。
  "visual_priority_conflict",             // 実験ID
  "最優先に成立させる視覚要素",            // Treatment が入れる優先ブロックの見出し
  "上記の最優先要素を損なわない範囲で",    // Treatment の競合弱化に使う固定句
  "VPC-T1",                                // 処理定義ID
  // 光学対象の実行可能形化実験(OP-E1)。実験ID・処理規則・対象名・実本文の語彙は公開しない。
  "optical_target_materialization",        // 実験ID
  "op-e1.subject-token-face-suffix",       // 処理規則ID
  "主体の顔",                               // Treatment の合焦対象
  "ピントは主体",                           // 指定文(generic focus 文)の語彙
  "gen-r4a-b1",                            // 取得した候補の generationId 接頭辞
  "gen-bms8rbb02"                          // 既存母集団の generationId 接頭辞
];
FORBIDDEN_PHRASES.forEach(function (phrase) {
  check("実験固有の語 '" + phrase + "' を公開ファイルへ置いていない", others.indexOf(phrase) < 0);
});

// 2. 生成側の資産を持ち込んでいない。
//    識別子の検査は**実行されるファイル**に対して行う。文書は「入れていないもの」として
//    同じ名前を挙げることがあり、それを漏洩とみなすと説明が書けなくなる
//    (実験の中身そのものは §1 で文書も含めて検査している)。
const codeBlob = tracked.filter(function (f) {
  return f !== SELF && /\.(html|js|cjs|mjs|json)$/.test(f);
}).map(function (f) {
  try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (_) { return ""; }
}).join("\n");

const FORBIDDEN_GENERATOR = [
  "t9ApplyVeilMutation", "t9ForceVisibleOutputText", "generatePrompts",
  "t9LoadTattooJson", "t9Rng", "keywordDbV1", "t9_species_type_words"
];
FORBIDDEN_GENERATOR.forEach(function (name) {
  check("生成側の資産 '" + name + "' を実行コードへ持ち込んでいない", codeBlob.indexOf(name) < 0);
});

// 3. 凍結データセットやパッケージの実体をコミットしていない。
const dataLike = tracked.filter(function (f) {
  return /\.jsonl$/.test(f)
    || /experiment-package/.test(f)
    || /^data\//.test(f);
});
check("データファイル(JSONL / パッケージ / data/)をコミットしていない",
  dataLike.length === 0, dataLike.join(", "));

// 4. 汎用側は残っている(器そのものを消していない)。
const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
check("A/B実験画面がある", indexHtml.indexOf('id="abView"') > 0);
check("比較ワークベンチの主要導線がある",
  indexHtml.indexOf('id="abSaveNext"') > 0
  && indexHtml.indexOf('id="abJumpIncomplete"') > 0
  && indexHtml.indexOf('id="abDropA"') > 0 && indexHtml.indexOf('id="abDropB"') > 0);
check("画像は選択した時点で登録する（別の登録ボタンを持たない）",
  indexHtml.indexOf('id="abAddA"') < 0 && indexHtml.indexOf('id="abAddB"') < 0);
check("生成元は引き継ぐ（ケースごとの再入力を強いない）",
  indexHtml.indexOf("defaultCondition") > 0 && indexHtml.indexOf("ensureConditionRow") > 0);
check("最初は作成元を選ばせる（技術用語から始めない）",
  indexHtml.indexOf('id="abSetupChatgpt"') > 0 && indexHtml.indexOf('id="abSetupOther"') > 0
  && indexHtml.indexOf("どこで画像を作りますか") > 0);
check("誤登録画像を外す操作がある（物理削除ではない）",
  indexHtml.indexOf('id="abRemoveA"') > 0 && indexHtml.indexOf('id="abRemoveB"') > 0
  && indexHtml.indexOf("invalidationId") > 0);
check("記録削除・別定義への入れ替えで引き継ぎ生成元も消す",
  /db\.defaultCondition = null;/.test(indexHtml));
check("パッケージ形式の宣言だけを持つ", indexHtml.indexOf("persona-experiment-package.v1") > 0);
check("書き出し先スキーマは読み込んだパッケージから取る(埋め込まない)",
  indexHtml.indexOf("exportTargets.reviewSchemaVersion") > 0);
check("失敗分類をパッケージから読む(実験語彙を埋め込まない)",
  indexHtml.indexOf("policy.failureCodes") > 0);
check("既存 PCEXPORT レビューの形を変えていない",
  indexHtml.indexOf("persona-prompt-review.v3") > 0 && indexHtml.indexOf("topRankedImageId") > 0);
check("記録は端末内だけ(外部送信の経路が無い)",
  !/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket/.test(indexHtml));
// 純粋性の検査はコメントを外した実行コードに対して行う(説明文に語が出るだけで落ちるため)。
check("A/B画面が innerHTML 補間を使わない", (function () {
  // A/B 機能ブロックの開始点。改版でタグが変わっても追随できるようにする。
  var at = indexHtml.indexOf("[R3-FC]");
  if (at < 0) at = indexHtml.indexOf("[R3-FB]");
  if (at < 0) return false;
  const code = indexHtml.slice(at)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map(function (l) { return l.replace(/^\s*\/\/.*$/, ""); }).join("\n");
  return code.indexOf("innerHTML") < 0;
})());
// [R4F] 実験の身元は experimentId + definitionSha256 の**両方**で決まり、
//  同じIDでも定義が違えば別の保管庫になる。記録の削除は入れ替えの手順ではない。
check("実験定義の同一性を definitionSha256 で判定する",
  indexHtml.indexOf("definitionSha256") > 0
  && /function workspaceIdFor\(experimentId, definitionSha256\)/.test(indexHtml));
check("定義が変わっても既存の記録を消さずに別の保管庫を作る",
  indexHtml.indexOf("adoptPackage") > 0
  && indexHtml.indexOf("resetRecords") < 0
  && /別の保管庫を作ります/.test(indexHtml));
// A/B機能ブロックの実行コード(コメントを外した本文)。説明文に語が出るだけで落とさない。
const abCode = (function () {
  let at = indexHtml.indexOf("[R3-FC]");
  if (at < 0) at = indexHtml.indexOf("[R3-FB]");
  if (at < 0) return "";
  return indexHtml.slice(at)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map(function (l) { return l.replace(/^\s*\/\/.*$/, ""); }).join("\n");
})();
check("A/B機能ブロックを取り出せる", abCode.length > 1000);
check("保管庫の切り替えでデータベース全体や localStorage 全体を消さない",
  !/localStorage\.clear\(/.test(abCode)
  && !/deleteDatabase\(/.test(abCode)
  && abCode.indexOf("deleteWorkspaceBlobs") > 0
  && !/objectStore\(IMAGE_STORE\)\.clear\(\)/.test(abCode));
check("移行前の単一保管庫を消さずに残す",
  abCode.indexOf("LEGACY_STORE_KEY") > 0
  && !/removeItem\(LEGACY_STORE_KEY\)/.test(abCode)
  && abCode.indexOf("legacyMigratedAt") > 0);
check("案内付き専用の入口が汎用の指定である（実験名を含まない）",
  indexHtml.indexOf("ab=new-guided") > 0
  && indexHtml.indexOf("new-guided") > 0);
check("案内付き生成中は身元と1手順だけを出す（隠した操作は無効化する）",
  indexHtml.indexOf('id="abIdentity"') > 0
  && indexHtml.indexOf("GUIDED_LOCK_IDS") > 0
  && indexHtml.indexOf("lockSubtree") > 0);
check("開始確認を通るまで作業台を開かない",
  indexHtml.indexOf('id="abConfirmStart"') > 0
  && indexHtml.indexOf("confirmedAt") > 0);
check("登録の直前に登録先の身元を照合する",
  indexHtml.indexOf("registrationGuard") > 0
  && indexHtml.indexOf("guidedTargetToken") > 0);
check("R3-FB の保存形式を維持している",
  indexHtml.indexOf("adoptionDecision") > 0
  && indexHtml.indexOf("controlImageId") > 0 && indexHtml.indexOf("treatmentImageId") > 0
  && indexHtml.indexOf("supersedes") > 0);
check("A/B の保存先が既存レビューと分かれている",
  indexHtml.indexOf("personaGenerator.abExperiment.v1") > 0
  && indexHtml.indexOf("personaGeneratorAbImages") > 0);
// 5. 優先項目チェックは「器」だけを持つ。項目の中身はパッケージから読む。
check("優先項目チェックの器がある",
  indexHtml.indexOf("priorityChecksRequired") > 0
  && indexHtml.indexOf("priorityItems") > 0
  && indexHtml.indexOf("重要要素の反映") > 0);
check("優先項目の3択の保存値を持つ",
  indexHtml.indexOf('"present"') > 0 && indexHtml.indexOf('"missing"') > 0
  && indexHtml.indexOf('"unclear"') > 0);
// 出荷物(index.html)は項目の中身を持たず、読み込んだパッケージの label をそのまま出す。
// (検査スクリプトの合成フィクスチャは公開UIではないので対象外)
check("優先項目の短文はパッケージから読む(出荷物へ項目配列を埋め込まない)",
  indexHtml.indexOf("it.label") > 0 && !/priorityItems\s*[:=]\s*\[\s*\{/.test(indexHtml));
// ハッシュは読み込み時の照合にだけ使い、画面へは出さない。
check("優先項目のハッシュは照合専用（画面へ出さない）",
  /短文のSHA-256と一致しない/.test(indexHtml)
  && !/textContent\s*=[^;\n]*clauseSha256/.test(indexHtml)
  && !/appendChild\([^)]*clauseSha256/.test(indexHtml));
check("優先項目パッケージの意味を読み込み時に検査する",
  indexHtml.indexOf("requiredImagesPerArm") > 0
  && /policy\.priorityStatuses/.test(indexHtml)
  && /同じケース内で重複/.test(indexHtml));
// 6. 不可視な制御文字を残さない。目で追えない差分やコピー事故のもとになる。
//    改行(0x0A)とタブ(0x09)だけを許し、それ以外の C0 と DEL は禁止する。
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;
tracked.filter(function (f) { return f !== SELF && /\.(html|js|cjs|mjs|json|md)$/.test(f); })
  .forEach(function (f) {
    let text = "";
    try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (_) { return; }
    const at = text.search(CONTROL_CHARS);
    check("不要な制御文字を含まない: " + f, at < 0,
      at < 0 ? "" : "位置 " + at + " に U+" + text.charCodeAt(at).toString(16).toUpperCase().padStart(4, "0"));
  });

console.log(`OK: 公開内容の検査 ${checks} 件を実行（追跡ファイル ${tracked.length} 件）`);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
