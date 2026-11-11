const rows = (text) =>
	text
		.trim()
		.split("\n")
		.map((line) => line.trim().split(" "));
const decisions = (text) =>
	rows(text).map(([id, current]) => ({ id, current }));

const named = (text, names) =>
	rows(text).map((values) =>
		Object.fromEntries(names.map((name, index) => [name, values[index]])),
	);

function notificationRecords(orderLog, deliveryLog) {
	const events = named(orderLog, [
		"order",
		"id",
		"effective",
		"received",
		"kind",
	]);
	const deliveries = named(deliveryLog, [
		"order",
		"id",
		"effective",
		"received",
		"cancellation",
		"attempt",
		"result",
	]);
	return Object.fromEntries(
		[...new Set(events.map(({ order }) => order))].sort().map((order) => [
			order,
			{
				orderEvents: events
					.filter((row) => row.order === order)
					.sort(
						(a, b) =>
							a.effective.localeCompare(b.effective) ||
							a.id.localeCompare(b.id),
					),
				deliveryAttempts: deliveries
					.filter((row) => row.order === order)
					.sort(
						(a, b) =>
							a.effective.localeCompare(b.effective) ||
							a.id.localeCompare(b.id),
					),
			},
		]),
	);
}

function releaseRecords(packages, approvalLog, waiverLog) {
	const approvals = named(approvalLog, [
		"id",
		"version",
		"kind",
		"effective",
		"received",
		"status",
	]);
	const waivers = named(waiverLog, [
		"id",
		"version",
		"audience",
		"start",
		"end",
		"received",
	]);
	return Object.fromEntries(
		named(packages, ["id", "version", "audience", "embargoAt", "dependencies"])
			.sort((a, b) => a.id.localeCompare(b.id))
			.map(({ id, version, audience, embargoAt, dependencies }) => [
				id,
				{
					version,
					audience,
					embargoAt,
					dependencies: dependencies === "-" ? [] : dependencies.split(","),
					approvals: approvals.filter((row) => row.version[0] === version[0]),
					waivers: waivers.filter((row) => row.version[0] === version[0]),
				},
			]),
	);
}

const trial = ({
	id,
	title,
	utterance,
	document,
	conditions,
	expected,
	skill,
}) => ({
	id,
	title,
	input: {
		utterance,
		work: { id, version: "1", document },
		conditions: conditions.map(([id, text]) => ({ id, text })),
	},
	expected: rows(expected),
	useful: { review: true, skill },
});

