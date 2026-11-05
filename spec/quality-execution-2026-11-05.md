# 品質改善の実施記録（2026年11月5日）

GrokBotの`feat/collab-agent-integration`（a23dd54）はmainへfast-forwardでマージ・push済み。既存のcore、ModelAdapter、状態writer、観測・外部操作の接点、strict pack検証を再利用した。追加改善は`codex/collaboration-quality-80`へcommit・pushした。

## 実装と検証

| 指摘 | 実装・受入 |
| --- | --- |
| F01 合成後の状態破損 | 最終候補を再検査し、1000件超過を原子的に拒否。JSON合成後の容量と初期保存も検査。状態・revision・receiptを変更しない回帰試験が合格 |
| F02 未採用案による撤回 | confirmedの置換だけが以前の条件を撤回。直接の格下げ・削除にも利用者または観測の出所が必要。4状態×3出所種別を検証 |
| F03 語句による意味判断 | 固定語句・分割規則を撤去。LLMの構造化したsession/plan提案を既存ModelAdapterで受け、coreは構造・依存・予算を検査。package0.2.0へ更新 |
| F04 中断後の照合不能 | attemptによる照合と古い応答の無効化を追加。送信・停止中の実プロセス終了、受付不明、忘却、遅延回答を検証。自動再送しない |
| F05 依存と過大入力 | Zod4.6.6へ固定。JSONの2MiB・100000node・depth64を検査し、エスケープ・Unicode・循環も制限。production auditは3packageで警告0 |

追加点検では、JSONエスケープの容量漏れ、合成後容量漏れ、SDK終了時の後処理失敗、遅延回答の返却値が古い成功になる問題を再現し、回帰試験を追加して修正した。部分試験→SQLite/外部接点の結合→全体verifyの順で確認。当該時点のverifyは60試験、742 assertion。後続の本文生成接続を含む最終ローカル試験は61試験、747 assertionで合格。二つのSQLite接続の競合、receipt失敗のrollback、忘却と外部redactionの同時確定、HTTP取消・未完了・拒否・503・切断・過大応答も確認した。

