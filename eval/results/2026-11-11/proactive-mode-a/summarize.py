"""Re-aggregate the synthetic mode A archive without contacting a provider."""

import gzip
import hashlib
import json
import math
import statistics
import sys
from collections import Counter
from pathlib import Path


directory = Path(__file__).resolve().parent
registration = json.loads((directory / "registration.json").read_text())
inventory = directory.parents[2] / "proactive" / "holdout.json"
inventory_bytes = inventory.read_bytes()
if hashlib.sha256(inventory_bytes).hexdigest() != registration["holdoutSha256"]:
    raise ValueError("holdout hash mismatch")
groups = {task["id"]: task["group"] for task in json.loads(inventory_bytes)}
path = Path(sys.argv[1]) if len(sys.argv) > 1 else directory / "mode-a-holdout.jsonl.gz"
raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
records = [json.loads(line) for line in raw.splitlines()]
config, *cases, end = records
if config["kind"] != "configuration" or end["kind"] != "end":
    raise ValueError("incomplete archive")
if (config["model"], config["planned"], config["maxCloudCalls"]) != (
    registration["model"], registration["plannedCases"], registration["maxModelCalls"]
):
    raise ValueError("configuration mismatch")
expected = {(task, rep) for task in groups for rep in range(1, registration["repetitions"] + 1)}
observed = {(case["taskId"], case["repetition"]) for case in cases}
if len(cases) != len(observed) or observed - expected:
    raise ValueError("invalid case keys")


def summarize(rows):
    counts = Counter()
    timings = []
    for row in rows:
        counts["recorded"] += 1
        turns = row["turns"]
        timings.extend(turn["elapsedMs"] for turn in turns)
        if len(turns) >= 2 and all(turn["status"] == "completed" for turn in turns):
            counts["completed"] += 1
            if all(turn.get("work") and turn.get("state") for turn in turns[:2]):
                counts["bothCheckpointsAvailable"] += 1
            if row.get("assessment"):
                counts["assessed"] += 1
                verdict = row["assessment"]
                counts["conditionsMet"] += verdict["final"]["conditionsMet"]
                counts["noFollowUpAndConditionsMet"] += bool(
                    verdict["final"]["conditionsMet"] and not verdict["followUps"]
                )
                counts["followUps"] += verdict["followUps"]
                counts["rework"] += verdict["final"]["rework"]
                counts["unnecessaryProposals"] += verdict["final"]["unnecessaryProposals"]
        counts["recordedErrors"] += bool(row.get("error"))
        counts["stateCheckpoints"] += sum(bool(turn.get("state")) for turn in turns)
        counts["turns"] += len(turns)
    timings.sort()
    fields = (
        "recorded", "completed", "bothCheckpointsAvailable", "assessed", "conditionsMet",
        "noFollowUpAndConditionsMet", "followUps", "rework", "unnecessaryProposals",
        "recordedErrors", "stateCheckpoints", "turns",
    )
    return {
        **{field: counts[field] for field in fields},
        "foregroundMedianMs": statistics.median(timings) if timings else None,
        "foregroundP95Ms": timings[math.ceil(len(timings) * 0.95) - 1] if timings else None,
    }


def passes_primary(row):
    verdict = row.get("assessment")
    return bool(
        verdict
        and len(row["turns"]) >= 2
        and all(turn["status"] == "completed" for turn in row["turns"])
        and verdict["final"]["conditionsMet"]
        and not verdict["followUps"]
    )


by_key = {(row["taskId"], row["repetition"]): row for row in cases}
pairs = [
    (by_key[(task, 1)], by_key[(task, 2)])
    for task in groups
    if (task, 1) in by_key and (task, 2) in by_key
]
usage = [call for row in cases for call in row["usage"]]
missing_usage = end["calls"] - len(usage)
timed_out_turns = [
    {"taskId": row["taskId"], "repetition": row["repetition"], "runId": turn["runId"]}
    for row in cases for turn in row["turns"]
    if turn["status"] in ("queued", "running", "timeout")
]
if not 0 <= missing_usage <= len(timed_out_turns):
    raise ValueError("unexplained missing usage records")
reported_costs = [call["costUsd"] for call in usage if call.get("costUsd") is not None]
report = {
    "mode": "A",
    "status": "complete" if observed == expected else "partial",
    "missingCases": sorted(expected - observed),
    "providerStop": end["providerFailure"],
    "model": config["model"],
    "modelUsageLabels": sorted({call["model"] for call in usage if call.get("model")}),
    "modelCalls": end["calls"],
    "maxModelCalls": config["maxCloudCalls"],
    "additionalApiKeyBudgetUsd": config["extraApiUsd"],
    "reportedApiCostUsd": sum(reported_costs) if reported_costs else None,
    "inputTokens": sum(call.get("input") or 0 for call in usage),
    "outputTokens": sum(call.get("output") or 0 for call in usage),
    "recordedUsageRows": len(usage),
    "usageRowsMissingAfterTimeout": missing_usage,
    "timedOutTurns": timed_out_turns,
    "rawSha256": hashlib.sha256(raw).hexdigest(),
    "pairedTasks": len(pairs),
    "pairsWithDifferentPrimaryOutcome": sum(passes_primary(a) != passes_primary(b) for a, b in pairs),
    "provisionalModelJudgment": summarize(cases),
    "byGroup": {
        group: summarize([row for row in cases if groups[row["taskId"]] == group])
        for group in sorted(set(groups.values()))
    },
}
print(json.dumps(report, ensure_ascii=False, indent=2))
