import { expect, test } from "bun:test";
import { childEnv } from "../scripts/child-env.ts";

test("allowlisted variables pass through and TZ is pinned", () => {
	const env = childEnv({
		PATH: "/usr/bin",
		HOME: "/home/u",
		TMPDIR: "/tmp",
		LANG: "ja_JP.UTF-8",
		LC_ALL: "C",
		TERM: "xterm",
		CI: "1",
		GITHUB_ACTIONS: "true",
		BUN_INSTALL: "/b",
		EUMENES_SOURCE: "/src",
		EUMENES_BASELINE_COMMIT: "HEAD",
		PACK_CHECK_REQUIRE_HOST: "1",
		TZ: "UTC",
	});
	expect(env).toEqual({
		PATH: "/usr/bin",
		HOME: "/home/u",
		TMPDIR: "/tmp",
		LANG: "ja_JP.UTF-8",
		LC_ALL: "C",
		TERM: "xterm",
		CI: "1",
		GITHUB_ACTIONS: "true",
		BUN_INSTALL: "/b",
		EUMENES_SOURCE: "/src",
		EUMENES_BASELINE_COMMIT: "HEAD",
		PACK_CHECK_REQUIRE_HOST: "1",
		TZ: "Asia/Tokyo",
	});
});

test("TZ is Asia/Tokyo even when the source has none", () => {
	expect(childEnv({}).TZ).toBe("Asia/Tokyo");
});

test("variables outside the allowlist are dropped", () => {
	const env = childEnv({
		PATH: "/usr/bin",
		SHELL: "/bin/zsh",
		USER: "u",
		AWS_REGION: "x",
		NODE_OPTIONS: "--x",
	});
	expect(Object.keys(env).sort()).toEqual(["PATH", "TZ"]);
});

test("names ending in _API_KEY, _TOKEN or _SECRET are dropped", () => {
	const env = childEnv({
		PATH: "/usr/bin",
		ANTHROPIC_API_KEY: "k",
		GITHUB_TOKEN: "t",
		CLIENT_SECRET: "s",
		openai_api_key: "k",
	});
	expect(Object.keys(env).sort()).toEqual(["PATH", "TZ"]);
});

test("names that merely resemble allowlisted ones are dropped", () => {
	expect(childEnv({ BUN_INSTALL: "/b" }).BUN_INSTALL).toBe("/b");
	expect(
		childEnv({ BUN_INSTALL_TOKEN: "t" }).BUN_INSTALL_TOKEN,
	).toBeUndefined();
	expect(childEnv({ HOME_DIR: "/h" }).HOME_DIR).toBeUndefined();
});

test("undefined values are omitted", () => {
	expect(childEnv({ PATH: undefined })).toEqual({ TZ: "Asia/Tokyo" });
});
