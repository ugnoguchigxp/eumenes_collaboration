# 通常の返答、背景評価、スキルを使った作業

この検証は一件の合成依頼から、通常の返答、Evaluatorの確認、Skill Smith経由の成果物作成を実行する。通常の返答が確定すると、呼び出し元は返答を先に表示できる。制作担当の判断で、背景評価とスキル作業をそれぞれ依頼できる。両方を依頼した場合は並行して進む。

- **通常の返答**は利用者に現時点で分かることを伝える。モデルは必要に応じて、評価する問いと条件ID、スキルで実行する目標と検索語を添える。
- **背景評価**は、EvaluatorのQuick評価で固定した作品の版と選択された確定条件を照合する。完了した評価の指摘を成果物の作成側に渡す。`reviewComparison` を指定した作品では、Evaluatorが台帳を参照して求めた期待値を現行の判定欄と照合し、依存先の判定を確認してから連鎖を組み立てる。
- **スキル作業**は、Skill Smithの既存アダプターでContext Stillの公開MCPから資料を検索・取得する。Lunaが対象と目的に合う既存手順を本文まで読んで選ぶ。Skill Smithの互換経路で、原文を保持したスキルを組み立て、配達前に依存版を再照合する。受け取った作業担当は、手順が求める必須項目、表記、順番を成果物に反映する。この検証では既存手順を再利用する。適用できる手順がなければ、作品と確定条件から成果物を作る。

MCPの応答とスキル本文は作業資料として渡す。作業担当に外部操作やファイル編集のツールは付与しない。Context Stillは合成の手順を入れた一時SQLiteで、公開MCPハンドラーをプロセス内で実行する。Skill Smithも試行ごとに一時DBを使う。

行照合を使う場合は、呼び出し側が `reviewComparison.rowsField` に判定行の配列、`sourceFields` に参照を許可する資料のフィールド、`currentValuePointer` に各行内の現行判定欄を指定する。行ラベルや許可される判定コードの一覧は `rowLabelPointer` と `expectedValues` で指定できる。取消通知・欠品引当・公開承認の比較課題はこの設定を使う。

## 実行

前提は、兄弟フォルダーに `eumenes_skill_smith`、`eumenes_evaluator`、`contextStill` があり、それぞれの既存の依存が導入済みであること。通常のCollaboration試験はこれらのフォルダーを必要としない。

```sh
bun test example/proactive
bun check
bun example/proactive/live.mjs <隔離Eumenesホストのパス> <モデル名> <新規JSON出力先>
```

実モデル用の入口は、[前回の隔離ホスト](../../eval/results/2026-11-11/proactive-evaluator/README.md)のCodex接続を再利用する。認証はログイン済みのCodexに委ね、APIキー経由の追加予算は設けていない。6課題の対照試験では、返答と成果物の作成に各1回、必要に応じて背景評価と手順の適用判断を行う。支援ありの呼び出し上限は各試行6回。1呼び出し60秒、全体180秒を上限とする。

出力JSONには、通常返答までの時間、背景評価の結果と根拠、MCP呼び出しの記録、配達までの時間、スキルの版情報と作業時間、成果物、モデル使用量を保存する。合成ケースでは、Evaluatorがタイトルの不一致を `/title` に特定し、成果物に合意値、現在値、入力項目と、MCPの手順にだけある照合欄名が入ることを確認する。

6課題の再測定で参照した兄弟リポジトリのHEADはSkill Smith `eb9e61e7ec49d07748b99c7bcf44865d620cc74f`、Evaluator `9a11d038b073a806d62efb61edec5383a4d65680`、Context Still `ef415db3a043115f9d48034b2af29f6a1462e8df`。

[実モデル試験の結果と確認票](../../eval/results/2026-11-11/proactive-skill-smith/README.md)

[自発的な評価・スキル利用の再測定](../../eval/results/2026-11-11/proactive-luna-low-reuse/README.md)

背景の公開Web調査は、研究用サービスを有効にした検証で自発的に選択できる。通常返答の後に検索し、取得結果のURLを成果物作成へ渡す。実モデル確認の入口と結果は[背景Web調査の記録](../../eval/results/2026-11-11/proactive-codex-web-research/README.md)にある。

```sh
bun example/proactive/research-live.mjs <Eumenesの隔離チェックアウト> <新規JSON出力先>
```
