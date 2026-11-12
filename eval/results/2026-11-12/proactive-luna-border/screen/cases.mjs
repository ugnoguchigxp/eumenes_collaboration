const conditions = (entries) => entries.map(([id, text]) => ({ id, text }));
const rows = (text) =>
	text
		.trim()
		.split("\n")
		.map((line) => line.trim().split(" "));
const trace = rows(`
H-01 100 4 108 112 128 45 25 ja ja - N 24/SERVE
H-02 100 17 103 108 115 45 29 ja ja - N 29/VALIDATE
H-03 130 3 122 126 136 60 19 ja ja min-fresh=2 N 17/VALIDATE
H-04 100 20 113 118 135 30 34 ja ja max-stale=8 N 42/SERVE
H-05 100 20 113 118 135 30 34 ja ja max-stale=9 Y 42/SERVE
H-06 100 1 102 105 110 60 - en ja only-if-cached N 10/GATEWAY
H-07 100 1 102 105 110 60 - ja ja no-cache N 10/SERVE
H-08 100 30 120 125 148 80 65 ja ja max-age=58 N 58/VALIDATE`);

const cacheFields = [
	"date",
	"ageHeader",
	"requestTime",
	"responseTime",
	"decisionTime",
	"maxAge",
	"sMaxAge",
];
const ageFormula =
	"保守的な補正初期齢は、max(0, responseTime − date) と ageHeader + (responseTime − requestTime) の大きい方。そこに decisionTime − responseTime を加える。";
function cache(id, includeFormula, input, answers) {
	const decisions = input.map(([id, ...data]) => ({
		id,
		current: data.at(-1),
	}));
	const records = Object.fromEntries(
		input.map(([id, ...data]) => [
			id,
			{
				...Object.fromEntries(
					cacheFields.map((key, index) => [
						key,
						data[index] === "-" ? null : Number(data[index]),
					]),
				),
				storedLanguage: data[7],
				requestLanguage: data[8],
				requestDirective: data[9],
				mustRevalidate: data[10] === "Y",
			},
		]),
	);
	return makeCase(id, {
		utterance:
			"共有キャッシュの運用引継ぎ用に、添付の再利用判断を照合してください。各行を ID、現在齢（秒の整数）、期待動作（SERVE、VALIDATE、FETCH、GATEWAY）、現行との一致・要修正の4列の表にしてください。現在齢は再利用できない候補でも算出し、現行欄と独立に再計算してください。" +
			(includeFormula
				? ""
				: " 現在齢の計算根拠はRFC 9111の節と一次資料URLも表の下に添えてください。"),
		document: { records, decisions },
		conditions: conditions([
			[
				"age",
				includeFormula
					? ageFormula
					: "現在齢はRFC 9111 §4.2.3 の、古い経由キャッシュも考慮した保守的な方法で算出する。時刻は同じ基準の秒、Ageの単位も秒。",
			],
			[
				"match",
				"VaryはAccept-Languageのみ。値は完全一致。候補が一致しない場合はFETCH、only-if-cachedならGATEWAY（504）。",
			],
			[
				"fresh",
				"共有キャッシュの有効期間はsMaxAge、なければmaxAge。現在齢が有効期間未満なら通常新鮮。運用上、max-age=N は現在齢<=N、min-fresh=N は残存期間>=Nを追加条件とする。no-cache はVALIDATE。",
			],
			[
				"stale",
				"この運用では、期限切れの応答を返せるのはmax-stale=Nを指定し、超過秒<=Nで、mustRevalidateがfalseの場合だけ。他はVALIDATE。GATEWAYはonly-if-cachedで転送が必要な場合にも使う。",
			],
		]),
		expected: answers.map(([rowId, value, action], index) => [
			rowId,
			value,
			action,
			decisions[index].current === value + "/" + action ? "一致" : "要修正",
		]),
	});
}
const sourceTrace = trace.map(
	([id, date, age, req, res, now, ...tail], index) => [
		id,
		String(Number(date) + 40),
		String(Number(age) + (index % 3)),
		...[req, res, now].map((value) => String(Number(value) + 40)),
		...tail,
	],
);

const schedules = [
	[
		"I-01",
		"DTSTART;TZID=America/New_York:20260306T090000; RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5; EXDATE;TZID=America/New_York:20260309T090000; RDATE;TZID=America/New_York:20260310T090000",
		"20260309T000000Z/20260314T000000Z",
		"0310T1400Z+0311T1400Z+0313T1400Z",
	],
	[
		"I-02",
		"DTSTART:20260130T150000Z; RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4; EXDATE:20260227T150000Z",
		"20260201T000000Z/20260501T000000Z",
		"0331T1500Z+0430T1500Z",
	],
	[
		"I-03",
		"DTSTART;TZID=America/New_York:20260301T090000; RRULE:FREQ=WEEKLY;COUNT=3; override RECURRENCE-ID;TZID=America/New_York:20260308T090000 -> DTSTART;TZID=America/New_York:20260309T150000",
		"20260301T000000Z/20260316T000000Z",
		"0301T1400Z+0308T1300Z+0315T1300Z",
	],
	[
		"I-04",
		"DTSTART:20260307T090000Z; RRULE:FREQ=DAILY;COUNT=3; EXDATE:20260307T090000Z; RDATE:20260307T090000Z,20260310T090000Z",
		"20260307T000000Z/20260311T000000Z",
		"0308T0900Z+0309T0900Z+0310T0900Z",
	],
	[
		"I-05",
		"DTSTART:20260131T100000Z; RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=4",
		"20260301T000000Z/20260801T000000Z",
		"0331T1000Z+0531T1000Z",
	],
	[
		"I-06",
		"DTSTART:20260301T120000Z; RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,TU;WKST=SU;COUNT=5",
		"20260301T000000Z/20260320T000000Z",
		"0301T1200Z+0303T1200Z+0315T1200Z+0317T1200Z",
	],
	[
		"I-07",
		"DTSTART;TZID=America/New_York:20260307T090000; RRULE:FREQ=DAILY;UNTIL=20260310T130000Z; override RECURRENCE-ID;TZID=America/New_York:20260307T090000 -> DTSTART:20260309T140000Z",
		"20260308T130000Z/20260310T130000Z",
		"0308T1300Z+0309T1300Z+0310T1300Z",
	],
	[
		"I-08",
		"DTSTART:20260306T090000Z; RRULE:FREQ=WEEKLY;COUNT=4; RDATE:20260320T090000Z; override RECURRENCE-ID:20260313T090000Z -> STATUS:CANCELLED",
		"20260313T000000Z/20260328T000000Z",
		"0320T0900Z+0327T0900Z",
	],
];
const calendarAnswers = rows(`
I-01 0310T1300Z+0311T1300Z+0313T1300Z
I-02 0331T1500Z+0430T1500Z
I-03 0301T1400Z+0309T1900Z+0315T1300Z
I-04 0308T0900Z+0309T0900Z+0310T0900Z
I-05 0331T1000Z+0531T1000Z+0731T1000Z
I-06 0301T1200Z+0303T1200Z+0315T1200Z+0317T1200Z
I-07 0308T1300Z+0309T1300Z+0309T1400Z
I-08 0320T0900Z+0327T0900Z`);

