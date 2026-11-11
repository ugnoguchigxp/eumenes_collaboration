const trial = (
	id,
	title,
	utterance,
	document,
	conditions,
	criteria,
	useful,
	procedureCheck,
) => ({
	id,
	title,
	input: {
		utterance,
		work: { id, version: "1", document },
		conditions: conditions.map(([id, text]) => ({ id, text })),
	},
	criteria,
	useful,
	procedureCheck,
});

export const cases = [
	trial(
		"01",
		"案内の短文化",
		"受付担当がそのまま貼り出せるよう、現在の案内を見出しと一文にまとめてください。時間と窓口名は残してください。",
		{
			title: "来客受付",
			description: "平日9:00–17:00、東棟1階の総合窓口で受付をしています。",
		},
		[
			["schedule", "受付は平日9:00–17:00。"],
			["location", "東棟1階の総合窓口で受け付ける。"],
		],
		[
			"見出しが来客受付の趣旨を維持する",
			"平日9:00–17:00を正確に記載する",
			"東棟1階・総合窓口を両方記載する",
			"本文が一文でそのまま掲示可能",
		],
		{ review: false, skill: false },
	),
	trial(
		"02",
		"取消後の通知分岐",
		"来週の受入担当に渡す、取消後の通知分岐の確認票を作ってください。現状で条件を満たすものと、直してから出すものが見分けられるようにしてください。",
		{
			rules: [
				{
					id: "a",
					when: { cancelled: true, shipped: false, notifyOptOut: false },
					send: true,
				},
				{
					id: "b",
					when: { cancelled: true, shipped: false, notifyOptOut: true },
					send: true,
				},
				{
					id: "c",
					when: { cancelled: true, shipped: true, notifyOptOut: false },
					send: false,
				},
				{
					id: "d",
					when: { cancelled: false, shipped: false, notifyOptOut: false },
					send: true,
				},
			],
		},
		[
			[
				"gate",
				"取消通知を送るのは取消済み・未発送・通知辞退なしをすべて満たすときだけ。",
			],
		],
		[
			"aとcを適合と判定する",
			"bを不適合とし辞退時は送らないと示す",
			"dを不適合とし取消なしでは送らないと示す",
			"分岐IDと判定が対応し、外部送信済みと断定しない",
		],
		{ review: true, skill: false },
	),
	trial(
		"03",
		"機材貸出の受付引継ぎ",
		"明日の窓口担当へ、機材貸出の受付引継ぎ票を作ってください。次の担当が、何を確認して、どの案件から手を付けるか一目で分かるようにしてください。",
		{
			asOf: "2026-11-12 09:00",
			items: [
				{
					id: "EQ-41",
					returnDue: "10:30",
					inspection: "未確認",
					borrower: "研修班",
				},
				{
					id: "EQ-52",
					returnDue: "16:00",
					inspection: "済み",
					borrower: "営業班",
				},
			],
		},
		[
			["as-of", "2026-11-12 09:00時点。"],
			["pending", "未確認の点検を実施済みとして扱わない。"],
		],
		[
			"EQ-41を先に扱うことと10:30を記載する",
			"EQ-41の点検が未確認と明示する",
			"EQ-52の16:00と点検済みを記載する",
			"窓口担当が次に行う具体的な確認がある",
		],
		{ review: false, skill: true },
		"貸出引継ぎ区分：未完了",
	),
	trial(
		"04",
		"日次の欠品引継ぎ",
		"次のシフトへ、未解決の欠品対応の引継ぎ票を作ってください。判断に必要な事実と次の行動を短く残してください。",
		{
			asOf: "14:00",
			tickets: [
				{
					id: "S-18",
					item: "梱包材",
					stock: 0,
					promised: "15:00",
					inbound: "未回答",
				},
				{
					id: "S-21",
					item: "伝票",
					stock: 2,
					promised: "18:00",
					inbound: "16:30確定",
				},
			],
		},
		[
			["unknown", "未回答の入荷を確定として案内しない。"],
			["priority", "在庫ゼロで対応期限が早いものを先に扱う。"],
		],
		[
			"S-18を最優先とし在庫0・15:00を記載する",
			"S-18の入荷が未回答であると明示する",
			"S-21の在庫2・入荷16:30確定を両方記載する",
			"確認先または次の行動を具体的に示し、入荷を推測しない",
		],
		{ review: false, skill: true },
		"欠品引継ぎ区分：入荷回答待ち",
	),
	trial(
		"05",
		"公開前の承認・例外",
		"担当交代に備えて、公開判断を引き継ぐ短い表を作ってください。今日扱う行ごとに、公開に進めるか、止めるならその理由と次の一手が必要です。",
		{
			asOf: "2026-11-13",
			candidates: [
				{
					id: "P-01",
					contentApproved: true,
					disclosureApproved: true,
					embargoUntil: "2026-11-14",
					emergency: false,
				},
				{
					id: "P-02",
					contentApproved: true,
					disclosureApproved: false,
					embargoUntil: "2026-11-12",
					emergency: true,
				},
				{
					id: "P-03",
					contentApproved: true,
					disclosureApproved: true,
					embargoUntil: "2026-11-12",
					emergency: false,
				},
				{
					id: "P-04",
					contentApproved: false,
					disclosureApproved: true,
					embargoUntil: "2026-11-12",
					emergency: false,
				},
			],
		},
		[
			[
				"approval",
				"内容・公開範囲の承認を両方取得すること。緊急でも公開範囲承認は省略不可。",
			],
			["embargo", "解禁日が到来するまでは公開しない。"],
		],
		[
			"P-01を保留し11-14以降の再確認を示す",
			"P-02を保留し緊急でも公開範囲承認を取ると示す",
			"P-03だけを公開可とする",
			"P-04を保留し内容承認を取ると示す",
		],
		{ review: true, skill: true },
		"公開引継ぎ区分：承認待ちあり",
	),
	trial(
		"06",
		"予約上限と重複判定",
		"予約担当が使う判定表を仕上げてください。次の4件で現在の判定を運用に出せるかを行ごとに示し、要修正の行では期待する判定も書いてください。",
		{
			cases: [
				{ id: "R1", total: 6, limit: 6, duplicate: false, current: "受付" },
				{ id: "R2", total: 6, limit: 6, duplicate: true, current: "受付" },
				{
					id: "R3",
					total: 7,
					limit: 6,
					duplicate: false,
					current: "拒否：上限",
				},
				{
					id: "R4",
					total: 7,
					limit: 6,
					duplicate: true,
					current: "拒否：上限",
				},
			],
		},
		[
			["limit", "上限ちょうどまでは受付可能。上限を超えたときは拒否。"],
			[
				"priority",
				"重複を優先する。上限超過も同時に成立する場合の拒否理由は重複。",
			],
		],
		[
			"R1とR3を現状適合とする",
			"R2を要修正とし重複拒否を示す",
			"R4を要修正とし上限理由から重複理由へ変更と示す",
			"4件がID付きで読め、重複優先を明示する",
		],
		{ review: true, skill: false },
	),
];

