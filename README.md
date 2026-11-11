# eumenes-collaboration

利用者との対話から、作るものの条件・決定・仮定・未決事項を出所つきで保持し、作成を進めるアシスタントのcoreです（TypeScript ESM / Bun 1.4.4）。発話の意味はLLMが判断し、coreはその提案の構造・版・出所・資源を検査します。保存・送信・実行はhostが担当します。

## 動かす

```sh
bun install --frozen-lockfile
bun run verify      # 型・書式・lint・固定指示・全試験・評価課題の構造
bun run example     # 固定モデルで、作成→訂正→保存→再起動→照合→忘却を通す（課金なし）
bun run pack:check  # 実tgzを作り、固定commitの隔離Eumenesで互換を検査する
```

`pack:check` には、コードだけを持つEumenesのGit checkoutが必要です（既定は兄弟の `../eumenes`、別の場所は `EUMENES_SOURCE` で指定）。製品のサーバーやDBは操作しません。結果は `reports/` に、配布物と検証結果は `dist/` に出ます。検証済みの配布物は、`dist/` に `.sha256` と `.verification.json`（status が `passed`）の両方があるものです。

## 公開API

`import ... from "eumenes-collaboration"` だけを使ってください（deep importは契約外）。

| API | 役割 |
| --- | --- |
| `createCollaborationContract` | hostの返答制約から、行動（reply / invoke / return / discard）のschema・`check`・`parse`・違反を返す |
| `buildCollaborationMessages` / `turnContextSchema` | 固定指示・参照資料・現在の原文を分けてメッセージを組み立てる。入力は実行時に検査する |
| `checkStateApproval` | hostが正式な承認操作から記録した証跡と、重要な決定・対象版・有効な利用者出所を照合する |
| `createStatefulCollaborationContract` | 同じ推論で既存の行動と出所付き状態提案を返す任意の契約 |
| `collaborationInstructions` | s11tnextで生成した共通の固定指示 |
| `proposeStateUpdate` / `forgetStateSources` | 状態の更新提案と忘却を、版・出所・置換関係・資源で検査する。保存はしない |
| `checkSessionDecision` / `checkPlan` / `checkBrowserChoice` | LLMの終了・工程・ブラウザの判断を検査する |
| `completeBrief` / `stepResultFact` / `planBudget` / `budgetCheck` | 5W1Hの補完、工程結果のfact化、推論回数の予算 |
| `CollaborationError` と理由コードの一覧 | 失敗の契約。LLMの出力の不正は値で返し、hostの入力不正は例外で投げる |
| `withinJsonLimits` / `JSON_LIMITS` | 境界を越えるJSONの容量・深さ・node数の検査 |
| `coreContractVersion` / `decisionContractVersion` / `supportedStateSchemaVersions` | hostが互換性を確かめる版 |

実行時の依存はZodとs11tnextだけです。DB、HTTP、モデルSDK、端末操作は含みません。

## 保証の範囲

- コードが保証するのは、構造・版・出所の実在と有効性・権限・資源の検査までです。引用された出所が意味として正しいかは、モデルに依存します（[脅威モデル](spec/threat-model.md)）。
- 固定の試験に合格しても、実モデルの意味品質は保証されません。実API評価の結果と限界は、[改善設計書の実施記録](spec/improvement-design-2026-11-06.md) を参照してください。
- 製品Eumenesへ0.4.0の出所付き状態を接続し、実モデル・実DB・実画面で部分訂正、保存、再起動、条件の忘却を確認しました。製品の既存の操作権限は維持しています。新しい承認照合APIの正式レビュー画面への接続と、新条件での大規模比較は別の受入です。確認範囲と保留事項は[実装記録](spec/quality-implementation-2026-11-07.md)を参照してください。

## 文書

| 文書 | 内容 |
| --- | --- |
| [host契約](spec/host-contract.md) | hostが必ず守る不変条件と、対応する試験 |
| [状態提案の契約](spec/state-contract.md) | 状態schemaと更新・忘却の規則 |
| [脅威モデル](spec/threat-model.md) | 信頼境界、コードが保証すること、残存リスク |
| [用語集](spec/glossary.md) | 日本語の用語と識別子の対応 |
| [0.4.0への更新](spec/upgrading-0.4.md) / [0.3.0への更新](spec/upgrading-0.3.md) / [0.2.0への更新](spec/upgrading-0.2.md) | 移行と復旧の手順 |
| [example host](example/README.md) | モデル・保存・外部操作のadapterの例 |
| [改善設計書](spec/improvement-design-2026-11-06.md) | 0.3.0の設計と実施記録 |
| [CHANGELOG](CHANGELOG.md) | 版ごとの変更 |
| [経緯](spec/history/) | 当初の計画、2026-11-05の品質改善・レビュー・評価の記録 |

## ライセンス

[MIT License](LICENSE)
