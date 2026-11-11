# UI制作担当からEvaluatorへの背景レビュー

2026年11月11日。Steerを導入した隔離ホストに `eumenes-evaluator@0.1.0` を追加した。対象は `binding:ui.studio@5` の手入力による会話。ホストは [基準測定とSteerの記録](../proactive-mode-a/README.md)と同じ確定版を使用した。各試行は一時SQLiteを作成し、既存の試験用HTTP入口から実行した。

## 依頼と結果の受け渡し

1. 制作担当は、独立レビューで次の判断が変わると見込んだとき、または利用者から依頼されたときに、確認したい問いと関連する確定条件のIDを通常の返答に添える。
2. ホストは現在の作品定義、条件の出所と版を保存済みのデータから照合し、通常の返答を確定した後、既存のバックグラウンドキューへ評価を登録する。
3. Evaluatorは別のモデル呼び出しで、固定した定義と選んだ条件を `workflow-correctness` のQuick評価にかける。評価枠は1回、60秒、入力64 KiB、Evaluatorの出力予算指定は2,000トークン。Codex接続での出力は使用量を観測した。
4. 制作担当は、同じ作品の版と条件が有効な場合に、完了した評価と根拠箇所を後続ターンの参考資料として受け取る。結果の有効期間は登録から5分。試験中の評価状態はプロセス内に保持する。

[ホスト差分](evaluator-host.patch) · [配布物の版とハッシュ](evaluator-package.json)

## 確認した結果

- Evaluator単体の `bun run verify` は50件通過。隔離ホストの固定試験はEvaluatorとSteerを合わせて4件通過。評価待ちに次の会話が完了し、対象の定義が更新された場合は評価結果を破棄した。選んだ確定条件だけを評価モデルに渡すことも確認した。 [固定試験ログ](fixed-tests.log) · [固定試験コード](fixed-test.ts.txt) · [ホスト型検査](typecheck.log)
- 既存のDialogue・Queueの関連試験は697件通過した。`verify` はルートに置いた試験専用ファイル2本が登録外のため一覧検査で停止した。既存試験には `bun run test:domain -- --domain dialogue --domain queue` を使い、試験専用ファイル2本は直接実行した。
- 初回の実モデル試験では見出しの不一致を検出したが、制作担当が保存した進行上の指示まで評価対象になった。Evaluatorはその条件の根拠を検証できず、全体を未完了とした。制作担当が評価対象の条件IDを指定し、ホストが保存済みの確定条件から解決する方式に更新した。 [初回の結果](live-first.json)
- 同じ合成依頼で再試験し、利用者に約12.2秒で現在の状況を返した。背景評価は約10.0秒で、確定条件「予約一覧」に対する定義値「申込一覧」の不一致を `/children/0/title` に特定した。制作担当は次のターンで、その背景評価を参照して不一致を報告した。初回と合わせて実モデル呼び出しは5回。モデルは `gpt-6.1-sol`、接続はログイン済みのCodexサブスクリプションを使った。 [再試験の結果](live-complete.json)

実モデル試験は、利用者が独立レビューを明示した合成ケース1件。制作担当が自発的にレビューを選ぶ頻度、画面の見た目と操作、再起動後の復旧、実行中のEvaluatorへのSteer配送は、この試験の範囲外。

## 再現

1. [Steerの再現手順](../proactive-mode-a/README.md#再現に必要なファイル)で作った隔離ホストを使う。
2. `eumenes_evaluator` の [配布物と一致するTGZ](evaluator-package.json) をオフラインで別の試験用フォルダーへ導入し、ホストから `eumenes-evaluator` として参照できるようにする。
3. [ホスト差分](evaluator-host.patch) を適用する。型検査用のライブラリー指定には、Evaluatorが利用する配列とコレクションの定義を追加した。
4. [固定試験コード](fixed-test.ts.txt)をホストのルートに `proactive-evaluator.test.ts` として置き、Steerの固定試験と併せて `bun test ./proactive-evaluator.test.ts ./proactive-steering.test.ts` を実行する。
5. [実モデル試験コード](live-runner.ts.txt)を同じ場所に `proactive-evaluator-live.ts` として置き、`bun proactive-evaluator-live.ts gpt-6.1-sol <新規出力ファイル>` を実行する。試験コードがEvaluatorの登録を有効にする。
