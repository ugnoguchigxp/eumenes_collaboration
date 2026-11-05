# 実装と受入の記録

この文書の以下は初期実装時点の履歴。2026-11-05の0.2.0改善、61試験、実API比較・反復制作の最新状態は[品質改善の実施記録](quality-execution-2026-11-05.md)と[検証索引](verification.json)を参照。

2026-11-04。利用者の実装開始指示により、plan.mdの推奨構成を採用して着手した。P1合格前にP2を実装しない。実モデル評価は接続・予算が確定した場合のみ実施し、製品経路の採用はP3/P5の根拠とWeb受入を条件にする。

## P0の契約

- core契約は1、packageは0.1.0。入口は`eumenes-collaboration`のみ。Bun 1.4.4、TypeScript 7.0.2、Zod 4.4.3、s11tnext 0.1.2を固定する。
- `createCollaborationContract(ReplyPolicy)`はJSON schema、action解析、違反のデータを返す。音声の長さの測定・検査はhostのdeliveryを再利用する。従来の四つのactionとフィールドの制約、最大8違反、arguments省略時の扱いを維持する。
- `buildCollaborationMessages(TurnContext)`はsystem・参照資料・利用者の原文の3メッセージを作る。時刻表現と履歴の取得・容量制御はhostから渡す。文書のUTF-8容量だけをcoreで計測する。
- `collaborationInstructions`は生成catalogから共通rules・reference・correctionを返す。音声と保存ボタンの規則、agentControl、rejectedOutputMessage、JSONの修復、receipt、回数制限、実操作はhostに残す。
- P1では状態schemaを保存しない。`supportedStateSchemaVersions`は空。P2ではdialogue所有の新規表を使う。sessionのepoch/runは既存正本を照合し、状態更新・receipt・イベントは単一writerで確定する。非対応版は保留し、DBを巻き戻さない。
- 未対応の観測操作や外部agentへの回答を利用可能として公開しない。任意PTY入力・承認の自動生成を追加しない。

## 基準線と予算

固定host commit: `5bf5ca556ad45a9c8a6b72f81aae85f7505e505c`。並行開発時の基準方針（2026-11-05）: `EUMENES_BASELINE_COMMIT`で別のhost commit（`HEAD`可）を指定でき、reportに宣言値と実使用値を両方残す。hostのcheckoutかcommitが無いときはhost統合段を理由付きで`skipped`とし、結果は`passed`ではなく`passed_package_only`とする。`PACK_CHECK_REQUIRE_HOST=1`（CI・リリース）では失敗にする。host統合段の準備（公開・認証不要）: `git init ../eumenes && cd ../eumenes && git remote add origin https://github.com/ugnoguchigxp/eumenes && git fetch --depth=1 origin <基準commit> && git checkout FETCH_HEAD`。これで`pack:check`は`passed`まで通る（2026-11-05実測 約5分、parity 601比較）。製品の未commit差分は取り込まない。git archiveからコードだけを展開し、製品DB・設定・秘密をコピーしない。

P1は固定モデルのみ、API費用0、現行最大4推論・doc.edit再試行1・doc.write再試行0を維持する。比較は既存specialist六試験ファイルと、出力schema・解析・違反・指示・文脈の直接比較。意味品質・実モデルの時間や費用は未測定であり0と報告しない。

P2以降の初期課題は4群各8課題（開発4・保留4）とし、fixtureは安全性と契約だけを評価する。意味の採点を製品の語句分岐へ実装しない。live予算と採用閾値は実行前に確定し、結果を見て変更しない。

## 依存順と残作業

1. P0: 契約・比較条件・配布と接続手順を固定する。
2. P1: 抽出、standalone、単体検査、実tgz、隔離hostの型/context/session/domain検査。ここで失敗すれば後続を止める。
3. P2: 出所付き状態・dialogue保存・移行・切戻し・忘却と一般課題。
4. P3: 実renderer/Pipelineの版付き観測と受入。P4: 正式な質問回答接点と偽外部agentの不変条件。
5. P5: 許可された隔離対象と明示予算で実外部agent評価。
6. P6: 合格した対象に限って製品bundle接続、旧重複処理整理、Web受入と切戻し。

検証ログはreports/、再現用隔離hostは.work/に置き、配布しない。各ゲートの結果は別途記録する。


## 追加指示と実装した範囲

利用者から「exampleにてeumenesのadapterを模倣して接続する構想」との指示があり、実モデル・外部作業の接続はexampleに置いた。Eumenesの製品経路、DB、設定、bundleは変更しない。

- P0: 公開契約・stack・32課題（各群開発4/保留4、21発話の長期保持を含む）・固定評価条件を用意した。live予算は未設定。
- P1: 旧版と新coreの149出力・601比較、旧specialist64試験を合格。隔離hostの型・context・domain verifyも1,184 Bun試験/28 Vitest試験まで合格。途中の二つの環境不備（Git基準情報/書式）は修正済み。最終tgzでも同条件を再実行し合格。導入資材の全checksum一致とWeb buildも確認した。
- P2のcore/example: 状態schema1、出所検査、CAS、訂正の置換関係、非対応版の保持、SQLite初期migrationの再適用、receipt、再開、忘却を実装。現在のsupportedStateSchemaVersionsは[1]。Eumenes dialogueへの保存migrationと旧packageへの製品切戻し試験は未実施。
- P3の接点: 対象版に結ぶ観測adapterを用意し、UIとPipelineで同じ契約のfixtureを検証。実rendererの画像/操作観測やlive Pipelineの試験は未実施。
- P4のexample: 偽外部agent、依頼digestとhost権限、session/世代/質問IDの照合、利用者入力との競合、重複、結果不明、停止未確認、忘却を実装・検証。現行terminals bridgeは質問回答をunsupportedとする。
- P5/P6: 実外部agent受入・製品採用は未実施。fixtureや旧版互換を根拠に達成扱いしない。

現時点の独立側verifyは型・書式・lint・context・29固定試験・32課題の構造検査を通過。課題の意味採点、実モデルの時間/費用、人の受入は未測定。

## 差分と停止規則の点検

発話の語句・題材の辞書、正規表現による意図分類、個別例の固定返答を製品coreに追加していない。追加した決定的処理はschema、出所、版、置換関係、依頼同一性、権限、入力所有権、予算の検査に限る。具体的な発話と期待値はtest/eval/example fixtureに置いた。専用の意味判断実装という例外はない。

Eumenes本体の作業ツリーは着手前と同じspec/README.mdの変更と旧計画書の削除だけで、今回の製品変更はない。接続元コードと生成指示の正本をcoreへ移した差分は、隔離hostへだけ適用する。


## 最終確認（2026-11-04）

最終配布物のpack:checkが合格。配布元commit、tgzのchecksum、候補lockfile/adapter patchのdigest、導入された資材の一致、検証件数はverification.jsonへ記録した。生成manifestは配布元の確定ソースcommitを指す。独立側のverifyは29試験を合格、評価32課題は構造検査のみ。実モデル・実renderer観測・実Claude Code・製品採用は未実施のままである。

俯瞰評価では、隔離hostのGit基準情報/書式の不備を解消して互換試験を完走した。その後の差分点検で、exampleの忘却と操作を協働session内へ制限し、手入力中の観測は継続できるよう修正した。新しい証拠に応じた修正で、発話別の意味判断は追加していない。最終測定中は配布coreを変更せず、正常に進む検証を停止・再起動していない。

context_compileは1回、compile_evalは1回（runId: 00000000-0000-0000-18e4-a661acd35632、評価保存済み）。