独立配布のstrict packはe5d0dafで27段合格、149出力/601比較、旧specialist64試験、隔離hostの1184 Bun試験・28 Vitest試験・Web build合格。後続2afaf80はexampleの遅延回答だけの変更で、配布するsrc/contexts/catalog/package/lockが同一であることを確認した。最新exampleは60試験で別途検証した。CIも同じfixed install・verify・audit・strict packを実行する。[coreのCI](https://github.com/ugnoguchigxp/eumenes_collaboration/actions/runs/42015768897)、[exampleのCI](https://github.com/ugnoguchigxp/eumenes_collaboration/actions/runs/42016708172)。各runの実状態はリンク先で照合する。

## Claude・Lunaの実API比較

Claude Messages APIの`claude-haiku-5-5`、OpenAI Responses APIの`gpt-6-luna`を固定。既存32課題を両モデル・旧版/改善版で1回ずつ、計128セッション・704ターン実行した。相手providerが意味を採点し、expectedは実行するモデルに渡していない。source/workはfixture、toolは未提供。一般の作品変更や外部作業の完遂を検証した試験ではない。

| モデル | 旧版 | 改善版 | 事前基準90%以上 |
| --- | --- | --- | --- |
| Claude Haiku5.5 | 21/32、65.6% | 21/32、65.6% | 未達 |
| GPT-6 Luna | 28/32、87.5% | 29/32、90.6% | 達成 |

改善版の全64セッションでは50/64、78.1%。一回の比較から有意な向上とは判断しない。原文にない追加質問、選択対象の解決、未観測状態の表現、未決事項の保持などが失敗理由に含まれる。判定者間の厳しさや期待データの表現にも影響されるため、モデルの失敗率と同一視しない。実APIの全128最終状態を現在のschema・資源・出所契約で再検査し、違反は0。改善版の1ターンは存在しない置換参照によりhostが拒否した。拒否を成功扱いせず、誤った状態を保存しなかった結果として残した。

終了・継続・再開の判断は両モデルとも12/12。ブラウザを含めた固定oracleは各10/12、合計20/24だった。「別の色」の対象が未指定のケースと、plan=nullで直接返答できる計算・変換の扱いで、設問と契約の整合に課題がある。結果を見て期待値を変更したり、24/24へ読み替えたりしていない。

最初の二回は、ClaudeのJSON Schema非対応制約と、自由JSON値のwire表現の問題で中断した。数値等の制約はhostのZodで維持し、JSONのprimitiveとobject/arrayの表現を区別して修正した。最終run-v3はc369f24を固定し、測定中の編集なしで完走した。先行試行で一部の保留課題を閲覧したため、未使用のholdoutとは呼ばない。最終修正は資源制限・後処理・記録であり、指示とwire schemaは変えていないが、有料APIを最終commitで全面再実行したとは扱わない。

## 費用と時間

固定32課題比較の終了時点では、全試行・中断・診断・事前確認を一つの永続台帳で計上した。上限10米ドル、保守的概算3.2016775ドル、費用不明45呼出しの予約2.293756ドル、合計5.4954335ドル。台帳の予約を破棄したり、不明額を0へ変更したりしていない。既知usageを基本単価で計算した参考値は0.6403355ドルだが、請求額を確認した値ではない。古い実行ではcache/reasoningの内訳を保持しておらず、後続adapterで今後の記録に対応した。

価格根拠は[OpenAI公式](https://developers.openai.com/api/docs/pricing)と[Anthropic公式](https://platform.claude.com/docs/en/about-claude/pricing)。短い文脈の基本単価より保守的な入力0.50ドル・出力2.50ドル/100万tokenで概算し、リクエスト前にはさらに余裕を取って予約した。両APIを合わせて新しい予約が上限を超える呼出しは送信しない。

coreのローカル測定は各条件30回、0/999/1000fact。改善版p95は最大5.71ms、宣言した200ms以内。1000factでは旧版2.23ms→改善版4.67msで、検査追加の費用がある。高速化の成果とは扱わない。RSS差分はprocess全体であり、1要求のメモリ消費ではない。全試行を合わせた既知usageのAPI呼出しは、実行・採点を混ぜたp95をJSONに記録した。provider間や旧版/改善版の純粋な比較値ではない。

## 再現と残作業

[検証索引](verification.json)、[API全結果](../eval/results/2026-11-05/live-analysis.json)、[ローカル測定](../eval/results/2026-11-05/benchmark.json)、[配布検証](../eval/results/2026-11-05/pack-check.json)、[依存の来歴](../eval/results/2026-11-05/runtime-dependencies.json)を保存した。rawログと予算DBはgit対象外のreportsに残し、hashをlog-index.jsonに記録した。APIキー・実業務文書を評価結果へ含めていない。

非課金の確認は`bun install --frozen-lockfile`、`bun run verify`、`bun audit --production`、`EUMENES_SOURCE=<hostのGit checkout> PACK_CHECK_REQUIRE_HOST=1 bun run pack:check`。既存rawログの再集計は`bun eval/summarize.ts run-v3`。有料の実行手順と0.2移行・異常状態・unknownの復旧は[更新手順](upgrading-0.2.md)を参照する。

実renderer/Pipelineの操作、実外部agent、製品dialogueのmigration・切戻し・bundle採用、他の担当者による引継ぎ、利用者の受入と継続効果は未確認。Claudeの意味合格基準も未達。計画全体の完了、製品採用、利用価値80点の証拠とはしない。技術再評価は同じrubric1.1.0/libraryで別の実測ledgerに記録し、仮定上の目標81.4とは区別する。

## 独立プロジェクトに閉じた最終段階

最新指示により、今回の完了条件を本repo内の技術品質80点超へ固定した。CIの追加・再実行・完了待ちは省略し、Eumenes本体への取り込みは実行していない。実製品受入・継続利用は将来工程へ残す。rubric/libraryの30技術項目・重み・基準は変えない。

[Markdown小説の反復改訂](writing-pilot-2026-11-05.md)を追加。両APIが7回ずつ改稿し、実ファイル保存・再読込・版照合を通過、模擬手編集文を記号まで保持した。本文生成側への原文保持指示と、登録済み操作のnative引数schemaを再利用する接続を追加した。Lunaの人物名省略による自動採点失敗を残し、全意味条件の合格とはしない。

追加試行を含む最終台帳は6.268323ドル（保守的概算3.974567＋費用不明予約2.293756）。最後のローカル検査は61試験・747 assertion、型検査・lint合格。配布src/catalog/package/lockはe5d0dafと同一で、strict packは既存の一致確認と成功結果を再利用した。再評価の算定は[品質再評価](quality-review-2026-11-05.md)にまとめる。