function makeCase(id, { utterance, document, conditions, expected }) {
	return {
		id,
		input: {
			utterance,
			work: { id, version: "1", document },
			conditions,
			reviewComparison: {
				rowsField: "decisions",
				sourceFields: ["records"],
				currentValuePointer: "/current",
				rowLabelPointer: "/id",
			},
		},
		expected,
	};
}

export const cases = [
	cache(
		"cache-rules",
		true,
		trace,
		rows(`
H-01 28 VALIDATE
H-02 29 VALIDATE
H-03 17 SERVE
H-04 42 SERVE
H-05 42 VALIDATE
H-06 10 GATEWAY
H-07 10 VALIDATE
H-08 58 SERVE`),
	),
	cache(
		"cache-source",
		false,
		sourceTrace,
		rows(`
H-01 28 VALIDATE
H-02 30 VALIDATE
H-03 19 VALIDATE
H-04 42 SERVE
H-05 43 VALIDATE
H-06 11 GATEWAY
H-07 10 VALIDATE
H-08 59 VALIDATE`),
	),
	makeCase("calendar-exceptions", {
		utterance:
			"カレンダーの切替引継ぎ用に、iCalendarの各系列について対象窓で実際に残る開始時刻と、現行エクスポートとの差を照合してください。ID、開始時刻一覧（UTCでMMDDTHHmmZを時刻順に+で連結。空なら-）、現行との一致・要修正の3列で全系列を表にしてください。",
		document: {
			records: Object.fromEntries(
				schedules.map(([id, event, window]) => [id, { event, window }]),
			),
			decisions: schedules.map(([id, , , current]) => ({ id, current })),
		},
		conditions: conditions([
			[
				"recurrence",
				"RFC 5545で系列を展開する。COUNTにはDTSTARTを含む。存在しない暦日を数えない。RRULEとRDATEの同一開始は一件にまとめ、EXDATEは双方に優先する。",
			],
			[
				"overrides",
				"同一系列の単発overrideは元のRECURRENCE-IDを置き換え、CANCELLEDなら取り除く。対象窓は置き換え後の実際の開始に適用する。記号 -> は元と置き換え後の境界。",
			],
			[
				"timezone",
				"対象窓はUTCで開始を含み終了を含まない。America/New_Yorkの2026-03-08 02:00現地時刻で夏時間に切り替わる。それより前はUTC−05:00、切替後はUTC−04:00。iCalendarのプロパティは読みやすさのため同一行に連結している。",
			],
		]),
		expected: calendarAnswers.map(([id, value], index) => [
			id,
			value,
			schedules[index].at(-1) === value ? "一致" : "要修正",
		]),
	}),
];

export const procedures = [
	{
		title: "共有キャッシュの現在齢・再利用判定・引継ぎ照合",
		body: "共有キャッシュの観測ログから再利用結果を再構成し、現行値と比較する。現在齢はRFC 9111 §4.2.3の保守的な計算で、Dateの見かけ齢と、Ageに応答待ち時間を加えた補正齢を比べ、受信後の滞留は最後に足す。根拠 https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.3",
		steps: [
			"現行欄を伏せ、各行に見かけ齢・応答待ち・補正初期齢・滞留・現在齢を仮記録する。",
			"Vary、強制検証、共有キャッシュの鮮度、許可された期限切れの順に検討する。年齢と鮮度上限の等号は個別に照合する。",
			"再計算した現在齢と動作を対にして現行欄と比較し、すべてのIDが揃うことを確認する。",
		],
	},
	{
		title: "iCalendarの繰り返し・単発変更・UTC出力の照合手順",
		body: "カレンダー切替では、RFC 5545の繰り返し開始と元のインスタンスIDを残したまま、除外、移動、取消を反映し、実際の開始時刻を対象窓に照合する。",
		steps: [
			"系列ごとに元の開始候補を窓より先に確定し、COUNTを消費した場所に印を付ける。無効な日を飛ばす。",
			"RDATEとEXDATEの適用後に単発変更を元IDで突き合わせ、変更後の時刻を元の時刻と別欄に記録する。",
			"日付ごとに現地とUTCの差を確かめる。UTC化した実時刻で窓を適用し、昇順の一覧を現行欄と照合する。",
		],
	},
];
