# 状態提案の契約（P2、example hostで検証）

状態はhostが保存し、coreは構造と参照の検査・更新候補だけを返す。利用者の発言の意味や、どの条件が訂正されたかはLLMが決める。対象schemaの語句を識別する製品コードは追加しない。

schema 1はsessionId、revision、coreContractVersion、packageVersion、work（ref/revision/digest）、factsを持つ。factsの各要素はid、kind（condition/decision/assumption/question）、status（proposed/confirmed/rejected/retracted）、value、sourceRefs、supersedesを持つ。出所の本文はhostの正本を参照し、状態内に複製しない。

更新提案は契約版、sessionId、epoch、expectedRevision、work、upsertsとremovalsを持つ。hostが発行した有効なsourceRefだけを認める。confirmedへの変更には利用者または観測の出所を必要とし、エージェントの提案だけから確定事項を作れない。意味の一致は別評価とし、参照の存在だけで意味品質を保証しない。

hostは既存epoch、現在文書版、sourceRefの失効を照合し、古い提案は拒否する。重複fact id、同じidの更新と削除、存在しないsupersedesを拒否する。confirmedとして採用した置換だけが前の条件をretractedにする。未採用・却下案のsupersedesは履歴として保持する。confirmedの直接の格下げ・除去にも有効な利用者または観測の出所が必要。事実が過去の忘却済み出所や消えた条件へ依存する場合は再採用しない。

example hostはSQLiteにexample専用のsession・状態JSON・operation receiptを保存する。CASとreceiptを単一transactionで確定する。DBのバージョンは移行台帳で管理し、再初期化で状態を消さない。旧sessionは空のfactsから初期化する。非対応stateSchemaVersionは保留理由を返し、JSONを上書きしない。再開時にpending operationを再送しない。

忘却はhost発行の失効集合を正本とし、当該出所に依存するfactとその置換関係を除去する。更新提案に元の出所が残っていれば拒否する。古いDBバックアップの復元を切戻し手順に含めない。exampleは製品dialogueのmigrationを代用せず、採用時にはEumenes側の専用migrationと公開操作の接続が別途必要である。

0.2.0は合成後の候補も再検査する。factsは1000件まで、JSONは直列化後2MiB・100000node・深さ64まで。上限超過は保存前に拒否し、状態とreceiptを残す。過去の超過状態・非対応版を自動切詰めせず、[復旧手順](upgrading-0.2.md)に従う。

コードレビュー後は、忘却の出力も同じschema・容量を再検査する。訂正を複数まとめて採用する場合は、採用する置換関係を先に固定し、入力順で撤回結果が変わらないようにする。工程idは`plan.`と`result.`を付けたfact idが256文字に収まる249文字までとする。

exampleの状態writerと外部adapterは、同じsession/sourceRefの永続失効台帳を参照する。新しい依頼・回答・状態初期化も、古いhostスナップショットだけでは失効を覆せない。回答の出所も記録し、忘却時にはその回答に依存する外部記録を伏せる。出所を持たない旧回答は、無関係と証明できないため、そのsessionで非空の忘却を行う際に保守的に伏せる。既存の版1DBの状態・receipt・失効行は保持する。

0.3.0では、失効した出所による拒否（`state_sources_invalid`）が、忘却すべき出所を `staleRefs` で返す。hostはそれを忘却してから提案し直す。忘却は `sessionId` と `expectedRevision` を照合し、確定済みの訂正だけが忘却されたために置換を失った `retracted` のfactを `orphaned` として返す。それらは復活させずに残し、尋ね直すかどうかはhostとLLMが決める。理由コードは `STATE_REJECT_REASONS` として公開する。手順は [0.3.0への更新](upgrading-0.3.md) を参照。
