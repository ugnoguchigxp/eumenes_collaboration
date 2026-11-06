/**
 * Environment handed to child processes (pack-check, verify-clean-copy). An allowlist, not `process.env`:
 * a child must not see API keys or tokens of the parent shell.
 */
const allowedNames: ReadonlySet<string> = new Set([
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TERM",
	"TZ",
	"CI",
	"GITHUB_ACTIONS",
	"BUN_INSTALL",
	// Used by pack-check itself (host checkout and baseline policy).
	"EUMENES_SOURCE",
	"EUMENES_BASELINE_COMMIT",
	"PACK_CHECK_REQUIRE_HOST",
]);
/** Credential-looking names are dropped even when they appear in the allowlist. */
const secretSuffix = /(_API_KEY|_TOKEN|_SECRET)$/i;

export function childEnv(
	source: Record<string, string | undefined>,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (!allowedNames.has(name) || secretSuffix.test(name)) continue;
		env[name] = value;
	}
	// Fixed so that date-dependent output does not vary with the caller's zone.
	env.TZ = "Asia/Tokyo";
	return env;
}
