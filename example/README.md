# Eumenesのadapter構造を参考にした接続例

追加指示に従い、接続はexampleに置く。製品DB・設定・端末・bundleを複製・変更せず、coreにI/Oを持ち込まない。

| ファイル | 接点 |
| --- | --- |
| adapters/model.ts | ModelAdapterと固定モデル |
| adapters/claude-model.ts | Claude Agent SDKを使うモデル接続。Eumenesのcloud-agents.tsを参考に、toolsなし・設定読込みなし・履歴保存なしで構造化出力を受ける |
| host.ts / state-turn.ts | 現行actionの提案と、出所付き条件の更新提案。採用前の結果を完了報告に使わない |
| state-store.ts / forget.ts | example専用SQLite、単一writer、receipt、忘却の同時確定 |
| adapters/observation.ts | UI/Pipeline等の実adapterが返す観測を現在版へ照合する。fixtureを実画面と呼ばない |
| adapters/external.ts | 出所・権限ref・対象session/世代を固定した依頼、質問回答、重複防止、停止のledger |
| adapters/eumenes-terminals.ts | hostが既存の登録操作へ接続する薄いbridge。owner/originを捏造せずhostに委ねる |
| scenario.ts | 固定モデルによる作成・訂正・再開・忘却の通し実行 |

## 実モデルの接続

`createClaudeModel({ model, cwd, maxBudgetUsd, maxCalls, env })`を呼び、返ったadapterを`propose`または`proposeFacts`へ渡す。modelは実行時に選んだ識別子、cwdは隔離したテストディレクトリ、envは専用テストcredential/configを指す設定とする。正の費用上限と最大呼出し数がない場合は起動しない。同一adapterで並行呼出しはしない。費用不明で終わった接続は自動再試行しない。

通常のCLIは固定モデルであり、実SDKの起動、Claude Codeへの作業依頼、製品接続先の読取りを行わない。SDKの実出力・認証・費用計測の受入は、明示したテスト設定と予算を用意した後に行う。

## 外部作業

hostはExternalTarget、ExternalGrant、現在epoch、有効な出所を発行する。grantは依頼本文のdigest・project・session・世代・依頼版に一致する必要がある。編集した依頼に前のgrantを流用できない。requestIdの再照会で依頼を再送せず、外部への送信はDB transactionの外で一回だけ行う。

通常質問にはquestionId・世代・利用者の出所を付けて回答する。permission/authenticationはhostへ戻す。既存Eumenes terminalsのbridgeには作業中の質問へ答える正式操作がないため、answerQuestionを公開しない。構造化した正式接点をhostに追加した場合だけ対応する。

利用者の端末入力中や対象世代の変更時は自動入力を拒否する。停止確認がなければunknown。外部のcompletedは報告の終了であり、independentlyVerifiedはfalseのまま。差分・試験の独立確認と利用者の受入は別工程となる。

ここでのsession/世代/質問の契約はexampleのfixtureで検証している。実Claude Codeの操作品質、実rendererの表示、製品dialogueのmigrationを検証済みとは扱わない。
