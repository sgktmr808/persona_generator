# R3-FB 実装報告(persona_generator 側)— A/B実験パッケージの読み込みと評価

**Branch:** `codex/r3fb-ab-experiment-package`(親 `a7bcf06`)
**Status:** 修正パス1完了・**未コミット・未 push**・Codex 再レビュー待ち
**Date:** 2026-08-01
**対になる報告:** `prompt-composer-static/docs/revisions/r3-fb-experiment-package/implementation-report.md`

---

## 0. 修正パス1 — 定義が変わったパッケージの安全な入れ替え

**指摘された欠陥**: 同じ `experimentId` で中身の違うパッケージを読み込むと、
画像・評価・比較を保持したまま `pkg` だけ差し替わっていた。古い評価が新しいプロンプトへ
誤って紐づく。

**対応**: 書き出し側が追加した `definitionSha256`(可変情報を除いた実験定義のハッシュ)で
3つの場合を明確に分けた。

| 場合 | ふるまい |
|---|---|
| 同じ `experimentId` + 同じ `definitionSha256` | 確認を求めず、**記録・画像実体をすべて保持**して読み直す |
| 同じ `experimentId` + 違う `definitionSha256` | 「実験定義（本文・設定・方針）が変わっています」と明示して確認。承認時のみ入れ替える |
| 違う `experimentId` | 同じ確認と同じ削除順序で入れ替える |

**確認を拒否した場合は何も変えない**(パッケージも記録も画像実体も、表示中の本文も)。

削除順序は `resetRecords()` 1か所に集約した:

```text
プレビュー解放 -> 行を消す -> localStorage を先に更新 -> IndexedDB の実体を消し終える(await)
```

`clearImageBlobs()` の完了を **await してから**新しいパッケージを載せる。
途中で失敗しても、古い記録が新しい定義へ結びついた状態にはならない
(実体の削除だけ失敗した場合は孤児 Blob が残るが、参照する行は既に消えており、画面にも表示する)。

読み込み時の検証にも `definitionSha256` を加えた(存在確認と再計算一致)。
定義テキストの組み立ては書き出し側と同じキーの並びで `definitionText()` に集約している。

## 1. このリポジトリに置いたもの / 置かないもの

**置いたもの**: 汎用の A/B 実験UIと `persona-experiment-package.v1` のスキーマ処理だけ。

**置いていないもの**(ブリーフの絶対条件):
生成アルゴリズム・キーワードDB・凍結データセット・特定の実験の16件のプロンプト・insertText。
実験の中身は**利用者が手渡すパッケージファイルの中だけ**に存在する。
評価語彙(判定・スコア範囲・失敗分類・preference・Seed対応)も**パッケージから読む**ので、
このリポジトリには実験固有の語が1つも入らない。

この境界は `scripts/check_no_experiment_data.cjs` が常設で検査する。

## 2. 変更ファイル

| ファイル | 種別 | 内容 |
|---|---|---|
| `index.html` | 変更 | ①タブを3列化+「A/B実験」タブ追加 ②`switchView` を n-way 化し `persona:view` を通知 ③`#abView` 画面の markup ④R3-FB 用CSS ⑤**独立した2つ目の `<script>` IIFE**(A/B実験の全ロジック)⑥修正パス1: `definitionText()` / `definitionSha256` 検証 / `resetRecords()` / 定義差の入れ替え規則 |
| `scripts/check_ab_experiment_package.cjs` | 新規 | 実ブラウザ受入検査(合成フィクスチャで駆動) |
| `scripts/check_no_experiment_data.cjs` | 新規 | 公開内容に実験の中身・生成側資産が入っていないことの常設検査 |
| `docs/r3fb-implementation-report.md` | 新規 | 本文書 |

**既存の PCEXPORT レビュー機能へは触れていない**。保存先も完全に分けている:

