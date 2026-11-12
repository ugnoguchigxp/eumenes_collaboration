# 評価中の訂正を扱うPipelineの隔離検証

2026年11月12日

初稿をQuickで評価している間に20秒から35秒へ訂正する固定試験で、旧版の応答を訂正保存後まで遅らせた。旧版の評価通知は0件、35秒版は1件。通知の版と作品に保存された評価の対象版・ダイジェストが一致した。開始前の画面確認条件とその出所、手順ID、元依頼を保持し、タイマーの実行は0件だった。

## 実装と固定試験

- 評価受付時の文書版と、根拠付きの確定条件を既存の評価記録に固定した。評価待ち、結果採用、通知登録、作品表示で現行の対象と照合する。条件だけが変わっても旧版を表示対象から外す。
- 登録済みの評価通知は、説明を作る前と会話に保存する前に現在の作品・評価ID・版・状態を照合する。準備前と生成中に旧通知が失効する固定ケースでも、旧版の本文は会話に保存されなかった。ここでは条件がすでに訂正された状態を再現した。通知の生成が始まった後で前景入力が待機列に入るケースの順序変更は対象外とした。
- Pipelineの新規セッションに `binding:collaboration.pipeline@4` を登録した。条件の意味と評価を使う価値はモデルが判断する。既存の状態更新で版と作業参照をホストが補い、構造化応答で操作を渡す。評価の自動起動は追加していない。
- 基準版15件、改修後49件、型検査3,385ファイルが通過。通知IDの既存の重複防止試験を含む。今回は専用の再起動試験とブラウザー表示試験を追加していない。 [基準版の試験](baseline-tests.log) · [改修後の試験](fixed-tests.log) · [型検査](typecheck.log)

## Luna 6.0 low

全ラウンドで実際のCodex CLIログインを使い、モデル応答、Pipelineの操作、Quickの受付、会話の通知を観測した。最初の担当選びだけを固定し、試験文面は評価を依頼せず、担当には既存の操作を提示した。旧評価が開始した場合は評価応答の戻りをテスト側で待たせ、その間にユーザーの訂正を送る設計だった。どの試行でも評価操作が選ばれず、実モデルで競合に到達した試行は0件だった。

| ラウンド | 変更 | 試行 | 自発的な評価選択 | 保存があった試行 | 2版が保存された試行 | モデル呼出し |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 評価を選べるPipeline Skill | 6 | 0 | 3 | 1 | 21 |
| 2 | 版・作業参照をホストが補う方式と保存後の継続指示 | 6 | 0 | 3 | 0 | 14 |
| 3 | 保存要求の渡し方を明記し、利用可能な部品で作れる課題へ変更 | 6 | 0 | 4 | 1 | 19 |
| 4 | ラウンド3と同じ課題で構造化応答を使用 | 6 | 0 | 1 | 0 | 14 |

最終ラウンドは、名前と秒数を照合するタイマー手順、2つのタイマーの順序と秒数を指定する引継ぎ、タイトルだけを変えるケースを各2回実施した。初回返信の中央値は5.8秒（返信を完了した5件）、1試行全体の中央値は22.8秒（6件）。実モデル14呼出し、入力194,212・出力4,231トークン。Quickの起動と通知は各0件だった。

ラウンド1では状態更新の必須項目や既存の事実IDで拒否が起きた。ラウンド2ではホストに渡す保存操作をCodexの実行環境と混同した応答や、公開部品で設備操作を表現できないとして下書きを見送る応答があった。ラウンド3では選んだ保存操作のJSONが壊れた例があった。ラウンド4では保存できた試行が1件あり、訂正ターンは文書が保存されていても版の共有を利用者に求めた。各ラウンドの課題・手順・回数上限に差があり、モデルの改善効果やQuickの品質はこの測定からは判断できない。 [集計](summary.json) · [初回](live-round1.jsonl.gz) · [第2回](live-round2.jsonl.gz) · [第3回](live-round3.jsonl.gz) · [最終回](live-final.jsonl.gz)

## 再現

Eumenesの `b59dda83f76d6f51ea8e88f6072f7d83eb6cd299` を隔離先に展開する。未確定だった既存のPipelineレビュー配線は基準差分に含めた。隔離先をGitリポジトリとして初期化し、基準差分、改修差分の順に適用する。使用版と配布物のハッシュはマニフェストに記録した。新しい展開先に両方の差分を適用し、依存を新規導入して訂正の固定試験を再実行した。 [再現試験](replay-test.log) · [基準差分](pipeline-baseline.patch) · [改修差分](pipeline-review.patch) · [マニフェスト](runtime.json)

```sh
git apply --check /absolute/path/to/pipeline-baseline.patch
git apply /absolute/path/to/pipeline-baseline.patch
git apply --check /absolute/path/to/pipeline-review.patch
git apply /absolute/path/to/pipeline-review.patch
bun install --frozen-lockfile
bun check --no-pretty
bun test ./api/domains/collaboration/test/ ./api/application/collaboration/ \
  ./api/application/evaluator/vendor.test.ts \
  ./api/domains/dialogue/test/specialist-notices.test.ts \
  ./api/domains/dialogue/test/collaboration-state.test.ts \
  ./api/domains/dialogue/test/specialist-turn.test.ts --timeout 15000
```

実モデルの最終ラウンドはCodex CLIがChatGPTでログイン済みの環境で実施した。実行コードを隔離先のルートに `pipeline-review-live.ts` としてコピーし、新しい出力ファイル名で実行する。試行ごとに一時DBを使い、Codexの作業先も一時ディレクトリに置く。実測では既にインストール済みの依存を隔離先から参照した。 [実行コード](live-runner.ts.txt)

```sh
bun pipeline-review-live.ts /absolute/path/to/new-live-results.jsonl
```
