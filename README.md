# eumenes-collaboration

利用者と内容を具体化する作成アシストの独立core。TypeScript ESM / Bun 1.4.4。意味の判断はLLM、出所・版・権限・実行・保存はhostが担当する。

## 動かす

```sh
bun install --frozen-lockfile
bun run verify
bun run example
```

exampleは固定モデルで、条件の作成→訂正→SQLiteへの採用→再起動→同じ操作の照合→忘却を通す。課金や外部送信は行わず、一時DBは終了時に削除する。

```sh
bun run pack:check
```

実tgzを作り、固定commitの隔離Eumenesに導入する。型・固定指示・旧版との601項目の比較・既存specialist試験・対象domainのverifyを実行する。必要なのはコードだけを持つEumenesのGit repositoryで、既定は兄弟の../eumenes。別の場所ならEUMENES_SOURCEで指定する。製品サーバーは操作しない。生成物はdist/、検証ログとchecksumはreports/、隔離環境は.work/に出る。

## 公開入口

`import ... from "eumenes-collaboration"`を使う。deep importは接続契約に含めない。

| 公開API | 担当 |
| --- | --- |
| createCollaborationContract | hostの返答制約を受け、既存4 actionのschema・解析・違反を返す |
| buildCollaborationMessages | 固定指示、参照資料、現在の原文を分けて組み立てる |
| collaborationInstructions | s11tnextで生成した共通指示 |
| stateProposalSchema / collaborationStateSchema | 出所付き状態と更新提案のschema |
| proposeStateUpdate / forgetStateSources | 版・出所・置換関係の検査と更新候補。保存や実行は行わない |
| decideSession / planSteps / parseBrowserChoice | LLMの構造化した終了・工程・ブラウザ判断を検査する |
| coreContractVersion / decisionContractVersion / supportedStateSchemaVersions | hostが互換性を確認する版情報 |
| withinJsonLimits / JSON_LIMITS | 状態境界のJSON容量・深さ・node数を検査する |

coreの実行依存はZodとs11tnextだけ。DB、HTTP、モデルSDK、renderer、端末操作は配布しない。tgzには固定指示の生成物とmanifestを含める。

## 接続例と保証範囲

example/README.mdに、モデル・観測・外部作業のadapterと設定方法を記載した。Claude Agent SDKはexample用の開発依存。実接続を使う場合は、利用者が用意したテスト設定・モデル識別子・費用上限を明示してadapterを作る。

固定試験の合格は、実モデルの意味品質や実画面の品質を保証しない。評価課題32件をClaude Haiku5.5とGPT-6 Lunaで旧版/改善版比較した。改善版の意味合格はClaude21/32、Luna29/32で、Claude側の事前基準90%は未達。製品Eumenesの保存migration・bundle切替・実renderer受入・実外部agent受入は未実施。最新の範囲と結果はspec/implementation.md、元の段階計画はplan.mdを参照。

レビューの全改善項目と技術品質80点以上を目指す実装順序・受入条件は、[品質改善実装計画](spec/quality-improvement-plan-2026-11-05.md)を参照。

## ライセンス

[MIT License](LICENSE)

0.2.0では判断helperの呼出し契約が変わる。[更新・復旧手順](spec/upgrading-0.2.md)、[品質改善の実施記録](spec/quality-execution-2026-11-05.md)、[検証索引](spec/verification.json)を参照。APIキーはログインシェルから継承し、プロジェクト別の`.env`は不要。

[Markdown小説の反復改訂](spec/writing-pilot-2026-11-05.md)では、両APIで7回ずつ実保存・版照合・模擬手編集の保持を確認した。Lunaの人物名省略の自動判定失敗は残っている。本文生成にも既存の登録操作schemaを直接渡せる。当該時点のローカル試験は61件で、人の受入とEumenes本体への取り込みは次工程とする。

[独立プロジェクトの技術再評価](spec/quality-review-2026-11-05.md)は80.2/100（同じlibrary基準の30項目、充足率100%、確度中）。元の暫定47.4点と根拠を比較した。両モデルの広い意味品質の未達は残し、本流への取り込み・利用価値の評価は別工程とする。

その後の[コードレビュー](spec/code-review-2026-11-05.md)で追加の境界・並行性・失効・配布の問題を修正し、90試験を確認した。80.2点は以前のsnapshotの評価として保持し、今回の点数は再算定していない。manifestは未commit変更があればsourceCommit=nullとし、基準commit・dirty状態・実配布資材のハッシュを併記する。