export const cases = [
	trial({
		id: "hard-02",
		title: "取消通知の再送監査",
		utterance:
			"12:00時点の取消通知キューを受入担当に渡します。各注文の現行判定と再計算した判定を照合できるよう、注文ID、期待判定、有効な取消イベントID、決め手ID、現行との一致・要修正をこの順の表にしてください。期待判定には確定条件のコードを使い、該当イベントがなければ - と書いてください。",
		document: {
			asOf: "11月13日12:00。以下の時刻は同日のJST。",
			records: notificationRecords(
				`
C-14 n141 11:34 11:36 CANCEL
C-17 n174 11:58 11:58 OPT_OUT
C-11 n111 11:24 11:25 CANCEL
C-18 n185 11:51 12:01 UNSHIP
C-13 n133 11:50 11:58 OPT_OUT
C-16 n162 11:48 11:49 RESTORE
C-12 n121 11:30 11:33 CANCEL
C-11 n113 11:41 11:45 CANCEL
C-18 n182 11:42 11:43 RESTORE
C-18 n183 11:42 11:44 CANCEL
C-15 n151 11:22 11:30 CANCEL
C-14 n142 11:53 11:54 SHIP
C-11 n114 11:50 12:01 OPT_OUT
C-17 n171 11:42 11:43 CANCEL
C-16 n161 11:43 11:44 CANCEL
C-15 n152 12:02 11:59 OPT_OUT
C-18 n181 11:42 11:44 CANCEL
C-16 n163 11:52 12:02 CANCEL
C-13 n132 11:52 11:55 SHIP
C-11 n112 11:36 11:37 RESTORE
C-18 n184 11:51 11:52 SHIP
C-13 n131 11:49 11:50 CANCEL`,
				`
C-17 r174 11:59 12:02 n171 x172 FAILED
C-18 r181 11:50 11:51 n181 x181 ACCEPTED
C-11 r111 11:28 11:29 n111 x111 ACCEPTED
C-17 r171 11:49 11:50 n171 x171 ACCEPTED
C-16 r161 11:45 11:46 n161 x161 ACCEPTED
C-17 r173 11:57 11:58 n171 x172 ACCEPTED
C-17 r172 11:55 11:56 n171 x171 FAILED`,
			),
			decisions: decisions(`
C-11 SENT
C-12 SEND
C-13 SHIPPED
C-14 SHIPPED
C-15 SEND
C-16 SENT
C-17 OPT_OUT
C-18 SENT`),
		},
		conditions: [
			[
				"cutoff",
				"発効・受領がどちらも基準時刻以下の行だけを使う。注文履歴を発効時刻、同時ならイベントID昇順で適用。初期状態は取消なし、未発送、通知辞退なし。CANCELで有効な取消IDを更新しRESTOREで消す。SHIP/UNSHIP、OPT_OUT/OPT_INはそれぞれ独立した状態を更新する。",
			],
			[
				"receipt",
				"配信履歴は有効な取消IDに紐づく行だけを対象に、同じ試行IDの最終行（発効時刻、同時ならログID昇順の最後）がACCEPTEDなら受理済みとする。複数なら発効時刻の最も新しい受理ログを根拠にする。",
			],
			[
				"priority",
				"上から先に当てはまる判定を採る。NO_CANCEL（決め手は最新のRESTORE、なければ -）、SENT（有効な受理ログID）、OPT_OUT（辞退イベントID）、SHIPPED（発送イベントID）、EXPIRED（取消から30分超、取消ID）、SEND（残り、取消ID）。30分ちょうどは期限内。現行コードとの差を判定する。",
			],
		],
		expected: `
C-11 SEND n113 n113 要修正
C-12 SEND n121 n121 一致
C-13 OPT_OUT n131 n133 要修正
C-14 SHIPPED n141 n142 一致
C-15 EXPIRED n151 n151 要修正
C-16 NO_CANCEL - n162 要修正
C-17 SENT n171 r173 要修正
C-18 SHIPPED n183 n184 要修正`,
		skill: false,
	}),
	trial({
		id: "hard-04",
		title: "欠品対応の引当再計算",
		utterance:
			"次シフトのために、10:00の在庫で全依頼を引き当て直し、現行の引当結果を照合した表を作ってください。列は依頼ID、期待する処理順（1～8）、期待判定（ALLOCATEまたはHOLD）、確定ロット内訳（A1=2+A3=1の形、HOLDは -）、不足数、現行との一致・要修正。表の後に未引当の理由と残数も短く残してください。",
		document: {
			asOf: "11月13日10:00。時刻はJST、期限は11月の日を整数で表す。",
			records: {
				stock: named(
					`
A4 W M 7 17 OPEN
A2 E M 6 16 HOLD
B1 E N 5 15 OPEN
A0 E M 5 11 OPEN
A5 E M 3 16 OPEN
A3 W M 5 13 OPEN
B2 W N 4 18 OPEN
A1 E M 4 14 OPEN`,
					["lot", "site", "product", "quantity", "expiryDay", "initialState"],
				),
				adjustments: named(
					`
m01 A1 09:47 09:49 -1
m02 A2 09:58 10:01 OPEN
m03 B2 10:02 09:59 HOLD`,
					["id", "lot", "effective", "received", "change"],
				),
				requests: named(
					`
S-02 W 6 13 N N 0 09:15
S-03 E 8 14 Y N 0 09:20
S-01 E 4 11 Y N 0 09:23
S-04 W 7 16 Y Y 1 09:01
S-05 E 8 14 Y Y 1 09:05
S-06 E 6 13 N Y 1 09:05
S-07 W 5 15 Y Y 2 09:00
S-08 E 4 15 N Y 2 09:00`,
					[
						"id",
						"site",
						"quantity",
						"minimumExpiryDay",
						"allowTransfer",
						"allowSubstitution",
						"priority",
						"received",
					],
				).map(({ allowTransfer, allowSubstitution, ...request }) => ({
					...request,
					allowTransfer: allowTransfer === "Y",
					allowSubstitution: allowSubstitution === "Y",
				})),
			},
			decisions: decisions(`
S-01 ALLOCATE:A0=4
S-02 ALLOCATE:A3=5+A4=1
S-03 ALLOCATE:A1=4+A5=3+A4=1
S-04 ALLOCATE:A4=5+B2=2
S-05 HOLD:2
S-06 HOLD:1
S-07 ALLOCATE:B2=1+B1=4
S-08 HOLD:4`),
		},
		conditions: [
			[
				"inventory",
				"発効・受領とも基準時刻以下の訂正だけを反映。OPENのロットを使う。全依頼の希望品はM、Nは許可がある依頼だけの代替。最低期限は含む。他拠点の在庫には輸送分として最低期限に1日を加える。",
			],
			[
				"priority",
				"依頼の優先度、受付時刻、IDの順に昇順で処理する。各依頼でM自拠点、M他拠点、N自拠点、N他拠点の順で引当し、各区分は期限、ロットIDの昇順。許可されていない区分は飛ばす。",
			],
			[
				"atomic",
				"全数を確保できればALLOCATEとしてそのロットを在庫から引く。不足時はHOLDとし、不足数は必要数から仮引当可能な数量を引いた値。仮引当を全量戻して次へ進む。ALLOCATEの不足数は0。現行は記録された判定と内訳または不足数で比較する。",
			],
		],
		expected: `
S-01 3 ALLOCATE A0=4 0 一致
S-02 1 ALLOCATE A3=5+A4=1 0 一致
S-03 2 ALLOCATE A1=3+A5=3+A4=2 0 要修正
S-04 4 ALLOCATE A4=4+B2=3 0 要修正
S-05 5 HOLD - 2 一致
S-06 6 HOLD - 1 一致
S-07 7 HOLD - 4 要修正
S-08 8 ALLOCATE B1=4 0 要修正`,
		skill: true,
	}),
	trial({
		id: "hard-05",
		title: "公開承認の版と依存関係の照合",
		utterance:
			"公開当番が基準時刻の判断を引き継げるよう、パッケージID、期待判定、根拠ID、現行との一致・要修正をこの順の表にしてください。根拠IDは確定条件にある記法を使い、停止の連鎖も確認できるようにしてください。公開作業は不要です。",
		document: {
			asOf: "2026-11-13 12:00 JST（UTC 03:00）。承認・免除ログの時刻は同日のJST。",
			records: releaseRecords(
				`
P-07 G2 PARTNER 2026-11-13T12:30+09:00 P-06,P-01
P-01 A2 PUBLIC 2026-11-13T01:00Z -
P-04 D1 PARTNER 2026-11-13T03:30Z -
P-02 B2 PARTNER 2026-11-13T02:00Z -
P-08 H1 PUBLIC 2026-11-13T03:01Z P-03,P-01
P-05 E1 PARTNER 2026-11-13T13:00+09:00 P-03
P-03 C1 PUBLIC 2026-11-12T22:00-05:00 -
P-06 F1 PUBLIC 2026-11-13T02:20Z P-05,P-04`,
				`
e53 E1 PARTNER 11:55 12:03 REVOKE
a11 A1 CONTENT 10:30 10:35 GRANT
a12 A2 CONTENT 11:30 11:35 GRANT
a13 A2 CONTENT 11:50 11:52 REVOKE
a14 A2 PUBLIC 11:37 11:38 GRANT
a15 A2 CONTENT 11:55 12:01 GRANT
b21 B2 CONTENT 11:01 11:03 GRANT
b22 B1 PARTNER 11:11 11:15 GRANT
b23 B2 PUBLIC 11:25 11:28 GRANT
c31 C1 CONTENT 11:24 11:28 GRANT
c32 C1 PUBLIC 11:32 11:36 GRANT
d41 D1 CONTENT 11:40 11:41 GRANT
d42 D1 PARTNER 11:44 11:46 GRANT
e51 E1 CONTENT 11:15 11:19 GRANT
e52 E1 PARTNER 11:20 11:24 GRANT
f61 F1 CONTENT 11:10 11:11 GRANT
f62 F1 PUBLIC 11:15 11:16 GRANT
g71 G2 CONTENT 11:08 11:09 GRANT
g72 G2 PARTNER 11:13 11:14 GRANT
h81 H1 CONTENT 11:25 11:26 GRANT
h82 H1 PUBLIC 11:33 11:34 GRANT`,
				`
w41 D1 PARTNER 11:20 12:00 11:18
w42 D2 PARTNER 11:40 12:20 11:39
w51 E1 PARTNER 11:45 12:20 11:44
w71 G1 PARTNER 11:20 12:20 11:21
w72 G2 PARTNER 12:00 12:10 11:50
w81 H1 PARTNER 11:40 12:20 11:41`,
			),
			decisions: decisions(`
P-01 READY
P-02 SCOPE
P-03 EMBARGO
P-04 READY
P-05 SCOPE
P-06 DEP
P-07 EMBARGO
P-08 EMBARGO`),
		},
		conditions: [
			[
				"approval",
				"版と種別が一致する承認のみ使う。CONTENTと対象に対応するPUBLIC/PARTNERを別々に確認。発効・受領とも基準時刻以下のうち最新（発効、同時ならログIDの順）がGRANTなら有効。停止の優先順はCONTENT、SCOPE、EMBARGO、DEP。CONTENT/SCOPEの根拠は該当する最新ログID、該当ログがなければ -。",
			],
			[
				"embargo",
				"同じ瞬間なら解禁済み。PARTNERに限り、版と対象が一致し基準時刻までに受領、有効開始以上・有効終了未満の免除で解禁を早められる。EMBARGOの根拠はそのパッケージ自身のID。",
			],
			[
				"dependency",
				"自身の条件をすべて満たした後、指定順に依存パッケージを、そのパッケージの対象と版に対して同じ条件で確認する。最初の非READYでDEP。根拠は最初の非READYのIDから始め、DEPが連鎖する限り > で末端までつなぐ。依存も全部通ればREADY。READYの根拠は有効な内容ログID+対象ログID、解禁免除を使用した場合はさらに+免除ID。現行コードとの差を判定する。",
			],
		],
		expected: `
P-01 CONTENT a13 要修正
P-02 SCOPE - 一致
P-03 READY c31+c32 要修正
P-04 EMBARGO P-04 要修正
P-05 READY e51+e52+w51 要修正
P-06 DEP P-04 一致
P-07 DEP P-06>P-04 要修正
P-08 EMBARGO P-08 一致`,
		skill: true,
	}),
];

