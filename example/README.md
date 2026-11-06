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

呼出しごとに`timeoutMs`（既定120000）を適用する。呼出し元のsignalとは`AbortSignal.any`で合成し、どちらが先でも中断する。timeoutした呼出しは費用不明として扱い、以後その接続は起動前に`model_budget_exhausted`で拒否する（保守的な挙動。新しい接続を作るまで再開しない）。

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

利用者の端末入力中や対象世代の変更時は自動入力を拒否する。停止確認がなければ状態値はunknownになる。

### 停止の意図と照合（0.3）

記録の`stopRequested`はhostの「止めたい」という意図、`status`は観測した外部の状態であり、別に持つ。最初の`stop()`で`stopRequested`が付き、以後は消えない。停止を確認できなければ`status`はunknownだが、終端でない限りhostは`stop()`を明示的に呼び直せる（`stopping`で送信中の間は重複送信しない）。自動では再送しない。

`reconcile()`は照合の前に状態値を上書きしない（古いcallbackを無効にするためattemptだけ進める）。結果は次のとおり。

| 現在の状態 | inspectの結果 | 次の状態 |
| --- | --- | --- |
| queued（配送の途中で中断） | なし・失敗・unknown | unknown |
| queued | delivered / started / 終端 | 観測値 |
| delivered / started / waiting | なし・失敗・unknown | 維持し、戻り値に`inspection:"inconclusive"` |
| delivered / started / waiting | 非終端の観測値 | 後退させない（queued < delivered < started。waitingは外部イベントでのみ移る） |
| 終端でない任意の状態 | completed / stopped | 観測値 |
| stopping / unknown | 非終端の観測値 | 観測値（`stopRequested`は残す） |
| stopping / unknown | なし・失敗・unknown | unknown |
| 回答がpending | inspectなし | 回答をunknownにする |

inspectを持たないportでwaitingを照合しても、状態はwaitingのままなので`answer()`は成功する。外部のcompletedは報告の終了であり、independentlyVerifiedはfalseのまま。差分・試験の独立確認と利用者の受入は別工程となる。

ここでのsession/世代/質問の契約はexampleのfixtureで検証している。実Claude Codeの操作品質、実rendererの表示、製品dialogueのmigrationを検証済みとは扱わない。

直接APIは`adapters/api-model.ts`、永続した合計予算は`adapters/api-budget.ts`に分ける。Messages/Responses API、toolなし、自動retryなし、モデル置換なし。実行・更新・復旧の詳細は[0.2更新手順](../spec/upgrading-0.2.md)、結果は[品質改善記録](../spec/history/2026-11-05/quality-execution-2026-11-05.md)を参照。SDK接続のfixture成功と直接APIの成功は別に記録する。

`propose`の第4引数にはhostが登録した操作の引数JSON Schemaを渡せる。モデルへnativeな構造を示して、長文を汎用JSON文字列へ二重化する費用を避ける。実行側のaction、操作引数、版・権限の検査は引き続き必要。原文保持の指示は本文生成側でも適用する。[小説試験](../spec/history/2026-11-05/writing-pilot-2026-11-05.md)に反復制作の例を置いた。

接続を作成した後に元の設定オブジェクトを書き換えても、モデル・費用上限・明示したSDK環境は変更されない。設定を変える場合は新しい接続を作る。省略したSDK環境の継承は維持する。

API表現では、省略可能かつnullableな値を、外側のnull（省略）と`{value:null}`（明示したnull）で区別する。nullable/unionの内側も復元し、解釈が複数に分かれる表現や、このadapterで正規化していないallOfは送受信時に拒否する。元のhost schemaによる検査を省略しない。実APIへ送って再確認した結果ではなく、今回の非課金の契約試験で検証している。

## 判断ターン（0.3）

`decision-turn.ts`はLLMの構造化したsession/plan提案を既存ModelAdapterへ接続する。`proposeDecisions(model, input, closed, sourceRef, signal)`の`sourceRef`には、hostが発行した現在の発言のrefを渡す。生成されたplanのfactはこのrefを出所に持つので、固定値の出所を使わない。結果は例外ではなく値で返す。推論が終わった後は、形式違反でも`{ok:false, reason, costUsd}`で費用を返し、成功すれば`{ok:true, session, plan, costUsd}`を返す。推論そのものの失敗（取消・予算切れ）だけが例外で、その費用はadapter側の予算台帳に残る。

## 忘却（0.3）

`forgetCollaborationSources(store, external, sessionId, refs, sourceRevision)`は、状態と外部依頼の保持文を同じtransactionで忘れ、`{state, orphaned, affected}`を返す。

- `orphaned`：訂正した発言だけを忘れると、置換元の値は`retracted`のまま残る（古い条件を黙って復活させないため）。その置換元のidを返す。hostは次の状態ターンで`proposeFacts(..., { reconfirm: orphaned })`として渡す。メッセージには`RECONFIRM=`として添えられ、LLMが必要なら尋ね直すquestionを提案する。コアは文を作らない。
- `affected`：保持文を消した外部依頼ごとに`{id, previousStatus, needsStop}`を返す。`needsStop`は直前の状態がdelivered / started / waiting / stopping / unknownのときtrue。queuedは`cancelled`になり`needsStop:false`。**停止は自動では行わない。** 止めるかどうかはhostが決め、止める場合は`stop()`を呼ぶ。
- **外部agentに渡した原文は、こちらの忘却では消えない。** 消えるのはこの台帳の保持文だけで、外部側の履歴や出力は外部の運用で扱う。

## 予算とSQLite（0.3）

- 予約の解放：`ApiBudget.release(id, metadata)`は`pending`の予約だけを費用0・`released`にする。`api-model.ts`は、応答が推論前の拒否を示すstatusのときだけ解放する。既定は400, 401, 403, 404, 413, 422, 429で、`releaseOnStatus`で上書きできる（空配列なら解放しない。408と4xx以外は指定できない）。5xx・408・timeout・切断・本文の破損・取消は従来どおり予約を残して費用不明とする。**この一覧は公式文書が未課金と明記したものではなく、HTTPの意味に基づく推定**である（根拠はapi-model.tsのコメント）。
- ロック待ち：`ApiBudget`と`ExampleStateStore`のconstructorは、任意の`busyTimeoutMs`（既定5000）で`PRAGMA busy_timeout`を設定する。待っても書込みロックを取れなければ`api_budget_busy` / `state_store_busy`で失敗し、予約や受付記録は残らない。同じファイルを複数の接続（評価の並行worker等）が使うときのための設定である。
