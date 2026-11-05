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

`createClaudeModel({ model, cwd, maxBudgetUsd, maxCalls })`を呼び、返ったadapterを`propose`または`proposeFacts`へ渡す。modelは実行時に選んだ識別子、cwdは隔離したテストディレクトリとする。envを省略するとSDKが起動元の環境変数を継承する。envを明示した場合はそのmapだけを渡し、親環境と混ぜない。正の費用上限と最大呼出し数がない場合は起動しない。同一adapterで並行呼出しはしない。費用不明で終わった接続は自動再試行しない。

### APIキーを共通の環境変数から使う

プロジェクトごとの`.env`は不要。`.zprofile`の`CLAUDE_API_KEY`と`OPEN_AI_API_KEY`を、SDKの標準名へ対応させたログインシェルから起動する。次の行はキー本体を複製せず、既にexportされた値を引き継ぐ。

```sh
export ANTHROPIC_API_KEY="$CLAUDE_API_KEY"
export OPENAI_API_KEY="$OPEN_AI_API_KEY"
```

設定後は新しいログインシェルを開くか、現在のターミナルで`source ~/.zprofile`を実行する。既に動いているアプリの環境は自動更新されないため、そこから実行する検証ではログインシェルを経由する。Codexなどの既存プロセスからは`zsh -lc '<検証コマンド>'`で起動できる。アプリ内から`.zprofile`を読み込んだり、キーの値を設定ファイル・ログへ保存したりしない。

Claude接続ではenvを省略すれば`ANTHROPIC_API_KEY`を継承する。直接APIの`createApiModel`も同じく`OPENAI_API_KEY`を起動環境から読む。キーが存在しても固定モデルの通常CLIが実APIへ切り替わることはなく、実モデルの選択と費用上限は別途指定する。

通常のCLIは固定モデルであり、実SDKの起動、Claude Codeへの作業依頼、製品接続先の読取りを行わない。SDKの実出力・認証・費用計測の受入は、明示したテスト設定と予算を用意した後に行う。

## 外部作業

hostはExternalTarget、ExternalGrant、現在epoch、有効な出所を発行する。grantは依頼本文のdigest・project・session・世代・依頼版に一致する必要がある。編集した依頼に前のgrantを流用できない。requestIdの再照会で依頼を再送せず、外部への送信はDB transactionの外で一回だけ行う。

通常質問にはquestionId・世代・利用者の出所を付けて回答する。permission/authenticationはhostへ戻す。既存Eumenes terminalsのbridgeには作業中の質問へ答える正式操作がないため、answerQuestionを公開しない。構造化した正式接点をhostに追加した場合だけ対応する。

利用者の端末入力中や対象世代の変更時は自動入力を拒否する。停止確認がなければunknown。外部のcompletedは報告の終了であり、independentlyVerifiedはfalseのまま。差分・試験の独立確認と利用者の受入は別工程となる。

ここでのsession/世代/質問の契約はexampleのfixtureで検証している。実Claude Codeの操作品質、実rendererの表示、製品dialogueのmigrationを検証済みとは扱わない。

直接APIは`adapters/api-model.ts`、永続した合計予算は`adapters/api-budget.ts`に分ける。Messages/Responses API、toolなし、自動retryなし、モデル置換なし。`decision-turn.ts`はLLMの構造化したsession/plan提案を既存ModelAdapterへ接続する。実行・更新・復旧の詳細は[0.2更新手順](../spec/upgrading-0.2.md)、結果は[品質改善記録](../spec/quality-execution-2026-11-05.md)を参照。SDK接続のfixture成功と直接APIの成功は別に記録する。

`propose`の第4引数にはhostが登録した操作の引数JSON Schemaを渡せる。モデルへnativeな構造を示して、長文を汎用JSON文字列へ二重化する費用を避ける。実行側のaction、操作引数、版・権限の検査は引き続き必要。原文保持の指示は本文生成側でも適用する。[小説試験](../spec/writing-pilot-2026-11-05.md)に反復制作の例を置いた。

接続を作成した後に元の設定オブジェクトを書き換えても、モデル・費用上限・明示したSDK環境は変更されない。設定を変える場合は新しい接続を作る。省略したSDK環境の継承は維持する。

API表現では、省略可能かつnullableな値を、外側のnull（省略）と`{value:null}`（明示したnull）で区別する。nullable/unionの内側も復元し、解釈が複数に分かれる表現や、このadapterで正規化していないallOfは送受信時に拒否する。元のhost schemaによる検査を省略しない。実APIへ送って再確認した結果ではなく、今回の非課金の契約試験で検証している。
