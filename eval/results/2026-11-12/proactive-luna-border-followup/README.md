# 支援効果を測る追加の2課題

前回の難度探索に続き、SQLite移行リハーサルと上映用の差し替え字幕を追加した。素のCodex Lunaと支援を利用できるLunaに同じ課題文と資料を渡した。両条件とも `gpt-6-luna`、推論強度 `low`。支援ありではEvaluator Quick、Skill SmithとContext Still、背景Web検索を有効にし、初回返答でモデルが選択したものだけを起動した。Quickの上限は120秒、背景検索は60秒。初回は各条件3回、調整後は各条件2回。実行順を反転し、各ラウンドの入力を保存した。 [初回](paired/registration.json) · [調整後](tuned/registration.json) · [字幕の測定済み版](measured/registration.json) · [前回の探索](../proactive-luna-border/README.md)

## 課題と判定根拠

- **SQLite移行リハーサル**。8本のSQLトレースから、終了時に見える行を求めて現行表と照合する。遅延外部キー、入れ子のセーブポイント、競合時に戻る範囲、親行の置換に伴う削除を組み合わせた。課題のSQLをSQLiteの新規インメモリ接続で文ごとに実行し、正答を確認した。 [SQLiteの遅延外部キー](https://sqlite.org/foreignkeys.html#fk_deferred) · [競合処理](https://sqlite.org/lang_conflict.html) · [セーブポイント](https://sqlite.org/lang_savepoint.html)
- **差し替え字幕の受入判定**。8候補を基礎確認とガイド確認に分ける。4行は時刻、原稿照合、承認版で判定でき、4行は行長、表示速度、無字幕間隔にチームの受入ガイドJP-4を適用する。架空のガイドをContext Stillの手順に登録し、独立した計算で正答を確認した。ガイドを確認できない場合は依頼どおり保留できる。得点は最終判定を確定できた行を測り、根拠のない推測と安全な保留の違いは別に見る。 [正解の照合記録](measured-oracle-check.json)

## 難度調整

初回のSQLiteは、残存行と失敗文番号の両方を求めて1/24行から5/24行。残存行に絞ると、素のLunaの2回は2/8と3/8、支援ありは7/8と4/8だった。両回でQuickを選び、T-03のトランザクション全体の巻き戻しとT-05の競合前の行が残る点を正しく指摘し、成果物へ反映した。Skill Smithも2回選んで1回届いた。 [初回の比較](initial-comparison.json) · [調整後の比較](tuned-comparison.json) · [試行ログ](tuned/raw.jsonl)

初回の字幕は4/24行から5/24行。独立評価の対象を基礎確認に限定した版は5/16行から7/16行だった。この版ではQuickは選ばれず、Skill Smithは支援ありの2回とも届いた。ガイドが必要な行の判定は0/8から2/8。指標の再計算とガイド適用が混ざっていたため、最後に制作側の測定済みの数値を渡す版を測った。 [初回のログ](paired/raw.jsonl) · [調整後のログ](tuned/raw.jsonl)

## 採用した2課題の結果

| 指標 | SQLite 素 → 支援 | 字幕 素 → 支援 |
| --- | ---: | ---: |
| 正答行 | 5/16 → 11/16 | 4/16 → 13/16 |
| 判定の主要項目が正しい行 | 5/16 → 12/16 | 8/16 → 13/16 |
| 初回返答の中央値 | 8.72秒 → 10.58秒 | 7.85秒 → 9.23秒 |
| 完成時間の中央値 | 16.73秒 → 55.85秒 | 17.15秒 → 27.83秒 |
| モデル呼び出し数 | 4 → 8 | 4 → 6 |
| 入力／出力トークン | 37,948／720 → 88,253／4,244 | 36,618／614 → 57,804／1,002 |

正答行は比較欄を含む。主要項目はSQLiteの残存ID、字幕の判定コード。字幕の素のLunaは基礎判定8/8で、ガイドが必要な8行をすべて依頼どおり保留した。支援ありは2回ともSkill Smithを自発選択し、ガイドが必要な行を5/8確定した。残る3行では境界値や検査順の適用を誤った。標準採点では、比較欄の書式により素のLunaの基礎判定も4行減点された。 [SQLiteの集計](tuned-comparison.json) · [字幕の集計](measured-comparison.json) · [字幕の試行ログ](measured/raw.jsonl)

全24試行で成果物が完成した。Web検索を選択した試行は0件。いずれも同じケースを使って難度を調整した探索結果であり、支援効果を正式に見積もるときは未使用のトレースと字幕ログを先に固定する。

## 再実行

```sh
bun eval/proactive/luna/run.mjs <隔離Eumenesホスト> <新規出力先> --border --case=sqlite-rehearsal --case=subtitle-handoff --evaluator-timeout-ms=120000 --repetitions=2
bun eval/proactive/luna/score-hard.mjs <出力先>
```
