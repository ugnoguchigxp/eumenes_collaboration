# 用語集

文書で使う日本語の用語と、コード上の識別子の対応です。

| 用語 | 識別子 | 意味 |
| --- | --- | --- |
| 出所 | `sourceRefs`, `SOURCE_REGISTRY` | factの根拠になった発言・観測などのref。hostが発行し、種類（user / observation / assistant / host）と有効性を持つ |
| 版 | `revision`, `sourceRevision`, `work.revision` | 状態・出所の登録・作業対象のそれぞれの版。古い版に基づく提案は拒否する |
| 世代 | `epoch`, `generation` | sessionや外部依頼の作り直しの単位。別の世代の提案や応答は採用しない |
| fact | `CollaborationFact` | 状態の一要素。種類（condition / decision / assumption / question）と状態（proposed / confirmed / rejected / retracted）を持つ |
| 確定 | `status: "confirmed"` | 利用者または観測の出所に基づいて採用された状態 |
| 置換 | `supersedes` | 新しいfactが置き換える以前のfact。確定した置換だけが以前のfactを撤回（retracted）にする |
| 置換を失ったfact | `orphaned` | 置換していた訂正だけが忘却され、有効な置換がなくなった撤回済みのfact |
| 失効 | revocation, `staleRefs` | 出所が使えなくなること。失効した出所に依存するfactは忘却で取り除く |
| 忘却 | `forgetStateSources`, `forgetSources` | 失効した出所と、それに依存する状態・外部記録の原文を取り除くこと |
| 照合 | `reconcile` | 中断した外部操作の状態を、hostの正本（inspect）と突き合わせること。再送はしない |
| 受付記録 | receipt, `operationId` | 状態の採用を一度だけ確定するための記録。再照会では同じ結果を返す |
| 試行番号 | `attempt` | 外部操作の非同期応答のうち、古いものを無効にする番号（fencing） |
| 停止要求 | `stopRequested` | hostが停止を求めた意図。観測された状態値とは別に保存する |
| 予約・精算 | `reserve`, `settle`, `release` | API費用を呼出し前に上限内で確保し、実額で精算する。確実に未課金のときだけ解放する |
| 資源制限 | `JSON_LIMITS`, `withinJsonLimits` | 境界を越えるJSONの容量（2MiB）・node数・深さの上限 |
| 行動契約 | `createCollaborationContract`, `SpecialistAction` | モデルが1ターンで返す行動（reply / invoke / return / discard）のschemaと検査 |
| 固定指示 | `collaborationInstructions`, `contexts/` | s11tnextで生成する、モデルへの共通指示 |
| 事前登録 | `eval/protocol-v2.json` | 評価を実行する前に固定した判定規則 |
| 封印課題 | holdout | 指示を改善する担当者が測定の最後まで見ない評価課題 |