export const procedures = [
	{
		title: "機材貸出の受付引継ぎ票の作り方",
		body: "機材貸出の受付引継ぎ票を作成する。最初に貸出引継ぎ区分を書く。点検が未確認の機材があれば「貸出引継ぎ区分：未完了」。戻りの締切が早く点検も未確認の案件を先にし、点検表を照合する。欠品や公開可否の引継ぎには使わない。",
		steps: [
			"表題の直後に貸出引継ぎ区分を入れる。点検が未確認なら「貸出引継ぎ区分：未完了」。",
			"案件ID・戻り予定・点検状態を行に記す。",
			"未確認を担当へ引き継ぐ。",
		],
	},
	{
		title: "欠品対応のシフト引継ぎ票の作り方",
		body: "欠品対応のシフト引継ぎ票を作成する。入荷時刻未回答の案件があれば冒頭に「欠品引継ぎ区分：入荷回答待ち」と書く。次に優先案件・入荷の根拠・次の行動を記す。機材貸出や公開判定には適用しない。",
		steps: [
			"入荷が未回答のときは冒頭に「欠品引継ぎ区分：入荷回答待ち」。",
			"在庫と期限を照合して順番を決める。",
			"確定入荷と未回答を区別し次の担当の確認事項を書く。",
		],
	},
	{
		title: "公開判断と承認の担当交代引継ぎ",
		body: "公開判断の担当交代で使う。承認未取得の案件を一件でも引き継ぐときは冒頭に「公開引継ぎ区分：承認待ちあり」と書く。案件、判断、停止理由、次の一手を表にする。承認や解禁条件はその案件の正式資料に従う。",
		steps: [
			"承認未取得を含む場合は「公開引継ぎ区分：承認待ちあり」を冒頭に入れる。",
			"案件ごとに判断・停止理由・次の一手をそろえる。",
		],
	},
];
