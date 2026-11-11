# Skill Smithの配達とEvaluatorの行判定を改修した対照試験

[前回の測定](../proactive-luna-low-final/README.md)と同じ合成6課題を、現行相当と支援ありの2方式で各1回実行した。前回と同じ `gpt-6-luna` の `low`、課題順、並行数、採点基準、時間と呼び出しの上限を使用した。現行相当ではEvaluatorとSkill Smithを無効にした。 [事前登録](registration.json) · [課題と採点基準](../../../proactive/luna/cases.mjs)

## 原因と修正

- Skill Smithの前回の4件は、適用候補なし1件と、本文取得後の生成停止3件に分かれた。後者では、初期化ツールの実行、残りの審査枠、公開判断の追加資料についてモデルが不足を申告した。個別再現では、自由形式のJSON解析失敗と、資料にない節IDを参照する出力も確認した。
- MCP検索の最上位の有効候補を本文取得し、検索時と取得時の版を照合してから、Skill Smithの既存の短い生成経路に渡す。取得した本文の完全性を保持し、生成・審査の出力を既存の構造化出力変換で受け取る。Context Stillに節IDがないため節の差分指定を禁止する。Skill Smithの意味審査と配達前の依存版の再確認は適用する。適合する手順を配達できなければ、作品と確定条件だけで成果物を作る。
- Evaluatorの前回の誤指摘では、分岐a/cの確認欄は適合と述べ、別の指摘一覧は同じ行を違反としていた。中間の個別試験では、b/dを違反と判定しても別欄に1件だけ転記する逆の不一致も確認した。改修後は行判定と指摘を1行の出力にまとめる。ホストは根拠位置を元の評価対象行から設定し、違反の行判定と確定条件の根拠が対応するものをEvaluatorの既存の検査に渡す。完成済みの評価で確認した指摘を成果物の参考にする。

個別試験の呼び出しは6課題の比較から除外した。 [Skill SmithのJSON解析失敗](pilot-skill-json.json) · [Skill Smithの節ID検査](pilot-skill-sections.json) · [Evaluatorの別欄への転記漏れ](pilot-review-separate.json) · [Evaluatorの行単位出力](pilot-review-rows.json)

## 結果

12試行すべて完了し、基本品質は両方式24/24点。支援ありではSkill Smithが4件選ばれ、配達は0件。Evaluatorは起動しなかった。 [集計](summary.json) · [試行記録](raw.jsonl)
