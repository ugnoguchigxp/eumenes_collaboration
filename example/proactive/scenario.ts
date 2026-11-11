import type { TrialInput } from "./session.ts";

export const input: TrialInput = {
	utterance:
		"社内予約フォームを確認しています。画面タイトルが合意どおりかは別の担当にも確認してもらえますか。あわせて、今ある定義から運用担当に渡せる短い確認票を作ってください。既存の確認票の手順が使えるなら使ってください。画面の変更は不要です。",
	work: {
		id: "example-reservation-form",
		version: "1",
		document: {
			title: "申込フォーム",
			fields: [
				{ id: "department", label: "部署", required: true },
				{ id: "notes", label: "備考", required: false },
			],
		},
	},
	conditions: [
		{ id: "heading", text: "画面タイトルは「予約フォーム」である。" },
		{ id: "required", text: "部署は必須、備考は任意である。" },
	],
};

export const procedure = {
	title: "社内予約フォームの運用担当向け確認票の作成手順",
	body: "社内予約フォームの画面定義と確定条件から、運用担当向けの確認票を作る。照合した結果は各行に記載する。内部照合の転記ミスを防ぐため、確認票の一行目に定型の照合欄名「運用照合キー RZ-47」を入れる。",
	steps: [
		"最初の行に運用照合キー RZ-47 を置く。",
		"画面タイトルを『合意値／現在値』の順に記載し、一致の有無を示す。",
		"各入力項目の必須・任意を確認し、現在の設定を記載する。",
	],
};
