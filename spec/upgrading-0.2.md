# 0.2.0への更新と復旧手順

対象は独立coreとexample host。製品EumenesのDB・bundle・端末への適用は別工程である。

## 互換性

- package 0.2.0。既存4 actionと状態schema 1、coreContractVersion 1は維持する。
- decisionContractVersion 1を追加した。decideSession、planSteps、parseBrowserChoiceはLLMの構造化提案を受け取る。旧版の原文文字列を渡す呼出しは変更が必要。削除した語句ベースの判断・履歴選択を模倣するfallbackは置かない。
- example/decision-turn.tsが既存ModelAdapterとメッセージ構築を再利用する接続例。工程やブラウザの必要性はLLMが提案し、hostが可用性・参照・予算を検査して実行する。
- Zodは4.6.6。固定host内の共有Zodは変更していない。隔離配布試験の合格を、製品全体の依存更新と取り違えない。

## 状態を更新するとき

proposeStateUpdateの成功後だけ、hostが状態とreceiptを同一transactionで保存する。1000件超過、容量超過、古い版、失効出所は拒否し、既存状態・receiptを残す。confirmedの訂正・除去には有効な利用者または観測の出所を必要とする。参照の有効性だけでは意味の正しさを保証しない。

## 旧版で保存された異常状態

1. 対象sessionのwriterを止め、現在のepoch、出所失効台帳、receiptを保持する。生JSONをアクセス制限された隔離領域へ保全する。
2. 非対応schemaと、既知schemaの件数・容量超過を区別する。非対応版は対応するreaderが用意されるまで保留する。空状態への初期化、先頭1000件への自動切詰め、古いDBへの巻戻しは行わない。
3. 既知の異常はhost管理者と利用者が現在有効な条件を確認し、整理した状態を別sessionに明示的に採用する。失効したsourceRefを再利用せず、必要なら現在の同意を新しい出所として発行する。原sessionは保存し、整理内容と対応を記録する。
4. 新状態で訂正・再開・忘却を確認し、hostの既存経路で切り替える。本repoに製品用の自動修復migrationは含めない。

## 外部操作がqueued/stoppingのまま残ったとき

同じrequestIdのsubmitは状態の照会になり、自動再送しない。現在のattemptを読み、reconcile(requestId, attempt)を呼ぶ。hostのinspectが正本を返せば照合し、照合できなければunknownを残す。外部受付・停止を人または正式なhost接点で確認するまで、新しい依頼として送信し直さない。古いattemptの返答、別世代、別session、忘却後の返答を採用しない。completedは外部からの報告であり、独立確認済みではない。

## APIキーと費用

キーはログインシェルのANTHROPIC_API_KEY、OPENAI_API_KEYから読む。.zprofileのCLAUDE_API_KEY、OPEN_AI_API_KEYを標準名に対応させれば、プロジェクト別.envは不要。既存アプリからは新しいログインシェルで起動する。キーをログやreportへ出さない。

実API試験はeval/live.ts、接続前検査はeval/preflight.ts。合成課題のみを送り、tool実行は許可しない。全試行が同じreports/quality-2026-11-05/api-budget.sqliteを使う。費用不明の呼出しは予約全額を残す。このDBを削除・リセットして再試行しない。上限は両provider合計10米ドル。台帳は請求明細ではなく、公開単価による保守的概算と不明額の予約を記録する。

## 切戻しと配布

bun install --frozen-lockfile、bun run verify、bun audit --production、PACK_CHECK_REQUIRE_HOST=1でのpack:checkを行う。manifestとspec/verification.jsonのソースcommit・配布物checksum・固定hostを照合する。配布物にexampleのDB・APIキー・評価ログは含めない。

切戻しはコードと互換readerの切替で行い、忘却前のDBを復元しない。0.1系のdecision helperへ戻す場合は呼出し契約も旧版へ戻す必要がある。製品用のmigration・実renderer・実外部agentの受入と利用者の承認は、本repoのfixtureや配布互換では代用できない。
