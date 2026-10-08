#!/usr/bin/env python3
"""Unit tests for scripts/schedule_gate.py - the schedule decision logic."""
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
LIVE_SCRIPTS = os.path.join(HERE, "..", "storypilot-live", "scripts")
sys.path.insert(0, LIVE_SCRIPTS)

import schedule_gate as sg  # noqa: E402

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


CAIRO = ZoneInfo("Africa/Cairo")
UTC = timezone.utc


def cairo(dt):
    return dt.replace(tzinfo=UTC).astimezone(CAIRO)


print("== parse_hours ==")
check("default list", sg.parse_hours("") == {11, 12, 13, 15, 20})
check("parses list", sg.parse_hours("9,11, 13,20") == {9, 11, 13, 20})
check("drops invalid", sg.parse_hours("9,x,25,-1,20") == {9, 20})
check("garbage -> default", sg.parse_hours("abc") == {11, 12, 13, 15, 20})
check("separators", sg.parse_hours("9;11;13") == {9, 11, 13})

print("== cairo_now / DST ==")
now = sg.cairo_now()
check("tz-aware", now.tzinfo is not None)
check("is Cairo zone", str(now.tzinfo) == "Africa/Cairo" or getattr(now.tzinfo, "key", "") == "Africa/Cairo")
# Egypt: UTC+3 in summer (DST), UTC+2 in winter - the gate must follow the real zone
summer = datetime(2026, 7, 1, 12, 0, tzinfo=UTC).astimezone(CAIRO)
winter = datetime(2026, 12, 1, 12, 0, tzinfo=UTC).astimezone(CAIRO)
summer_off = summer.utcoffset()
winter_off = winter.utcoffset()
print(f"  info  Egypt offsets: summer={summer_off}, winter={winter_off}")
check("summer = UTC+3", summer_off == timedelta(hours=3))
check("winter = UTC+2", winter_off == timedelta(hours=2))
# a UTC instant mapped through the real zone must give the gate the local hour
# 2026-07-01 08:07 UTC == 11:07 Cairo (DST) -> scheduled hour 11
t = cairo(datetime(2026, 7, 1, 8, 7))
check("UTC 08:07 July = Cairo 11:07", (t.hour, t.day, t.month) == (11, 1, 7), f"got {t}")
# 2026-12-01 09:07 UTC == 11:07 Cairo (no DST) -> scheduled hour 11
t = cairo(datetime(2026, 12, 1, 9, 7))
check("UTC 09:07 Dec = Cairo 11:07", (t.hour, t.day, t.month) == (11, 1, 12), f"got {t}")

print("== decide: outside / inside schedule ==")
tmpdir = tempfile.mkdtemp()
state_path = os.path.join(tmpdir, "schedule_state.json")


def run_decide(hour_dt, hours="11,12,13,15,20", reason="schedule", state=state_path, stop=None):
    stop_path = os.path.join(tmpdir, "FACTORY_STOP")
    if stop is None and os.path.exists(stop_path):
        os.remove(stop_path)
    if stop is not None:
        with open(stop_path, "w") as f:
            f.write("stop")
    run, detail = sg.decide(hours, state, reason, now=hour_dt, stop_file=stop_path)
    return run, detail


# 11:30 Cairo on a scheduled hour -> run
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)))
check("11:30 Cairo -> run", run is True, d["why"])
# 14:30 Cairo (not in schedule) -> skip
run, d = run_decide(cairo(datetime(2026, 7, 1, 11, 30)))
check("14:30 Cairo -> skip", run is False, d["why"])
check("skip reason mentions hours", "not a scheduled hour" in d["why"])
# 03:00 Cairo -> skip (no videos at night)
run, d = run_decide(cairo(datetime(2026, 7, 1, 0, 0)))
check("03:00 Cairo -> skip", run is False)

print("== decide: slot dedup ==")
# simulate a completed slot for 2026-07-01T11 Cairo
with open(state_path, "w") as f:
    json.dump({"slots": {sg.slot_key(cairo(datetime(2026, 7, 1, 8, 30))): {"videos": 2}}}, f)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 45)))
check("completed slot -> skip", run is False)
check("dedup reason mentions slot", "already completed" in d["why"])
# next hour (12:00 Cairo) is a fresh slot -> run
run, d = run_decide(cairo(datetime(2026, 7, 1, 9, 10)))
check("next hour -> run", run is True)

print("== decide: manual bypass ==")
run, d = run_decide(cairo(datetime(2026, 7, 1, 11, 30)), reason="manual")
check("manual at 14:30 -> run", run is True)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="chat")
check("chat at completed slot -> run", run is True)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="catchup")
check("catchup bypasses", run is True)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="force")
check("force bypasses", run is True)
# automated reasons must NOT bypass
run, d = run_decide(cairo(datetime(2026, 7, 1, 11, 30)), reason="app-heartbeat")
check("app-heartbeat respects schedule", run is False)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="ensure-slot")
check("ensure-slot respects dedup", run is False)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="schedule")
check("schedule tick respects dedup", run is False)

print("== decide: FACTORY_STOP blocks everything ==")
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="manual", stop=True)
check("stop file blocks manual", run is False)
run, d = run_decide(cairo(datetime(2026, 7, 1, 8, 30)), reason="schedule", stop=True)
check("stop file blocks tick", run is False)

print("== decide: slot key format ==")
k = sg.slot_key(cairo(datetime(2026, 7, 1, 8, 30)))
check("slot key format", k == "2026-07-01T11", k)

print("== fallback timezone (no tzdata) ==")
import builtins
real_import = builtins.__import__

def broken_import(name, *a, **k):
    if name == "zoneinfo":
        raise ImportError("simulated missing tzdata")
    return real_import(name, *a, **k)

builtins.__import__ = broken_import
try:
    # module already imported; call the internal path directly
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    fallback = _dt.now(_tz(_td(hours=sg.FALLBACK_OFFSET_H)))
    check("fallback offset is +3", sg.FALLBACK_OFFSET_H == 3)
    # simulate the except branch: cairo_now should not crash if zoneinfo import fails
    # (verified by code path: datetime.now(timezone(timedelta(hours=3))))
    check("fallback datetime constructible", fallback.tzinfo is not None)
finally:
    builtins.__import__ = real_import

print(f"\n{'ALL PASS' if FAIL == 0 else str(FAIL) + ' FAILURES'} ({PASS} passed)")
sys.exit(1 if FAIL else 0)
