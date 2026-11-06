# 0.3.0への更新手順

対象は独立coreとexample host。製品Eumenesが現在使っている `createCollaborationContract`、`buildCollaborationMessages`、`collaborationInstructions` の行動契約は、wire互換です（モデルに渡すschemaと、有効な入力から作るメッセージは0.2.0とbyte単位で同じ）。破壊的な変更は、製品がまだ使っていない状態・判断のAPIに限ります。

## 版

| 項目 | 0.2.0 | 0.3.0 |
| --- | --- | --- |
| package | 0.2.0 | 0.3.0 |
| `coreContractVersion` | 1 | 1 |
| `decisionContractVersion` | 1 | 2 |
| `stateSchemaVersion` | 1 | 1（保存形式は不変。移行は不要） |

## 失敗の返し方

LLMの出力を検査する関数は値で失敗を返し、hostの入力不正は `CollaborationError` を投げます。どちらも入力値は含めず、`path` と `code` だけを返します。理由コードは `STATE_REJECT_REASONS`、`DECISION_REJECT_REASONS`、`HOST_INPUT_ERROR_CODES` として公開しました。`CollaborationError` の `message` はコードそのものなので、0.2の `toThrow("source_revision_conflict")` のような照合はそのまま使えます。ZodErrorは外へ出しません。

| 0.2.0 | 0.3.0 |
| --- | --- |
| `decideSession(p, closed)`（例外を投げる） | `checkSessionDecision(p, closed)` → `{ok:true, decision}` または `{ok:false, reason, issues?}` |
| `planSteps(p, sourceRef)`（例外を投げる） | `checkPlan(p, sourceRef)` → `{ok:true, plan}` または `{ok:false, reason, issues?}`。`sourceRef` が不正なら `CollaborationError("source_ref_invalid")` |
| `parseBrowserChoice(v)`（例外を投げる） | `checkBrowserChoice(v)` → `{ok:true, choice}` または `{ok:false, reason, issues?}` |
| `contract.parse(v)`（null） | 維持。新たに `contract.check(v)` → `{ok:true, action}` または `{ok:false, reason:"action_contract_violation", violations}` |
| `proposeStateUpdate` の `reason: string` | `reason: StateRejectReason`。`state_sources_invalid` のときは `staleRefs` を追加 |
| `stepResultFact`・`planBudget`・`completeBrief` の Error/ZodError | `CollaborationError`（`step_id_invalid`、`step_result_without_observation`、`source_ref_invalid`、`plan_step_count_invalid`、`brief_invalid`） |

旧名は削除しました。importの時点で型エラーになるので、呼出し箇所を見落としません。

## 忘却

```ts
// 0.2.0
const state = forgetStateSources(saved, refs, sourceRevision);
// 0.3.0
const { state, orphaned } = forgetStateSources(saved, {
	sessionId,
	expectedRevision: saved.revision,
	invalidRefs: refs,
	sourceRevision,
});
```

- `sessionId` と `expectedRevision` を照合します（`proposeStateUpdate` と同じCAS）。0.2の位置引数で呼ぶと `forget_request_invalid` で失敗し、黙って何も忘れない、ということは起きません。
- `orphaned` は、置換していた確定済みの訂正だけが忘却されたために、有効な置換を失った `retracted` のfactのidです。A←B←Cのように、さらに後の訂正Cが有効なまま残る場合は、その話題に有効な値があるので含みません。利用者が単独で撤回済みのfactも、置換元として忘却されれば含みます（尋ね直す側に倒しています）。それらは `retracted` のまま残り、復活はしません。hostは次の状態ターンで、モデルへのメッセージに添えてください（exampleでは `proposeFacts(..., { reconfirm: orphaned })` が `RECONFIRM=` として添え、固定指示がその読み方を定めています）。

## 失効した出所が残っているとき

保存済みの状態が、失効した（または未登録の）出所を参照していると、`proposeStateUpdate` は従来どおりすべての更新を拒否します。0.3では `staleRefs` で対象を返すので、hostは次の順で解消できます。

1. `staleRefs` を `forgetStateSources` で忘却する（`sourceRevision` を進める）。
2. 新しい `sourceRevision` で提案し直す。

## メッセージの組み立て

`buildCollaborationMessages` は `turnContextSchema` で入力を検査し、REFERENCEのJSONが2MiBを超えると `json_resource_limit` を投げます。未知のキーは許可し、組み立てには元の値をそのまま使うので、有効な入力の出力は変わりません。文書本文の容量は、従来どおりhostの `inlineBytes` で管理してください。

## example host

- `proposeDecisions(model, input, closed, sourceRef, signal)`：現在の発言のrefを渡します。成功でも失敗でも、推論が完了していれば `costUsd` を返します。
- `ExampleStateStore.forget` は `{state, orphaned}` を返します。`forgetCollaborationSources` はさらに、外部依頼への影響 `affected` を返します。
- そのほかのexampleの変更（ロック待ち、停止の意図、未課金の予約解放、timeout）は [example/README.md](../example/README.md) を参照してください。

### 予約を解放するstatusの根拠

`createApiModel` は、HTTPの応答が 400, 401, 403, 404, 413, 422, 429 のとき、予約を解放します（`releaseOnStatus` で変更可）。5xx・408・timeout・切断・本文の破損・取消では、従来どおり予約を残します。

設計書は「公式文書で未課金と確認できたstatusだけを対象にする」としていましたが、2026-11-06に確認した範囲では、AnthropicとOpenAIのどちらも、失敗した要求が課金されないことを明記していませんでした。

- [Anthropic errors](https://platform.claude.com/docs/en/api/errors)、[OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)：各statusの意味
- [Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits)：rate limitとspend limitは、要求の開始時に判定される
- [OpenAI rate limits](https://developers.openai.com/api/docs/guides/rate-limits)：失敗した要求もrate limitに数えられる（課金については記載なし）

そのため、この一覧は次の推定に基づいています。課金はtokenの処理量に対して行われ、これらのstatusはいずれも推論の前に要求を拒否することを示しています。設計からの逸脱として [改善設計書](improvement-design-2026-11-06.md) の実施記録に残しています。厳密にしたいhostは、`releaseOnStatus: []` で解放を無効にしてください。

## 状態更新の指示

`contexts/collaboration/state.context.toml` を、未決事項の保持、未確認の結果の扱い、資料に書かれた指示の扱いについて改訂しました。封印課題30件の事前登録した評価で、有意な退行がなく、Claudeの合格が27/30から28/30、注入群の失敗が1件から0件になり、採用条件を満たしました（差は統計的に有意ではありません）。評価の手順と結果は [改善設計書](improvement-design-2026-11-06.md) と `eval/protocol-v2.json` を参照してください。

## 切戻し

0.2.0へ戻す場合は、判断helperの呼出しと忘却の呼出しを旧形式に戻してください。保存形式は同じなので、状態の変換は不要です。忘却前のDBは復元しないでください。
