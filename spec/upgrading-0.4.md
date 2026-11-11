# 0.4.0への更新

既存の行動契約と状態schema 1は維持する。承認照合と、同じ推論で行動と状態提案を返す任意の契約を追加した。従来の `createCollaborationContract` を使うhostの出力は変わらない。

## 重要な決定の承認

`confirmed` は出所付き事実の採用であり、操作権限ではない。重要な決定の利用箇所はhostの既存権限・影響契約で決め、`checkStateApproval(state, { factId, approvalRef, expectedRevision }, host)` を保護操作と同じwriter transactionで呼ぶ。

hostの `approvals` は正式な利用者承認操作から発行する。ref、実利用者のsourceRef、session・epoch、対象作品の版、レビューしたfactのスナップショット、activeを保持する。文書の記述、モデルが選んだsourceRef、モデルの `approved` から発行しない。台帳へ書く操作をモデルの道具として公開しない。

fact、作品の版、session・epoch、有効性、factと承認の出所を照合する。作品・対象factが不変なら、無関係の状態revisionが進んでも承認を再利用できる。状態を古いまま重要操作へ使わない。承認待ちを通常の下書き編集へ一律に広げない。

exampleでは `recordApproval` がhost専用の承認記録入口、`checkApproval` が現在状態との照合である。migration 2を追加し、忘却は承認スナップショットも同じtransactionで消す。exampleのSQLやtableを製品へ持ち込まない。

## 状態と行動を一度に提案する

`createStatefulCollaborationContract(policy)` は、既存4行動のフィールドに必須の `stateUpdate` を加える。`check` が行動と状態提案の形式を検査し、`{ok:true, action, proposal}` を返す。採用は従来どおり `proposeStateUpdate` を通し、hostが現在のepoch、出所、作品の版をtransaction内で再照合して保存する。

これは別の推論ループや追加のモデル呼出しではない。同じターンの推論回数・期限・取消・receiptの検査を使う。既存のhostは明示的にこの契約へ切り替えるまで従来の契約のままとなる。

## 評価

新しい実行の既定は旧新版とも3回。v3では、未登録protocol、非対称の反復、登録した回数からの変更、封印課題hashの変更を推論前に拒否する。採用の集計ではsessionの重複・不足・差し替えも拒否する。

`cross_provider_session` は各1回の対話を主指標にし、課題ごとの多数決を補助指標として残す。反復は同じ課題を共有するため、単発率へ独立試行を仮定した信頼区間は付けない。各ターンの採用後状態を判定者へ渡し、最終状態で消えた誤確定も採点対象にする。自動採点と人の受入は分ける。

[protocol v3](../eval/protocol-v3.json) はdraftであり、新しい実モデル評価を実施済みとは扱わない。[過去の封印評価](../eval/results/2026-11-06/holdout-v2/manifest.json) は元の課題・protocol・原ログhashを維持して保管する。

```sh
bun eval/archive.ts eval/results/2026-11-06/holdout-v2
```

この集計はネットワーク・認証・API費用を使わない。出力の追加指標と、当時の主要指標を区別する。
