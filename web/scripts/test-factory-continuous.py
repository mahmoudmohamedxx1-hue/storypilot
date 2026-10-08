#!/usr/bin/env python3
"""Behavioral test: factory.py in CONTINUOUS mode (stubs, no rendering).

Proves the properties the user asked for - videos made in a CONTINUOUS way,
the total count keeps climbing:
  1. no cap: the factory renders pending stories back-to-back until the
     time budget ends (then the workflow chains the next run)
  2. invention is NOT capped: when the queue empties, the keyless AI keeps
     inventing fresh stories so production never stalls
  3. STOP file: graceful shutdown, should_continue=false (no chaining)
  4. a failing story never kills the loop - it is recorded and the factory
     moves on to the next one
  5. INFINITE_STORIES=false: idle-poll instead of inventing
"""
import json
import os
import sys
import tempfile
import time as REAL_TIME
import types

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.join(HERE, "..", "storypilot-live")
SCRIPTS = os.path.join(LIVE, "scripts")

tmpdir = tempfile.mkdtemp(prefix="factory-continuous-")

# ---------------- stub the heavy modules BEFORE importing factory ----------------
ALL_STORIES = [
    {"title": f"Story {i}", "tabName": f"Tab{i}", "language": "ar",
     "scenes": [{"index": 1, "visual": "x", "voiceover": "y"}]}
    for i in (1, 2, 3, 4, 5)
]
STORIES = list(ALL_STORIES)
RENDERED_STATE = {"rendered": {}, "failed": {}}
FORGE_CALLS = []
FAIL_TITLES = set()
INVENT_CALLS = {"n": 0}
DRIVE_FLUSH = {"n": 0}
FORGE_COST_SEC = {"v": 25.0}


def make_story_obj(title):
    return {"title": title, "tabName": "Tab", "language": "ar",
            "scenes": [{"index": 1, "visual": "x", "voiceover": "y"}]}


class FakeClock:
    """Deterministic clock: time() returns a mutable instant, sleep() just
    advances it, strftime/gmtime/mktime delegate to the real module."""
    def __init__(self, start=1_750_000_000.0):
        self.t = start
    def time(self):
        return self.t
    def sleep(self, s):
        self.t += float(s)
    def strftime(self, fmt, tup):
        return REAL_TIME.strftime(fmt, tup)
    def gmtime(self, secs=None):
        return REAL_TIME.gmtime(secs) if secs is not None else REAL_TIME.gmtime(self.t)
    def mktime(self, tup):
        return REAL_TIME.mktime(tup)


CLOCK = FakeClock()


fake_rp = types.ModuleType("render_pending")
fake_rp.FRAME_RATE = 60
fake_rp.VIDEOS_DIR = os.path.join(tmpdir, "videos")
fake_rp.STATE_PATH = os.path.join(tmpdir, "state", "videos.json")
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
    CLOCK.t += FORGE_COST_SEC["v"]  # every video costs virtual time
    if story["title"] in FAIL_TITLES:
        raise RuntimeError("stubbed forge failure")
    return {"mode": "builtin", "model": "", "attempts": 0}


fake_ai.forge_story = fake_forge_story


def fake_keyless_chat(prompt, system):
    INVENT_CALLS["n"] += 1
    return json.dumps(make_story_obj(f"Invented {INVENT_CALLS['n']}")), "stub-route"


fake_ai.keyless_chat = fake_keyless_chat
fake_ai.extract_json = lambda text: json.loads(text) if isinstance(text, str) else text

fake_drive = types.ModuleType("drive_sync")
fake_drive.SYNC_INTERVAL = 3600.0
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


def run_factory(stories, budget_min="1.0", forge_cost=25.0, invent="true",
                stop_file=None, extra_env=None, fail_titles=()):
    """Run factory.main() on a fresh module instance with a fresh FakeClock."""
    global STORIES, RENDERED_STATE, FORGE_CALLS, FAIL_TITLES, INVENT_CALLS, DRIVE_FLUSH, CLOCK
    STORIES = stories
    RENDERED_STATE = {"rendered": {}, "failed": {}}
    FORGE_CALLS = []
    FAIL_TITLES = set(fail_titles)
    INVENT_CALLS = {"n": 0}
    DRIVE_FLUSH = {"n": 0}
    CLOCK = FakeClock()
    FORGE_COST_SEC["v"] = forge_cost
    env = {
        "FACTORY_BUDGET_MIN": budget_min,
        "FACTORY_MARGIN_SEC": "5",
        "MIN_VIDEO_SLOT_SEC": "10",
        "INFINITE_STORIES": invent,
        "INVENT_ATTEMPTS": "3",
        "IDLE_POLL_SEC": "90",
        "SHEET_TTL_SEC": "150",
        "STATUS_TICK_SEC": "3600",
        "FACTORY_STATUS_PATH": os.path.join(tmpdir, f"status_{CLOCK.t}_{len(FORGE_CALLS)}.json"),
        "FACTORY_STOP_FILE": stop_file or os.path.join(tmpdir, "no-stop-file"),
    }
    if extra_env:
        env.update(extra_env)
    old = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    # make sure no scheduled-mode leftovers influence the module
    for k in ("SCHEDULED_SLOT", "MAX_VIDEOS_PER_SLOT", "SCHEDULE_HOURS", "SLOT_STATE_PATH"):
        os.environ.pop(k, None)
    try:
        sys.modules.pop("factory", None)
        import factory  # noqa
        factory.time = CLOCK                    # deterministic clock
        factory._start_status_ticker = lambda: None  # no background thread in tests
        factory.main()
        status = factory.STATUS
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    return status


