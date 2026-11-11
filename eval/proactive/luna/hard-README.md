# Luna lowの難問セット

通常の6課題に加える、3件の合成課題。取消通知、欠品引当、公開承認を対象とする。各課題には現行の判定と、再計算に必要な元帳・確定条件が揃う。支援ありでも事実と採点基準は同じ。Skill Smithに登録する手順は照合方法だけを提供する。

各課題8行を採点する。正答行は、判定、根拠IDまたは引当内訳、現行との照合を含む、指定した業務項目がすべて正しい行。列単位の正答率も併記する。記号の空白、装飾、ロット内訳の記載順は得点に影響しない。書式だけを理由に不合格となった行がないか、方式名を伏せた成果物で確認する。表の後の補足は得点に含めない。

難易度の目安は支援なしで正答行率40〜60%。Luna 6.0 `low` を各課題2回、1試行につき初回返答と成果物作成の2呼び出しで測る。3課題の全行が正しい件数も併記する。調整に使った試行は校正として扱う。

```sh
bun eval/proactive/luna/run.mjs <隔離ホスト> <新規結果ディレクトリ> --hard --current-only --repetitions=2
bun eval/proactive/luna/score-hard.mjs <結果ディレクトリ>
```

支援ありも比較する場合は `--current-only` を外す。従来の6課題を実行する場合は `--hard` を付けない。

[追加3課題の校正結果](../../results/2026-11-11/proactive-luna-low-hard/README.md)

EvaluatorとSKILLを単独で使う条件を含めて比較するときは `--hard --isolate-support --repetitions=2` を指定する。

[EvaluatorとSKILLの個別比較](../../results/2026-11-11/proactive-luna-low-hard-isolated/README.md)
