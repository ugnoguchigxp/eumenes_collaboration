# host契約

coreは提案の構造・版・出所・資源を検査するだけで、保存・送信・実行は行いません。このため、正しさの一部はhostの実装に依存します。この文書は、hostが必ず守る不変条件をIDつきで定めます。各条件には、それを実際に確かめているexample hostの試験を対応づけています。Eumenesなど別のhostで実装するときは、同じ試験を自分のwriterや外部adapterに対して用意してください。

試験の参照は `ファイル: 試験名` の形式です。

## 状態の保存

| ID | 不変条件 | example の試験 |
| --- | --- | --- |
| H01 | 状態の採用は、単一writerのtransactionの中で `proposeStateUpdate` を呼び、その結果と受付記録を同時に確定する。`state_revision_conflict` のときは同じ提案を再試行せず、新しい推論で提案し直す | `example/test/state-store.test.ts`: two SQLite connections cannot observe or publish a partial state/receipt transaction |
| H02 | 受付記録（operationId）の再照会で成功を返すのは、現在のsessionとepochを照合した後だけ。同じoperationIdで内容が違えば拒否する | `example/test/state-store.test.ts`: receipt replay checks the current session and epoch before reporting success |
| H03 | 忘却は、状態・失効台帳・外部記録の原文の削除を同じtransactionで確定する。どれかが失敗したら全体を戻す。古いhostの出所登録で失効を上書きしない（`active && !revoked`） | `example/test/forget.test.ts`: a failed external redaction rolls back state forgetting and its revocation ledger / `example/test/state-store.test.ts`: forgetting survives reopen and an older host registry cannot resurrect its sources |
| H04 | `state_sources_invalid` を受けたら、`staleRefs` を忘却してから新しい `sourceRevision` で提案し直す。忘却が返す `orphaned` は、次の状態ターンで尋ね直す材料としてLLMに渡す（exampleでは `RECONFIRM=`） | `test/contract.test.ts`: a refused update names the stale sources to forget, and forgetting them unblocks it |
| H05 | 非対応の `stateSchemaVersion` や上限を超えた保存済み状態は、空の状態で初期化したり切り詰めたりせずに保留する | `example/test/state-store.test.ts`: an unsupported persisted schema is preserved across restart and attempted initialization |

## 外部操作

| ID | 不変条件 | example の試験 |
| --- | --- | --- |
| H06 | 外部依頼は、権限（grant）のdigestが依頼の本文・project・session・世代・版と一致するときだけ送る。送信はtransactionの外で1回だけ行い、自動では再送しない | `example/test/external.test.ts`: requests are delivered once, mutated requests invalidate authority, and reported completion stays unverified |
| H07 | 非同期の応答は試行番号（attempt）で照合し、古い応答・別の世代・別のsession・忘却後の応答を採用しない。中断の後は `reconcile` で正本と照合し、再送しない | `example/test/external.test.ts`: reconciliation fences interrupted delivery without resending or accepting stale callbacks |
| H08 | 回答は questionId・世代・利用者の出所に結びつける。権限や認証を求める質問には自動で答えず、hostへ戻す | `example/test/external.test.ts`: ordinary answers bind to the exact question and duplicate question events never resend / permission and authentication questions require host intervention and never become ordinary answers |
| H09 | 利用者が手で入力している間、または対象の世代が変わったときは、自動入力をしない | `example/test/external.test.ts`: manual input ownership and changed generation prevent automated input |
| H10 | 停止の意図（`stopRequested`）は、観測された状態値とは別に保存する。停止が確認できなければ、hostが明示的に呼び直すまで再送しない。照合の結果に `stopPending` があれば停止は未完了。同じプロセスで呼出し中の依頼は照合しない（`external_operation_in_flight`） | `example/test/external.test.ts`（停止と照合の遷移表の試験） |
| H11 | 忘却が実行中の外部依頼に及んだら（`affected` の `needsStop`）、停止するかどうかをhostが決める。外部agentに渡した原文は、こちらの忘却では消えない。`queued` の依頼はローカルで `cancelled` にし、以後は送信しない（`needsStop:false`）。portが「queued」を外部側の受理として返す実装では、その取消はport側のqueueで行う | `example/test/external.test.ts`（忘却の影響範囲の試験） |

## 費用と資源

| ID | 不変条件 | example の試験 |
| --- | --- | --- |
| H12 | API費用は、呼出しの前に上限内で予約し、実額で精算する。費用が不明な呼出しは予約額のまま計上し、自動ではretryしない。確実に未課金と分かる失敗だけ予約を解放する | `example/test/api.test.ts`: shared budget reserves atomically, retains unknown spend and refuses a changed or invalid settlement / API failures never retry or release uncertain reservations |
| H13 | `JSON_LIMITS` を、保存の前・送信の前・受信の後に適用する | `test/state.test.ts`: resource guards reject depth, cycles and oversized JSON before schema parsing / `example/test/api.test.ts`: API decoding refuses excessive decoded depth, including inside opaque envelopes |
| H14 | 観測の対象と停止の対象は、独立したスナップショットに固定する。hostの登録情報を後から書き換えても、処理中の対象は変わらない | `example/test/workflow.test.ts`: a capture callback cannot change the revision the host asked it to observe / a captured work revision remains stable after the live work object changes |

## 意味の判断

| ID | 不変条件 |
| --- | --- |
| H15 | 発話の意味（終了・継続・計画・訂正の対象）は、LLMの構造化された提案から得る。host側で語句の一致や正規表現によって意味を判定しない |
| H16 | 状態の `confirmed` は、引用された出所が実在して有効で、user / observation の種類であることまでしかコードでは保証しない。引用が意味として正しいかは、モデルと評価に依存する（[脅威モデル](threat-model.md)） |
| H17 | 保護された決定を使う箇所はhostの権限契約が選ぶ。正式な利用者承認操作が発行した台帳を `checkStateApproval` に渡し、fact全体・作品版・session・epoch・出所の有効性を操作と同じtransactionで照合する。文書内の承認やモデルの自己申告から証跡を発行しない。忘却は承認スナップショットも削除する |

H17の試験は `test/approval.test.ts`、保存・再起動・訂正・忘却は `example/test/approval.test.ts` にある。`bun scripts/verify-approval-guards.ts` は隔離コピーで4種類の検査を独立に無効化し、それぞれ試験が失敗することを確認する。正式な承認の取得・認証はhostの責務であり、コアの成功だけで取得済みとは扱わない。

製品への適合状況は [実装と検証](quality-implementation-2026-11-07.md) に記録する。外部操作や費用を担当しないhostでは、その範囲を適用外と明記する。exampleの全試験成功を、別hostの適合証明へ読み替えない。
