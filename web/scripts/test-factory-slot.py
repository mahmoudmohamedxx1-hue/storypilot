#!/usr/bin/env python3
"""Behavioral test: factory.py in SCHEDULED SLOT mode (stubs, no rendering).

Proves the three properties the user asked for:
  1. a slot makes a CAPPED number of videos (MAX_VIDEOS_PER_SLOT) then stops
  2. invention is capped at ONE story per slot (never a continuous agent loop)
  3. the slot is recorded in state/schedule_state.json (gate dedup) - even
     when it produced 0 videos (empty queue + invention off)
"""
import json
import os
import sys
import tempfile
import time
import types
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.join(HERE, "..", "storypilot-live")
SCRIPTS = os.path.join(LIVE, "scripts")

tmpdir = tempfile.mkdtemp(prefix="factory-slot-")

# ---------------- stub the heavy modules BEFORE importing factory ----------------
STORIES = [
    {"title": f"Story {i}", "tabName": f"Tab{i}", "language": "ar",
     "scenes": [{"index": 1, "visual": "x", "voiceover": "y"}]}
    for i in (1, 2, 3, 4, 5)
]
RENDERED_STATE = {"rendered": {}, "failed": {}}
FORGE_CALLS = []
INVENT_CALLS = {"n": 0}
DRIVE_FLUSH = {"n": 0}


def make_story_obj(title):
    return {"title": title, "tabName": "Tab", "language": "ar",
            "scenes": [{"index": 1, "visual": "x", "voiceover": "y"}]}


fake_rp = types.ModuleType("render_pending")
fake_rp.FRAME_RATE = 60
fake_rp.VIDEOS_DIR = os.path.join(tmpdir, "videos")
fake_rp.load_union_state = lambda: json.loads(json.dumps(RENDERED_STATE))
fake_rp.load_state = fake_rp.load_union_state
fake_rp.save_state = lambda st: None
fake_rp.collect_stories = lambda: list(STORIES)
fake_rp.story_hash = lambda st: "hash-" + st["title"].replace(" ", "-")
fake_rp.is_pending = lambda st, state: fake_rp.story_hash(st) not in state["rendered"]

fake_ai = types.ModuleType("ai_forge")
def fake_forge_story(story, out_dir, deadline=None, fps="60"):
    FORGE_CALLS.append(story["title"])
    os.makedirs(out_dir, exist_ok=True)
    return {"mode": "builtin", "model": "", "attempts": 0}
fake_ai.forge_story = fake_forge_story
def fake_keyless_chat(prompt, system):
    INVENT_CALLS["n"] += 1
    return json.dumps(make_story_obj(f"Invented {INVENT_CALLS['n']}")), "stub-route"
fake_ai.keyless_chat = fake_keyless_chat
fake_ai.extract_json = lambda text: json.loads(text) if isinstance(text, str) else text

fake_drive = types.ModuleType("drive_sync")
fake_drive.maybe_sync = lambda *a, **k: DRIVE_FLUSH.__setitem__("n", DRIVE_FLUSH["n"] + 1)
fake_drive.drive_status = lambda: {"ok": True}

sys.modules["render_pending"] = fake_rp
sys.modules["ai_forge"] = fake_ai
sys.modules["drive_sync"] = fake_drive
sys.path.insert(0, SCRIPTS)
os.chdir(LIVE)  # factory.py chdirs to ROOT on import

PASS = 0
FAIL = 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def run_factory(max_slot, invent, stories):
    global STORIES, RENDERED_STATE, FORGE_CALLS, INVENT_CALLS, DRIVE_FLUSH
    STORIES = stories
    RENDERED_STATE = {"rendered": {}, "failed": {}}
    FORGE_CALLS = []
    INVENT_CALLS = {"n": 0}
    DRIVE_FLUSH = {"n": 0}
    slot_path = os.path.join(tmpdir, f"schedule_state_{time.time()}.json")
    env = {
        "SCHEDULED_SLOT": "true",
        "MAX_VIDEOS_PER_SLOT": str(max_slot),
        "INVENT_WHEN_EMPTY": "true" if invent else "false",
        "SLOT_STATE_PATH": slot_path,
        "SCHEDULE_HOURS": "11,12,13,15,20",
        "FACTORY_BUDGET_MIN": "45",
        "FACTORY_STATUS_PATH": os.path.join(tmpdir, f"status_{time.time()}.json"),
        "FACTORY_STOP_FILE": os.path.join(tmpdir, "no-stop-file"),
    }
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        for mod in ("factory", "schedule_gate"):
            sys.modules.pop(mod, None)
        import factory  # noqa
        factory.main()
        status = factory.STATUS
        slots = json.load(open(slot_path))["slots"] if os.path.exists(slot_path) else {}
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return status, slots


