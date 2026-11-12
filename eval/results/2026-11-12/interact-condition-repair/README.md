# Interactの条件訂正と結果報告の再測定

2026年11月12日

前回の夜間料金の試行では、既存の条件ID `target` を更新しながら、同じIDを `supersedes` に入れていた。自己参照として `superseded_fact_missing` で拒否された。続く修復応答は、削除予定がなかったため `removals` を省略し、`stateUpdate.removals:invalid_type` で再度拒否された。訂正ターンは文書の編集に到達しなかった。 [前回の拒否記録](previous-rejections.log) · [修正前の固定再現](reproduction.log)

状態の版と作業参照をホストが補う経路で、既存IDへの自己参照を余分な指定として取り除くようにした。省略した変更一覧は空として補う。未知の条件への参照、無効な出所、循環する置き換えは引き続き既存の検査にかける。モデル向けの形式と修復の案内も揃え、状態の差分を直して再試行するときは、有効な編集操作を引き継げるようにした。 [差分](interact-condition-repair.patch)

修正前に再現した2件が通り、関連85件と型検査3,385ファイルが通過した。固定試験では、自己参照を含む更新で訂正を採用し、旧評価を失効させ、訂正版の保存、最新の評価通知、実行確認、ブラウザ担当への引き継ぎまで通した。未知のIDや無効な出所が拒否されることも確認した。 [対象試験](fixed-tests.log) · [関連試験](regression-tests.log) · [型検査](typecheck.log)

## Luna 6.0 low

前回と同じ試験ページ、ユーザーの発言、担当選択、モデル経路で、2課題を各1回実行した。両方で訂正の `removals` が省略されたまま文書が保存された。ユーザーが確認した案でページを読み、ブラウザの完了チェックが根拠を確認し、会話に結果が1件ずつ届いた。ブラウザの結果は指定どおりの2行で、会話の通知には短い前置きが付いた。

| 課題 | 訂正後に届いた結果 | 試行全体 | モデル呼出し | 入力 / 出力トークン |
| --- | --- | ---: | ---: | ---: |
| 一般料金から夜間料金 | 東館800円、西館950円 | 62.5秒 | 9 | 106,200 / 1,570 |
| 火曜から水曜の受付終了時刻 | 配送窓口17:45、受取窓口16:10 | 49.3秒 | 9 | 91,438 / 1,202 |

前回は1/2件、再測定は2/2件で、訂正後の値を指定順に会話へ届けた。Evaluator Quickを自発選択した試行は0/2件だった。通し試験で動いた完了チェックはブラウザ側の既存経路。外部サイトへのアクセスや、他の課題での成功率は測定範囲に含めていない。 [集計](summary.json) · [実測記録](live.jsonl.gz)

## 再現

前回の [Interactの手順](../interact-quality/README.md) に従って隔離環境を作り、今回の差分を続けて適用する。実測用スクリプトは前回と同じ。新しい展開先でも依存を新規導入し、固定試験12件を再実行した。 [再現試験](replay-test.log)

各配布物と差分の版は [マニフェスト](runtime.json) に記録した。

```sh
git apply --check /absolute/path/to/interact-condition-repair.patch
git apply /absolute/path/to/interact-condition-repair.patch
bun install --frozen-lockfile
bun test ./api/application/collaboration/collaboration-interact.test.ts \
  ./api/domains/dialogue/test/collaboration-state.test.ts --timeout 30000
bun interact-live.ts /absolute/path/to/new-interact-results.jsonl draft
```

[実測用スクリプト](live-runner.ts.txt)