export const procedures = [
	{
		title: "欠品対応の在庫引当照合とシフト引継ぎ票",
		body: "在庫を次の担当に引き継ぐ際の照合手順。基準時刻で元帳を締め、当日有効な訂正だけを反映する。現行の引当結果は後で比較するために別に置き、再計算の入力にしない。",
		steps: [
			"依頼を指定の順に並べ、ロット残数と期限を控える。",
			"各依頼に対し使用可能なロットを区分ごとに仮確保し、全量確保できた時点で残数に反映する。引当できなかった依頼の仮確保は次の依頼の前に戻す。",
			"期待結果と現行の差を行ごとに照合する。最後に引当総量と残数を突き合わせる。",
		],
	},
	{
		title: "版・解禁・依存を含む公開承認の担当交代引継ぎ",
		body: "資料の版と公開対象を固定し、基準時刻に確認できる情報を使って公開判断の引継ぎを作る。現在の判断欄は比較用として扱う。",
		steps: [
			"承認、解禁、依存の順に根拠を分けて控え、資料の版・対象・時刻をそれぞれ確かめる。",
			"自分の条件を満たす依存先から順に判断を確定し、停止が伝播する場合は担当者がたどれるよう途中と末端のIDを書く。",
			"すべての行を揃えた後、現行との違いと根拠IDが行内で対応しているか確かめる。",
		],
	},
];
