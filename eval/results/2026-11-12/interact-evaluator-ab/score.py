import gzip
import itertools
import json
import re
import sys
import unicodedata
from pathlib import Path


def number(value):
    return int(re.sub(r"[^0-9]", "", value))


def venues(page):
    rooms = [line.split("｜") for line in page.splitlines()[2:]]
    common = [r for r in rooms if r[2:5] == ["可", "一般", "可"]]
    possible = []
    for morning, afternoon in itertools.permutations(common, 2):
        if int(morning[1]) < 30 or int(afternoon[1]) < 18:
            continue
        if morning[5] == "不可" or afternoon[6] == "不可":
            continue
        morning_cost = number(morning[7]) + (number(morning[5]) if "追加" in morning[5] else 0)
        afternoon_cost = number(afternoon[8]) + (number(afternoon[6]) if "追加" in afternoon[6] else 0)
        if morning_cost + afternoon_cost <= 13000:
            possible.append((morning_cost + afternoon_cost, morning[0], morning_cost, afternoon[0], afternoon_cost))
    return sorted(possible)


def shipments(page):
    services = [line.split("｜") for line in page.splitlines()[2:]]
    common = [r for r in services if r[5:7] == ["なし", "一般"]]
    possible = []
    for a, b in itertools.permutations(common, 2):
        if a[1] != "冷蔵" or b[1] != "常温" or number(a[2]) < 5 or number(b[2]) < 12:
            continue
        if a[3] < "10:30" or b[3] < "11:00" or a[4] > "15:30" or b[4] > "17:00":
            continue
        if number(a[7]) + number(b[7]) <= 1650:
            possible.append((a[4], b[4], number(a[7]) + number(b[7]), a[0], number(a[7]), b[0], number(b[7])))
    return sorted(possible)


def normalized(text):
    return unicodedata.normalize("NFKC", text or "").replace(",", "")


def score(task, text):
    text = normalized(text)
    if task == "venues":
        fields = [r"\bAster\b", r"(?<!\d)8000\s*円", r"\bReed\b", r"(?<!\d)4800\s*円", r"(?<!\d)12800\s*円"]
        conflicting = r"\b(?:Cedar|Juniper|Maple|Willow|Rose|Pine)\b"
    else:
        fields = [r"\bC15\b", r"(?<!\d)15:00", r"(?<!\d)900\s*円", r"\bN17\b", r"(?<!\d)16:40", r"(?<!\d)700\s*円", r"(?<!\d)1600\s*円"]
        conflicting = r"\b(?:C13|C16|C09|C11|C12|N15|N16|N18)\b"
    ordered = bool(re.search(".*?".join(fields), text, re.DOTALL))
    return {
        "valuesPresent": sum(bool(re.search(f, text)) for f in fields),
        "valuesExpected": len(fields),
        "correctValuesAndOrder": ordered and not re.search(conflicting, text),
    }


def summarize(row):
    final = row.get("final") or {}
    work = final.get("work") or {}
    current = work.get("current") or {}
    child = current.get("child") or {}
    messages = {m["id"]: m.get("text") for m in row["messages"]}
    notices = []
    review_notices = []
    for n in final.get("notices", []):
        event = json.loads(n["event_json"])
        if event.get("kind") == "review":
            review_notices.append({"event": event, "delivered": bool(n["answer_message_id"]), "answer": messages.get(n["answer_message_id"])})
        elif event["status"] == "completed" and n["answer_message_id"]:
            notices.append(messages.get(n["answer_message_id"]))
    tools = final.get("tools", [])
    requests = [u for u in row["usage"] if isinstance(u.get("value"), dict) and u["value"].get("tool") == "collaboration.interact.review"]
    assert row["exposedTools"], row["id"]
    assert all(("collaboration.interact.review" in t) == (row["mode"] == "quick-available") for t in row["exposedTools"])
    assert row["mode"] != "quick-unavailable" or not row["reviews"]
    return {
        "task": row["id"], "mode": row["mode"], "repetition": row["repetition"],
        "elapsedMs": row["elapsedMs"],
        "modelCalls": len(row["usage"]),
        "inputTokens": sum(u.get("input") or 0 for u in row["usage"]),
        "outputTokens": sum(u.get("output") or 0 for u in row["usage"]),
        "toolchainRevision": (final.get("session") or {}).get("toolchainRevisionId"),
        "turnStatuses": [[t["phase"], t.get("status"), t.get("error")] for t in row["turns"]],
        "reviewActionChoices": len(requests),
        "reviewRequestsAccepted": sum(t["tool"] == "collaboration.interact.review" and t["ok"] for t in tools),
        "quickStarts": len(row["reviews"]),
        "reviewNotices": review_notices,
        "draft": work.get("document"),
        "childStatus": child.get("status"), "childResult": child.get("summary"),
        "childScore": score(row["id"], child.get("summary")),
        "notices": notices,
        "noticeScore": score(row["id"], "\n".join(n for n in notices if n)),
        "error": row.get("error"),
    }


def main():
    path = Path(sys.argv[1])
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as f:
        records = [json.loads(line) for line in f]
    config = records[0]
    pages = {r["id"]: r["page"] for r in config["cases"]}
    combinations = {case: fn(pages[case]) for case, fn in [("venues", venues), ("shipments", shipments)]}
    assert combinations["venues"][0] == (12800, "Aster", 8000, "Reed", 4800)
    assert combinations["shipments"][0] == ("15:00", "16:40", 1600, "C15", 900, "N17", 700)
    trials = [summarize(r) for r in records if "id" in r]
    result = {"complete": records[-1].get("kind") == "end", "goldCombinationsInPreferenceOrder": combinations, "trials": trials}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
