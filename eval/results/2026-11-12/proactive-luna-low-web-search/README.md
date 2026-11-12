# Evaluator・Skill Smith構成にWeb検索を追加した比較

取消通知、欠品引当、公開承認を、Web検索なしとWeb検索を選べる条件で各2回、計12回測った。両条件ともEvaluator `6aec373bc597` のtarballとSkill Smith・Context Stillを接続した。同じ隔離Eumenesホスト、Codexログイン、`gpt-6-luna` の推論強度 `low` を使用した。Quickの上限は120秒、Web検索は60秒、各試行は240秒。課題本文・資料・確定条件・採点は前回のtarball測定と同一で、実行順は課題と反復ごとに反転した。 [事前登録](registration.json) · [実行環境](runtime.json) · [前回のtarball測定](../proactive-luna-low-quick-tarball/README.md)

初回返答でモデルが公開情報の必要性を判断した場合に、既存の背景調査サービスへ公開用の検索語を渡す。検索専用ターンでCodexの `live` モードを使用し、同じターンで検索完了イベントを受け取った場合に限り、得られたURL候補と要約を成果物作成へ渡す。 [OpenAI公式の検索モード](https://learn.chatgpt.com/docs/config-file/config-basic#web-search-mode)

## 難問3課題の結果

| 指標 | Evaluator＋Skill Smith | Evaluator＋Skill Smith＋Web検索を選択可能 |
| --- | ---: | ---: |
| 成果物の完成 | 6/6 | 6/6 |
| 正答行 | 28/48（58.3%） | 18/48（37.5%） |
| 初回返答の中央値 | 9.16秒 | 9.22秒 |
| 成果物完成の中央値 | 22.16秒 | 41.70秒 |
| Quickの引き継ぎ成功／起動 | 2/2 | 1/3 |
| Skill Smithの配達成功／起動 | 1/1 | 2/2 |
| Web検索の自発選択 | 対象外 | 0/6 |
| モデル呼び出し数 | 15 | 17 |
| 入力トークン | 163,705 | 188,815 |
| 出力トークン | 7,133 | 10,741 |

正答行は、行内の全項目が正しい行を数えた。3課題とも資料とルールが依頼に含まれており、検索の起動と出典の受け渡しは0件だった。検索を使える条件で増えた2回のモデル呼び出しは、QuickとSkill Smithが各1回。公開承認では、検索なしのQuickは2回とも引き継がれ、検索を使える条件のQuickは2回とも `scope_unverified` だった。表は各6試行での構成ごとの観測値で、検索結果を利用した場合の効果はこの比較では測れなかった。 [比較集計](comparison.json) · [標準採点](grades.json) · [試行記録](raw.jsonl)

## 公開資料が必要な課題での接続確認

SQLite公式資料を求める短い課題では、自発的に背景検索を選択した。初回返答は6.05秒、背景検索は5.82秒で `cloud_agent_web_search_missing`、成果物完成は約17.68秒だった。成果物には公式URL候補と今回の検索で出典を確認できなかった旨が載った。検索経由で出典が届いた件数は0。 [SQLite課題の試行記録](research-smoke.json)

同じ公開資料について、公式 `@openai/codex-sdk` 0.160.0からCLI 0.162.1を直接起動し、JSON出力指定あり・なしの2回を `live` で確認した。2回ともモデルのターンは完了した。検索完了イベントは0/2件。JSON出力の応答は空の候補一覧で、自由文の応答は検索を実行できなかったと報告した。 [SDKのイベントと使用量](sdk-search.json)

## 検証と再実行

Collaborationのテスト206件、型検査、評価ケース一覧の検査が通過した。隔離Eumenesの関連テスト4件が通過し、現在の検索ターンの完了イベントだけで引き継ぎを許可することを確認した。

```sh
bun eval/proactive/luna/run.mjs <隔離Eumenesホスト> <新規出力先> --hard --compare-research --evaluator-timeout-ms=120000 --repetitions=2
bun eval/proactive/luna/score-hard.mjs <出力先>
```