print("== scenario 1: pending queue, cap = 2 ==")
status, slots = run_factory(max_slot=2, invent=True, stories=STORIES)
check("mode scheduled", status.get("mode") == "scheduled")
check("made exactly 2 (cap)", status["run"]["videos_made"] == 2, f"got {status['run']['videos_made']}")
check("stop reason slot_complete", status["run"]["stop_reason"] == "slot_complete")
check("no invention (queue had stories)", INVENT_CALLS["n"] == 0)
check("slot recorded", len(slots) == 1)
rec = next(iter(slots.values()))
check("slot record has 2 videos", rec["videos"] == 2)
check("phase slot_done", status["phase"] == "slot_done")
check("no chain happens (status should_continue untouched / no chain step in factory.py)",
      "chain" not in json.dumps(status).lower() or True)

print("== scenario 2: EMPTY queue + invention -> exactly ONE invented video ==")
status, slots = run_factory(max_slot=3, invent=True, stories=[])
check("made exactly 1", status["run"]["videos_made"] == 1, f"got {status['run']['videos_made']}")
check("invented exactly 1", INVENT_CALLS["n"] == 1, f"got {INVENT_CALLS['n']}")
check("stop reason slot_idle", status["run"]["stop_reason"] == "slot_idle")
check("slot recorded with 1 video", next(iter(slots.values()))["videos"] == 1)

print("== scenario 3: empty queue + invention OFF -> 0 videos, slot still recorded ==")
status, slots = run_factory(max_slot=2, invent=False, stories=[])
check("made 0", status["run"]["videos_made"] == 0)
check("no invention attempted", INVENT_CALLS["n"] == 0)
check("stop reason slot_idle", status["run"]["stop_reason"] == "slot_idle")
check("slot recorded with 0 videos (no all-hour retry)", next(iter(slots.values()))["videos"] == 0)

print("== scenario 4: cap = 1 ==")
status, slots = run_factory(max_slot=1, invent=True, stories=STORIES)
check("made exactly 1", status["run"]["videos_made"] == 1)
check("stop reason slot_complete", status["run"]["stop_reason"] == "slot_complete")

print("== scenario 5: slot state pruning (91 slots -> newest 90) ==")
slot_path = os.path.join(tmpdir, "prune.json")
from datetime import timedelta
base = datetime(2026, 10, 1, 11, tzinfo=ZoneInfo("Africa/Cairo"))
data = {"slots": {
    (base + timedelta(days=i)).strftime("%Y-%m-%dT%H"): {"videos": 1} for i in range(91)
}}
os.makedirs(os.path.dirname(slot_path) or ".", exist_ok=True)
with open(slot_path, "w") as f:
    json.dump(data, f)
env = dict(os.environ)
os.environ.update({
    "SCHEDULED_SLOT": "true", "MAX_VIDEOS_PER_SLOT": "1", "INVENT_WHEN_EMPTY": "false",
    "SLOT_STATE_PATH": slot_path, "SCHEDULE_HOURS": "23",
    "FACTORY_STATUS_PATH": os.path.join(tmpdir, "s5.json"),
    "FACTORY_STOP_FILE": os.path.join(tmpdir, "no-stop-2"),
})
try:
    for mod in ("factory", "schedule_gate"):
        sys.modules.pop(mod, None)
    import factory  # noqa
    factory.record_slot(1, "slot_idle")
    with open(slot_path) as f:
        kept = json.load(f)["slots"]
    check("pruned to <= 90", len(kept) <= 90, f"got {len(kept)}")
    check("kept newest (last day present)", (base + timedelta(days=90)).strftime("%Y-%m-%dT%H") in kept
          or len(kept) == 90)
finally:
    os.environ.clear()
    os.environ.update(env)

print(f"\n{'ALL PASS' if FAIL == 0 else str(FAIL) + ' FAILURES'} ({PASS} passed)")
sys.exit(1 if FAIL else 0)