| | 既存(PCEXPORT レビュー) | R3-FB(A/B実験) |
|---|---|---|
| スキーマ | `persona-prompt-review.v3` | `persona-prompt-review.v2`(R3-FA互換) |
| comparison | `topRankedImageId` | `bestImageId` + `experiment` ブロック |
| localStorage | `personaGenerator.promptReviews.v1` | `personaGenerator.abExperiment.v1` |
| IndexedDB | `personaGeneratorReviewImages` / `reviewImagesV2` | `personaGeneratorAbImages` / `abImagesV1` |
| スコープ | 既存 IIFE | 独立した2つ目の IIFE(変数を一切共有しない) |

既存ファイルには 579〜954 行付近に古い実装の残骸(死んだ関数群)があるため、
名前を再導入しない意味でもスコープを分けている。

## 3. 使用手順

1. prompt-composer-static の R3-FA パネルで「実験パッケージを書き出す」を押し、
   `experiment-package_*.json` を端末に保存する。
2. persona_generator を開き、**「A/B実験」タブ** →「パッケージを読み込む」でそのファイルを選ぶ。
   読み込み時に **schemaVersion / 各 arm の本文SHA-256 / integrity** を照合し、
   1つでも合わなければ読み込まない(既に読み込んだパッケージも差し替えない)。
3. 対象を選ぶ(前/次、進捗表示つき)。
4. **画像生成条件**(provider / model / Seed または「非対応」)を記録する。
   これを記録するまで画像は登録できない。有効な画像がある間は変更できない。
5. 「A をコピー」「B をコピー」で本文を、「設定をコピー」で元設定を取り出し、外部の画像生成モデルへ渡す。
6. 戻ってきた画像を arm ごとに登録(最大5枚)。サムネイルが出る。
7. 「評価する画像」を選び、判定・美的満足度・意図一致・失敗分類・コメントを保存。
   3つの必須選択をすべて明示するまで保存できない。既存評価があれば全項目が読み込まれ、訂正が追記される。
8. 比較する A/B の画像を選ぶ(サムネイルのクリックでも選べる)。**横並びで拡大表示**される。
   両方が評価済みのときだけ「比較を記録」が押せる。preference は採用判定として扱わない。
9. 誤登録は「この画像を無効化」で外す(記録は残る)。
10. 「書き出し」から **レビューJSONL / 比較JSONL / 画像コピーリスト**(いずれも R3-FA 互換)を保存。

すべて端末内で完結する。パッケージ・画像・評価・比較はどこにも送信されない。

## 4. 保存データ形式

localStorage `personaGenerator.abExperiment.v1` に
`{ pkg, conditions[], images[], reviews[], comparisons[], invalidations[] }` を保存する。
行は append-only で、訂正は `supersedes` を持つ新しい行。先端が複数あるときは**時刻で決めない**。

- `conditions`: `{conditionId, experimentId, caseKey, sourceNo, provider, model, seedSupport, imageSeed, supersedes, ts}`
- `images`: `{imageId, experimentId, caseKey, sourceNo, arm, armRole, armGenerationId, baselineGenerationId, conditionId, rank, metadata{name,type,size,lastModified,sha256}, ts}`
  — `rank` は無効化済みも含む全履歴の最大+1(無効化後に追加しても重複しない)
- `reviews`: `{reviewId, imageId, verdict, scores{...}, failures[], notes, supersedes, ts}`
- `comparisons`: `{comparisonId, ..., preference, controlImageId, treatmentImageId, adoptionDecision:"not-applicable", notes, supersedes, ts}`
- `invalidations`: `{invalidationId, imageId, caseKey, arm, reason, ts}`(一方向)

画像の**実体**は IndexedDB `personaGeneratorAbImages` / `abImagesV1` に置き、
再読み込み後もサムネイルと横並び拡大を復元する。localStorage 側にはバイトを入れない。

書き出しは R3-FA と同一形式(`persona-prompt-review.v2` + `experiment` ブロック /
比較JSONL / 画像コピーリスト TSV)。スキーマ名も**パッケージの `exportTargets` から取る**。

## 5. テスト結果

| 検査 | 結果 |
|---|---|
| `node scripts/check_ab_experiment_package.cjs` | **PASS**(実ブラウザ・合成フィクスチャ) |
| `node scripts/check_no_experiment_data.cjs` | **PASS(22 件)** |

実ブラウザ受入が通しで確認した内容:

- タブが3つになっても既存画面が壊れない。初期表示は従来どおり取り出し画面。
- 合成パッケージを読み込み、**ハッシュ照合済み**の表示が出る。ケース数一致。
- **本文・設定が1バイトも変わらない**(A/B とも)。差分は挿入1文だけ。
- **改ざんパッケージは拒否**され、読み込み済みの本文が差し替わらない。
- 生成条件なしでは画像を登録できない。Seed 未入力では条件を保存できない。
- A へ2枚 / B へ1枚登録、同一ハッシュは拒否。サムネイルが `blob:` で描画され、
  `alt` を持ち、子要素は差し込まれない。
- 無操作の評価フォームでは**1件も書かれない**。明示選択で保存される。
- 比較対象が未評価の間は比較を保存できない。**A/B が横並び**で表示される
  (bounding rect で上端が揃い A が左であることを確認)。
- **再読み込み後**: パッケージ・生成条件・比較の preference/対象/コメント・
  評価の全項目(コメントと失敗分類を含む)・**プレビュー**が復元される。
- 訂正は append-only で積まれる(評価3件)。
- 書き出しが `persona-prompt-review.v2` で、A/B の `promptSha256` が別値かつパッケージの値と一致、
  `generationConditions` と `bestImageId` が入り、スコアは v2 の文字列形、`adoptionDecision` は
  `not-applicable`。
- 画像を無効化すると比較が **stale** になり、進捗からも比較JSONLからも外れる。行は残る。
- **同じ定義(日時だけ違う)を読み直す**と、確認を求めずに画像3件・評価3件・比較1件・
  生成条件1件・無効化1件・**画像実体3件**がすべて残る。
- **同じ experimentId で定義が違う**パッケージは確認を求め、
  **拒否すると記録・画像実体・パッケージ・表示中の本文のどれも変わらない**。
- **承認すると**旧記録が全ストアから消え、**画像実体が 3 → 0** になってから新しい定義が載る。
  サムネイル・生成条件・preference・比較状態もすべて初期化され、
  新パッケージで書き出しても旧記録は1行も出ない。
- **別の experimentId** も同じ確認と同じ削除順序で入れ替わる。
- **既存 PCEXPORT レビュー機能**: 解析 → 画像登録 → 保存まで通り、
  `persona-prompt-review.v3` / `comparison.topRankedImageId` のまま保存される。
  A/B 側の保存も消えない。

公開内容の検査が確認した内容: 実験固有の語(追加文・伝承ブロックの行・実験ID)が
**追跡ファイルに1つも無い**、生成側資産(`generatePrompts` / `t9LoadTattooJson` / `t9Rng` /
`keywordDbV1` 等)が無い、JSONL やパッケージ実体や `data/` をコミットしていない、
外部送信の経路が無い、A/B 画面が `innerHTML` 補間を使わない、既存レビューの形が変わっていない。

## 6. 未解決事項

1. **パッケージは localStorage へ丸ごと保存する** — 実物は約 382 KB で現状は収まるが、
   将来ケース数が増えると上限に近づく。溢れた場合は保存失敗を画面に出す実装にしてあるが、
   分割保存や IndexedDB への移動は未実装。
2. **`crypto.subtle` が必要** — `file://` や非セキュアコンテキストではハッシュ照合ができず、
   その旨を表示して読み込みを断る。GitHub Pages(https)では問題ない。
3. **無効化は取り消せない**(一方向)。R3-FA と同じ方針で、やり直しは再登録で行う。
   なお `definitionSha256` はキーの並びに依存する(`JSON.stringify` の挿入順)。
   書き出し側・読み込み側とも同じ形で組んでいるが、将来 JCS のような正規化を入れるならここが変更点。
4. **画像の一括保存は未実装** — R3-FA 側にある「画像を保存」に相当する機能は入れていない。
   コピーリスト TSV で配置先を出すところまで。
5. **タブは3つに固定** — `switchView` は 3 分岐。さらに増やすならこの関数の作りを見直す。

## 7. git status --short

```text
 M index.html
?? docs/
?? scripts/
```

**コミットも push もしていない。** Codex レビュー後に判断する。
