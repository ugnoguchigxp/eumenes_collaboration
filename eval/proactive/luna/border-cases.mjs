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
function cache(id, includeFormula, input, answers, actionOnly = false) {
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
		utterance: actionOnly
			? "次シフトがそのまま使える共有キャッシュの再利用判断を作ってください。添付ログから再計算し、ID、期待動作（SERVE、VALIDATE、FETCH、GATEWAY）、現行との一致・要修正の3列で全件を照合してください。期限切れ応答をそのまま配る誤りと、不要な再検証をどちらも避けたいです。"
			: "共有キャッシュの運用引継ぎ用に、添付の再利用判断を照合してください。各行を ID、現在齢（秒の整数）、期待動作（SERVE、VALIDATE、FETCH、GATEWAY）、現行との一致・要修正の4列の表にしてください。現在齢は再利用できない候補でも算出し、現行欄と独立に再計算してください。" +
				(includeFormula
					? ""
					: " 現在齢の計算根拠はRFC 9111の節と一次資料URLも表の下に添えてください。"),
		document: { records, decisions },
		expectedValues: actionOnly
			? ["SERVE", "VALIDATE", "FETCH", "GATEWAY"]
			: undefined,
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
			...(actionOnly ? [] : [value]),
			action,
			decisions[index].current === (actionOnly ? action : value + "/" + action)
				? "一致"
				: "要修正",
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

function makeCase(
	id,
	{ utterance, document, conditions, expected, expectedValues, sourceFields },
) {
	return {
		id,
		input: {
			utterance,
			work: { id, version: "1", document },
			conditions,
			reviewComparison: {
				rowsField: "decisions",
				sourceFields:
					sourceFields ??
					Object.keys(document).filter((key) => key !== "decisions"),
				currentValuePointer: "/current",
				rowLabelPointer: "/id",
				expectedValues,
			},
		},
		expected,
	};
}

const sqliteSetup = [
	"PRAGMA foreign_keys=ON",
	"CREATE TABLE p(id INTEGER PRIMARY KEY)",
	"CREATE TABLE c(id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES p(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, qty INTEGER UNIQUE)",
	"INSERT INTO p VALUES (1),(2)",
	"INSERT INTO c VALUES (10,1,5),(20,2,8)",
];
const sqliteTraces = [
	[
		"T-01",
		"10+20",
		"10+20+30",
		[
			"BEGIN",
			"INSERT INTO c VALUES (30,3,6)",
			"COMMIT",
			"INSERT INTO p VALUES (3)",
			"COMMIT",
		],
	],
	[
		"T-02",
		"10+20+50",
		"10+20+50",
		[
			"SAVEPOINT root",
			"INSERT INTO c VALUES (30,3,6)",
			"SAVEPOINT inner",
			"INSERT INTO c VALUES (40,4,7)",
			"RELEASE inner",
			"RELEASE root",
			"ROLLBACK TO root",
			"RELEASE root",
			"INSERT INTO c VALUES (50,2,3)",
		],
	],
	[
		"T-03",
		"10+20+30+50",
		"10+20+50",
		[
			"BEGIN",
			"INSERT INTO c VALUES (30,2,3)",
			"SAVEPOINT s",
			"INSERT OR ROLLBACK INTO c VALUES (40,1,8)",
			"ROLLBACK TO s",
			"INSERT INTO c VALUES (50,1,4)",
			"COMMIT",
		],
	],
	[
		"T-04",
		"10+20",
		"20+30",
		[
			"INSERT OR REPLACE INTO p VALUES (1)",
			"INSERT INTO c VALUES (30,1,5)",
			"INSERT OR IGNORE INTO c VALUES (40,1,8)",
		],
	],
	[
		"T-05",
		"10+20+30",
		"10+20+30+40",
		[
			"BEGIN",
			"SAVEPOINT s",
			"INSERT INTO c VALUES (30,2,3)",
			"INSERT OR FAIL INTO c VALUES (40,1,6),(50,1,8),(60,1,7)",
			"RELEASE s",
			"COMMIT",
		],
	],
	[
		"T-06",
		"10+20+30",
		"10+20+30",
		[
			"BEGIN",
			"SAVEPOINT s",
			"INSERT INTO c VALUES (30,2,3)",
			"INSERT OR ABORT INTO c VALUES (40,1,6),(50,1,8),(60,1,7)",
			"RELEASE s",
			"COMMIT",
		],
	],
	[
		"T-07",
		"20+30",
		"20+30",
		[
			"BEGIN",
			"INSERT INTO c VALUES (30,3,6)",
			"DELETE FROM p WHERE id=1",
			"COMMIT",
			"ROLLBACK TO absent",
			"INSERT INTO p VALUES (3)",
			"COMMIT",
		],
	],
	[
		"T-08",
		"30+40",
		"10+20+40",
		[
			"BEGIN",
			"SAVEPOINT s",
			"DELETE FROM p WHERE id=2",
			"INSERT OR REPLACE INTO c VALUES (30,1,5)",
			"ROLLBACK TO s",
			"INSERT INTO c VALUES (40,2,3)",
			"RELEASE s",
			"COMMIT",
		],
	],
];

const subtitleCues = [
	["S-01", 1200, 1200, true, null, [8], null, "PASS", "FIX_TIME"],
	[
		"S-02",
		1500,
		3500,
		false,
		null,
		[12, 11],
		null,
		"HOLD_SOURCE",
		"HOLD_SOURCE",
	],
	["S-03", 4000, 5400, true, 3, [20, 10], null, "FIX_LINE", "PASS"],
	["S-04", 9400, 10300, true, 3, [8], null, "FIX_TIME", "FIX_TIME"],
	["S-05", 2600, 4600, true, null, [14, 12], 2400, "FIX_RATE", "PASS"],
	["S-06", 2600, 4600, true, null, [15, 9], 2401, "PASS", "FIX_LINE"],
	["S-07", 3100, 4700, true, 2, [13, 8], 2800, "PASS", "FIX_RATE"],
	["S-08", 5100, 7100, true, null, [12, 12], 4901, "FIX_LINE", "FIX_GAP"],
];
const subtitleRecords = (cues) =>
	Object.fromEntries(
		cues.map(
			([
				id,
				startMs,
				endMs,
				referenceVerified,
				acceptedCueVersion,
				lineChars,
				priorEndMs,
			]) => [
				id,
				{
					startMs,
					endMs,
					referenceVerified,
					cueVersion: 3,
					acceptedCueVersion,
					lineChars,
					priorEndMs,
				},
			],
		),
	);
const subtitleDecisions = (cues) =>
	cues.map(([id, , , , , , , current]) => ({ id, current }));
const baseCues = subtitleCues.slice(0, 4);
const guideCues = subtitleCues.slice(4);
const clipEndMs = 10000;
const subtitleIntake = Object.fromEntries(
	Object.entries(subtitleRecords(baseCues)).map(([id, row]) => [
		id,
		{
			timeValid:
				row.startMs >= 0 && row.endMs > row.startMs && row.endMs <= clipEndMs,
			referenceVerified: row.referenceVerified,
			currentVersionApproved: row.acceptedCueVersion === row.cueVersion,
		},
	]),
);
const subtitleMeasurements = Object.fromEntries(
	Object.entries(subtitleRecords(guideCues)).map(([id, row]) => [
		id,
		{
			lineCount: row.lineChars.length,
			longestLine: Math.max(...row.lineChars),
			charsPerSecond:
				(row.lineChars.reduce((total, size) => total + size, 0) * 1000) /
				(row.endMs - row.startMs),
			gapMs: row.priorEndMs == null ? null : row.startMs - row.priorEndMs,
		},
	]),
);

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
	cache(
		"cache-handoff",
		true,
		rows(`
K-01 160 14 163 168 182 45 32 ja ja min-fresh=0 N SERVE
K-02 98 2 114 120 131 60 37 ja ja min-fresh=4 N SERVE
K-03 105 18 100 108 115 80 34 ja ja max-age=33 N VALIDATE
K-04 80 20 89 96 111 90 34 ja ja max-stale=8 N VALIDATE
K-05 80 20 89 96 111 90 33 ja ja max-stale=8 N SERVE
K-06 96 4 104 107 111 60 - ja en only-if-cached N GATEWAY
K-07 96 4 104 107 111 60 - ja en max-stale=9 N SERVE
K-08 96 4 104 107 111 60 - ja ja no-cache N FETCH`),
		rows(`
K-01 33 VALIDATE
K-02 33 SERVE
K-03 33 SERVE
K-04 42 SERVE
K-05 42 VALIDATE
K-06 15 GATEWAY
K-07 15 FETCH
K-08 15 VALIDATE`),
		true,
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
	makeCase("sqlite-rehearsal", {
		utterance:
			"移行リハーサルで、次の作業に渡す子テーブルcの残存行を確認してください。全トレースのID、終了時に見えるc.id、現行との比較を1つの表にしてください。c.idは数値昇順で+でつなぎ、空は-。比較欄は一致または要修正と記載してください。",
		document: {
			setup: sqliteSetup,
			records: Object.fromEntries(
				sqliteTraces.map(([id, , , statements]) => [id, { statements }]),
			),
			decisions: sqliteTraces.map(([id, current]) => ({ id, current })),
		},
		conditions: conditions([
			[
				"execution",
				"各トレースは新規のSQLite接続でsetupを完了してから独立に始める。statementsは1文ずつ実行し、エラー後も後続の文を同じ接続で実行する。試験ドライバによる暗黙のロールバックはしない。外部キー制約は有効。",
			],
			[
				"handoff",
				"最後の文の後に追加のCOMMITやROLLBACKをせず、その接続から見えるc.idを照会する。現行値はc.id一覧。エラーの有無は状態を推定する根拠で、引継ぎ表では残存行だけを比較する。",
			],
		]),
		expected: sqliteTraces.map(([id, current, value]) => [
			id,
			value,
			current === value ? "一致" : "要修正",
		]),
	}),
	makeCase("subtitle-handoff", {
		utterance:
			"上映用の差し替え字幕を制作担当へ引き継ぎます。添付は制作側の基礎確認と測定のログです。JP-4の閾値を確認できたら表の前に短く記録し、全候補のID、期待判定、現行との比較を1つの表にしてください。比較欄は一致または要修正。ガイドの根拠を確認できない候補は保留してください。",
		document: {
			guide: "字幕受入ガイドJP-4（制作チームの承認済み現行版）",
			intakeRecords: subtitleIntake,
			guideRecords: subtitleMeasurements,
			decisions: subtitleDecisions(baseCues),
			guideDecisions: subtitleDecisions(guideCues),
		},
		sourceFields: ["intakeRecords"],
		conditions: conditions([
			[
				"time",
				"intakeRecordsは基礎検査の確定記録。timeValidがfalseなら最優先でFIX_TIME。",
			],
			[
				"evidence",
				"時刻が正常でもreferenceVerifiedがfalseならHOLD_SOURCE。その後、currentVersionApprovedがtrueならPASS。",
			],
			[
				"guide",
				"decisionsは基礎確認候補の現行値。guideDecisionsは、時刻・原稿の検査を通過済みで、現在版が未承認の候補の現行値。後者は制作チームの字幕受入ガイドJP-4で判定し、対象版のルールが確認できなければHOLD_GUIDE。いずれの現行欄も判定根拠に使わない。",
			],
		]),
		expectedValues: [
			"PASS",
			"FIX_TIME",
			"HOLD_SOURCE",
			"HOLD_GUIDE",
			"FIX_LINE",
			"FIX_RATE",
			"FIX_GAP",
		],
		expected: subtitleCues.map(([id, , , , , , , current, value]) => [
			id,
			value,
			current === value ? "一致" : "要修正",
		]),
	}),
];

export const procedures = [
	{
		title: "共有キャッシュの現在齢・再利用判定・引継ぎ照合",
		body: "共有キャッシュの観測ログから再利用結果を再構成し、現行値と比較する。現在齢はRFC 9111 §4.2.3の保守的な計算で、Dateの見かけ齢と、Ageに応答待ち時間を加えた補正齢を比べ、受信後の滞留は最後に足す。根拠 https://www.rfc-editor.org/rfc/rfc9111.html#section-4.2.3",
		steps: [
			"現行欄を伏せ、各行に見かけ齢・応答待ち・補正初期齢・滞留・現在齢を仮記録する。練習例ではDate=90、要求=100、受信=104、Age=12、判定=110なので、max(14, 12+4)+6=22。見かけ齢に応答待ちを足さない。",
			"Vary、強制検証、共有キャッシュの鮮度、許可された期限切れの順に検討する。年齢と鮮度上限の等号は個別に照合する。",
			"現行欄に記録されている項目を再計算結果と比較し、すべてのIDが揃うことを確認する。",
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
	{
		title: "SQLite移行リハーサルのトランザクションと失敗文の照合",
		body: "SQLite移行の照合手順。各文の後に接続内の状態、未解決の外部キー、セーブポイント、エラー番号を別々に控える。現行表は最後の比較に使う。根拠 https://sqlite.org/foreignkeys.html#fk_deferred https://sqlite.org/lang_conflict.html https://sqlite.org/lang_savepoint.html",
		steps: [
			"遅延外部キー違反でCOMMITや最外のRELEASEが失敗しても接続のトランザクションは残る。入れ子のRELEASEはその検査をしない。ROLLBACK TOでは指定点の状態へ戻すが指定点は残る。",
			"UNIQUE競合ではABORTはその文の全変更だけを戻し、FAILはその文で競合より前の行を残す。ROLLBACKはトランザクション全体とセーブポイントを消す。IGNOREは競合行を飛ばしエラーを返さない。",
			"REPLACEで競合する既存親行が削除されるとON DELETE CASCADEも適用される。各文の前後を照合し、最後に見える行と失敗文の両方を引き継ぐ。",
		],
	},
	{
		title: "上映差し替え字幕の受入ガイドJP-4",
		body: "制作チーム承認済みの字幕受入ガイドJP-4。作品の時刻・原稿照合と現在版の承認条件を先に適用し、未承認の差し替え候補の検査を下の順で行う。台帳に測定済みの行数・最長行・毎秒文字数・空き時間が記録されている場合はその値を使う。",
		steps: [
			"行数は2行以下で、各行の文字数は14字以下。超えた場合はFIX_LINE。",
			"毎秒文字数は13以下を受け入れる。生データから求める場合は丸めず、合計文字数×1000と13×表示時間msを比べる。上限を超えればFIX_RATE。",
			"直前キューの終了が記録されている場合、無字幕の間隔は200ms以上必要。開始時刻から直前の終了時刻を引き、200ms未満はFIX_GAP。該当しなければPASS。複数違反は最初に該当した理由を使う。",
		],
	},
];