print("== scenario 1: pending queue, NO cap - back-to-back until the budget ends ==")
# budget 60s, every video costs 25s virtual:
#   t=0 rem=60 -> Story1 (t=25) -> rem=35 -> Story2 (t=50) -> rem=10 -> Story3 (t=75)
#   -> rem=-15 -> deadline. 3 videos, nothing left un-attempted mid-flight.
status = run_factory(list(ALL_STORIES), budget_min="1.0", forge_cost=25.0)
check("mode continuous", status.get("mode") == "continuous")
check("made 3 videos back-to-back (no cap)", status["run"]["videos_made"] == 3,
      f"got {status['run']['videos_made']}")
check("stop reason deadline", status["run"]["stop_reason"] == "deadline")
check("should_continue stays true (workflow chains the next run)",
      status["should_continue"] is True)
check("phase chaining_next_run", status["phase"] == "chaining_next_run")
check("no invention (queue never emptied)", INVENT_CALLS["n"] == 0)
check("videos_total tracks the count", status["videos_total"] == 3)
check("drive synced more than once (per-video + final flush)", DRIVE_FLUSH["n"] >= 2,
      f"got {DRIVE_FLUSH['n']}")

print("== scenario 2: queue empties -> invention is NOT capped, keeps producing ==")
# 1 sheet story + budget 200s + 40s/video:
# sheet story, then invent #1..#4 back-to-back until the budget ends.
status = run_factory(ALL_STORIES[:1], budget_min=str(200 / 60), forge_cost=40.0)
check("sheet story rendered", "Story 1" in FORGE_CALLS)
check("invented 4 more (NOT capped at one)", INVENT_CALLS["n"] == 4,
      f"got {INVENT_CALLS['n']}")
check("total videos this run = 5", status["run"]["videos_made"] == 5,
      f"got {status['run']['videos_made']}")
check("stop reason deadline (chains again)", status["run"]["stop_reason"] == "deadline")
check("should_continue true", status["should_continue"] is True)

print("== scenario 3: STOP file -> graceful shutdown, no chaining ==")
stop = os.path.join(tmpdir, "FACTORY_STOP")
with open(stop, "w") as f:
    f.write("stop\n")
status = run_factory(list(ALL_STORIES), budget_min="5", forge_cost=25.0, stop_file=stop)
check("made 0 videos", status["run"]["videos_made"] == 0)
check("stop reason stopped", status["run"]["stop_reason"] == "stopped")
check("should_continue false (the chain step reads this)", status["should_continue"] is False)
check("phase stopped", status["phase"] == "stopped")

print("== scenario 4: a failing story never kills the loop ==")
status = run_factory(ALL_STORIES[:2], budget_min=str(200 / 60), forge_cost=40.0,
                     fail_titles={"Story 1"})
# Story1 fails (t=40, recorded as failed), Story2 renders (t=80), then invents
# (t=120, t=160), rem=40 -> one more invent (t=200) -> deadline. made = Story2 + 3 = 4
check("failed story was attempted", "Story 1" in FORGE_CALLS)
check("loop continued past the failure", "Story 2" in FORGE_CALLS and INVENT_CALLS["n"] >= 1)
check("successes counted correctly", status["run"]["videos_made"] == 4,
      f"got {status['run']['videos_made']}")
check("failure recorded in recent", any(r.get("ok") is False for r in status["recent"]))

print("== scenario 5: INFINITE_STORIES=false -> idle-poll, no invention ==")
status = run_factory([], budget_min=str(100 / 60), forge_cost=40.0, invent="false")
check("made 0 videos", status["run"]["videos_made"] == 0)
check("no invention attempted", INVENT_CALLS["n"] == 0)
check("stop reason deadline", status["run"]["stop_reason"] == "deadline")

print("== scenario 6: module defaults are continuous (no scheduled env) ==")
sys.modules.pop("factory", None)
import factory as fresh  # noqa
check("no SCHEDULED_SLOT knob left in the module", not hasattr(fresh, "SCHEDULED_SLOT"))
check("no MAX_VIDEOS_PER_SLOT knob left", not hasattr(fresh, "MAX_VIDEOS_PER_SLOT"))
check("default mode continuous", fresh.STATUS["mode"] == "continuous")
check("default budget 300min", fresh.FACTORY_BUDGET_MIN == 300.0)
check("default infinite stories", fresh.INFINITE_STORIES is True)

print(f"\n{'ALL PASS' if FAIL == 0 else str(FAIL) + ' FAILURES'} ({PASS} passed)")
sys.exit(1 if FAIL else 0)
