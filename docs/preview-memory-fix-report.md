# 画像プレビューのメモリ抑制(iPhone の再読み込みループ対策) — 実装報告 2026-09-23

## 事象
ファイル(PCEXPORT)を読み込んで画像を登録しながらしばらく使うと、iPhone でページの再読み込みが繰り返される。

## 原因(調査で確定した範囲)
- `index.html` に再読み込みを起こす処理は無い(`location.reload` / meta refresh / Service Worker なし)。公開ページと手元は同一バイト。デスクトップ実ブラウザでは貼り付け→解析→再読み込みを繰り返しても再遷移・例外ゼロ。
- したがって WebKit のメモリ上限超過によるページ強制終了と Safari の自動再読み込みの反復と判断。該当箇所:
  1. 追加した写真を原寸のまま `URL.createObjectURL` で `<img>` に表示していた(1枚のデコードで数十MB、最大5枚)。
  2. 画像レビュー側の object URL(`reviewBlobUrls`)は項目を移動しても解放されず、使うほど蓄積していた。
  3. 保存時は `Promise.all` で全画像を同時に `arrayBuffer()` へ展開して SHA-256 を計算していた。

## 変更
- `window.PersonaPreview`(共通の縮小器): 長辺 1280px を超える画像は JPEG(0.82)に縮小してから object URL を作る。縮小できない形式は原寸で表示(従来どおり)。器はビュー毎に独立(`create()`)。
- 画像レビュー: `loadImagePreview` が縮小 URL を使う。`renderReviewItem` で表示中の項目の画像以外を解放。削除・解析・クリア時も同じ器で解放。保存は `persistOneImage` を 1 枚ずつ逐次実行。
- A/B: `setPreview` / `hydratePreviews` が同じ縮小器を使い、`hydratePreviews` は逐次読み込み。出来上がり次第 `render()` で反映。ケース移動時の解放(`releaseAllPreviews`)は従来どおり。
- 保存する実体(IndexedDB)は原寸のまま。SHA-256 も原寸に対して計算する(記録の互換性は不変)。

## 検査
`scripts/check_preview_memory.cjs`(実ブラウザ・合成画像のみ): 縮小 URL(長辺 ≤1280、原寸 blob から URL を作らない) / 項目移動での解放と復帰 / 保存の逐次実行(同時読込ピーク=1) / 再読み込み後の再生成と実体が原寸のまま / 縮小器の単体。`run_ab_review_release_gate.cjs` に追加。

## 残る確認(利用者側)
公開反映後、iPhone で画像を登録しながら 20〜30 件ほど進めて再読み込みが起きないことを確認する。
起きる場合は Safari の「Webサイトデータ」の当該サイト容量と、発生直前の操作(登録直後か、移動中か)を控える。
