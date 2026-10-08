#!/usr/bin/env python3
"""StoryPilot - Schedule Gate (shared by factory.yml + ensure-factory.yml).

Decides whether the CURRENT hour (Africa/Cairo) is a video slot. The
workflows tick every hour; this gate is what turns "hourly ticks" into
"videos at 11:00, 12:00, 13:00, 15:00, 20:00 ..." (SCHEDULE_HOURS).

Inputs:
  --hours   hour list (default: env SCHEDULE_HOURS, default "11,12,13,15,20")
  --state   slot-state file (default: env SLOT_STATE_PATH, default
            state/schedule_state.json) - records COMPLETED slots so one
            scheduled hour never makes videos twice
  --reason  why this run started (cron ticks pass "schedule")

Output (machine-readable lines for the workflows):
  GATE=run|skip     run -> this run may make videos
  REASON=...        human-readable explanation
  SLOT=YYYY-MM-DDTHH  the current slot key (Africa/Cairo)
  HOURS=...         the parsed schedule hours

Rules:
  1. state/FACTORY_STOP present          -> skip (explicit stop, everything)
  2. reason in MANUAL_REASONS            -> run (a human/agent asked NOW)
  3. current Cairo hour not in SCHEDULE_HOURS -> skip (outside the schedule)
  4. slot already completed this hour    -> skip (dedup: one session/slot)

The timezone is Africa/Cairo (the user's timezone). zoneinfo reads the
system tzdata on the GitHub runner; if that is ever missing we fall back
to UTC+3 (Egypt's summer offset) so a broken tz database can never kill
the schedule entirely. DST changes are handled by zoneinfo automatically.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

SCHEDULE_TZ = "Africa/Cairo"
FALLBACK_OFFSET_H = 3  # Egypt standard+1 (summer). Best-effort if tzdata is missing.
DEFAULT_HOURS = "11,12,13,15,20"
DEFAULT_STATE = "state/schedule_state.json"
STOP_FILE = "state/FACTORY_STOP"
MANUAL_REASONS = {"manual", "chat", "chat-start", "catchup", "force", "ui"}


def parse_hours(raw):
    """'11,12,13,15,20' -> {11,12,13,15,20} (invalid entries dropped)."""
    hours = set()
    for part in str(raw or "").replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            h = int(part)
        except ValueError:
            continue
        if 0 <= h <= 23:
            hours.add(h)
    return hours or {int(x) for x in DEFAULT_HOURS.split(",")}


def cairo_now():
    """Current time in Africa/Cairo (zoneinfo, UTC+3 fallback)."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(SCHEDULE_TZ))
    except Exception:
        return datetime.now(timezone(timedelta(hours=FALLBACK_OFFSET_H)))


def slot_key(dt):
    return dt.strftime("%Y-%m-%dT%H")


def load_slots(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("slots", {}) if isinstance(data, dict) else {}
    except Exception:
        return {}


def decide(hours_raw, state_path, reason, now=None, stop_file=STOP_FILE):
    """The whole gate logic, pure + testable. Returns (run: bool, detail: dict)."""
    now = now or cairo_now()
    hours = parse_hours(hours_raw)
    key = slot_key(now)
    detail = {"slot": key, "hours": sorted(hours), "hour": now.hour,
              "reason": reason or "schedule"}

    if os.path.exists(stop_file):
        return False, {**detail, "why": f"{stop_file} present - the factory is stopped"}

    if (reason or "").strip().lower() in MANUAL_REASONS:
        return True, {**detail, "why": f"manual/agent request (reason={reason}) - schedule bypassed"}

    if now.hour not in hours:
        return False, {**detail, "why": f"{now.hour:02d}:00 is not a scheduled hour "
                                       f"(schedule: {','.join(f'{h:02d}' for h in sorted(hours))} Africa/Cairo)"}

    slots = load_slots(state_path)
    if key in slots:
        done = slots[key]
        return False, {**detail, "why": f"slot {key} already completed "
                                       f"({done.get('videos', '?')} video(s) at {done.get('completed_at', '?')})"}

    return True, {**detail, "why": f"scheduled slot {key} - {now.hour:02d}:00 Africa/Cairo"}


def main():
    ap = argparse.ArgumentParser(description="StoryPilot schedule gate")
    ap.add_argument("--hours", default=os.environ.get("SCHEDULE_HOURS", DEFAULT_HOURS))
    ap.add_argument("--state", default=os.environ.get("SLOT_STATE_PATH", DEFAULT_STATE))
    ap.add_argument("--reason", default=os.environ.get("SLOT_REASON", "schedule"))
    ap.add_argument("--stop-file", default=STOP_FILE)
    args = ap.parse_args()

    run, detail = decide(args.hours, args.state, args.reason, stop_file=args.stop_file)
    print(f"GATE={'run' if run else 'skip'}")
    print(f"REASON={detail['why']}")
    print(f"SLOT={detail['slot']}")
    print(f"HOURS={','.join(str(h) for h in detail['hours'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
