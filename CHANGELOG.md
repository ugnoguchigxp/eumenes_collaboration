# CHANGELOG

## 0.3.0（2026-11-06、未リリース）

設計と評価の根拠は [改善設計書](spec/improvement-design-2026-11-06.md)、移行手順は [0.3.0への更新](spec/upgrading-0.3.md) を参照してください。

### 破壊的変更（状態・判断のAPI。製品はまだ使っていない）

- `decideSession` / `planSteps` / `parseBrowserChoice` を、`checkSessionDecision` / `checkPlan` / `checkBrowserChoice` に改名した。失敗は例外ではなく値で返す。`decisionContractVersion` は2。
- `forgetStateSources(saved, { sessionId, expectedRevision, invalidRefs, sourceRevision })` に変更し、`{ state, orphaned }` を返すようにした。

### 追加

- 失敗の契約：`CollaborationError`、`STATE_REJECT_REASONS` / `DECISION_REJECT_REASONS` / `HOST_INPUT_ERROR_CODES`、`Rejected`、`Issue`。
- `proposeStateUpdate` の `state_sources_invalid` は、忘却すべき出所を `staleRefs` で返す。
- 行動契約の `check`（型つきの行動、またはすべての違反を返す）。
- `turnContextSchema` と、`buildCollaborationMessages` での入力検査・REFERENCEの容量の上限。

### 修正

- 工程結果の切り詰めがサロゲートペアを割り、不正な文字列になる問題。
- example：SQLiteのロック待ち、照合で停止の意図が失われる問題、確実に未課金の失敗での予約の解放、判断ターンで費用が失われる問題、実行中の外部依頼への忘却の影響の通知、Claude接続のtimeout。
- pack:check：manifestと検証結果を分ける、古い検証印を残さない、子プロセスへ秘密情報を渡さない。
- 評価ランナー：ログ書込みの失敗で記録が黙って捨てられる問題、事前検査の順序。

### 変更

- 状態更新の固定指示（未決事項の保持、未確認の結果、資料に書かれた指示の扱い）。封印課題30件の事前登録した評価で採用条件を満たした（Claude Haiku 5.5：28/30、0.2.0は27/30。GPT-6 Luna：29/30で同じ。有意な退行なし。注入群の失敗はClaudeが1件から0件）。改善は有意ではない。行動契約のschemaと、有効な入力から作るメッセージは0.2.0と同じ。
- READMEを入口の説明だけにし、経緯の文書を `spec/history/` に移した。host契約・脅威モデル・用語集を追加した。

## 0.2.0（2026-11-05）

- 終了・工程・ブラウザの判断を、語句の規則からLLMの構造化した提案の検査へ移した（`decisionContractVersion` 1）。
- 合成後の状態の再検査、採用と撤回の遷移、JSONの資源制限、Zod 4.6.6。
- example：外部操作の照合と古い応答の無効化、永続する費用台帳、API adapter。
- 実API評価（Claude Haiku 5.5 / GPT-6 Lunaで固定32課題）、Markdown小説の反復改訂のパイロット、コードレビューの修正（C01〜C11）。記録は [spec/history/2026-11-05/](spec/history/2026-11-05/)。

## 0.1.0（2026-11-04）

- Eumenesのspecialistから、行動契約・メッセージの組み立て・固定指示を独立coreとして抽出した。旧版との601比較とEumenes既存試験で互換を確認した。記録は [spec/history/](spec/history/)。
