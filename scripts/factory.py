#!/usr/bin/env python3
"""StoryPilot - Video Factory supervisor (SCHEDULED mode by default).

Runs inside a GitHub Actions job (factory.yml) that ticks hourly - the
schedule gate decides which hours are video slots (SCHEDULE_HOURS,
Africa/Cairo; default 11,12,13,15,20 = videos at 11:00, 12:00, 13:00,
15:00, 20:00). ONE slot makes a bounded number of videos and STOPS:

    SCHEDULED SLOT (SCHEDULED_SLOT=true, the workflow's mode)
      1. sync the Google Sheet (Spark's live edits first)
      2. every story without a video -> AI HYPERFRAME FORGE
         (the keyless AI WRITES the renderer code, we run it,
          it repairs itself, built-in renderer as last resort)
      3. stop after MAX_VIDEOS_PER_SLOT videos (default 2)
      4. queue empty + INVENT_WHEN_EMPTY=true -> invent ONE fresh story
         (max one per slot) so the slot still produces a video
      5. record the slot in state/schedule_state.json (the gate's dedup:
         one video session per scheduled hour, never two) and exit.
         NO chaining - the next video comes at the next scheduled hour.

    CONTINUOUS mode (SCHEDULED_SLOT=false, legacy/manual): the old
    forever-loop - drain the queue, invent forever, respect only the
    time budget. Kept for manual catch-up runs.

Progress survives runs: state/videos.json (committed to the repo) records every
rendered story-hash, so nothing is ever re-processed and new/edited Spark rows
are picked up automatically. state/factory_status.json is the live heartbeat
file the StoryPilot app reads (phase, current story, queue depth, recent runs).

Stop the factory: create state/FACTORY_STOP in the repo (the app exposes this),
or disable the "Scheduled Video Factory" workflow.
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)
os.chdir(ROOT)

import ai_forge          # noqa: E402
import drive_sync        # noqa: E402
import render_pending as rp  # noqa: E402
import schedule_gate     # noqa: E402

SCHEDULED_SLOT = os.environ.get("SCHEDULED_SLOT", "true").lower() in ("1", "true", "yes")
MAX_VIDEOS_PER_SLOT = max(1, int(os.environ.get("MAX_VIDEOS_PER_SLOT", "2")))
INVENT_WHEN_EMPTY = os.environ.get("INVENT_WHEN_EMPTY", "true").lower() in ("1", "true", "yes")
SLOT_STATE_PATH = os.environ.get("SLOT_STATE_PATH", "state/schedule_state.json")
SCHEDULE_HOURS = os.environ.get("SCHEDULE_HOURS", schedule_gate.DEFAULT_HOURS)
FACTORY_BUDGET_MIN = float(os.environ.get("FACTORY_BUDGET_MIN", "45" if SCHEDULED_SLOT else "300"))
MARGIN_SEC = float(os.environ.get("FACTORY_MARGIN_SEC", "300"))
MIN_VIDEO_SLOT_SEC = float(os.environ.get("MIN_VIDEO_SLOT_SEC", "900"))
INFINITE_STORIES = os.environ.get("INFINITE_STORIES", "true").lower() in ("1", "true", "yes")
IDLE_POLL_SEC = int(os.environ.get("IDLE_POLL_SEC", "90"))
SHEET_TTL_SEC = float(os.environ.get("SHEET_TTL_SEC", "150"))
STATUS_PATH = os.environ.get("FACTORY_STATUS_PATH", "state/factory_status.json")
STOP_FILE = os.environ.get("FACTORY_STOP_FILE", "state/FACTORY_STOP")

# Topic rotation for AI-invented stories (Arabic - the channel's main language).
AI_STORY_TOPICS = [
    "قوة الفائدة المركبة وكيف تضاعف أموالك مع الوقت",
    "صندوق الطوارئ: درعك المالي الأول ضد المفاجآت",
    "الفرق بين الأصول والالتزامات ولماذا يفرق الأغنياء",
    "كيف تبدأ الاستثمار بمبلغ صغير جدا",
    "التضخم: اللص الصامت الذي يأكل مدخراتك",
    "الانضباط المالي: عادة صغيرة تغير حياتك",
    "صناديق المؤشرات للمبتدئين: الاستثمار بدون صداع",
    "الذهب أم الأسهم؟ أين تضع أموالك",
    "الدين الجيد والدين السيئ: متى الاقتراض ذكي؟",
    "التنويع الاستثماري: لا تضع كل البيض في سلة واحدة",
    "مخاطر محاولة توقيت السوق ولماذا يخسر معظم الناس",
    "الادخار التلقائي: ادفع لنفسك أولا",
    "قاعدة 72: احسب سرعة مضاعفة أموالك في ثانيتين",
    "العقلية طويلة الأجل: سر كبار المستثمرين",
    "الفقاعة المالية: كيف تعرفها قبل أن تنفجر",
    "الاستثمار في نفسك: أفضل عائد على الإطلاق",
    "كيف تقرأ القوائم المالية لشركة قبل شراء سهمها",
    "التقاعد المبكر: خطة FIRE بالأرقام الحقيقية",
    "أخطاء نفسية يقع فيها كل مستثمر مبتدئ",
    "الدخل السلبي: الحقيقة بدون مبالغة",
]


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg):
    print(f"[factory] {msg}", flush=True)


STATUS = {
    "phase": "boot",
    "mode": "scheduled" if SCHEDULED_SLOT else "continuous",
    "slot": None,
    "schedule_hours": SCHEDULE_HOURS,
    "max_videos_per_slot": MAX_VIDEOS_PER_SLOT,
    "should_continue": True,
    "run": {},
    "current": None,
    "queue": {"pending": 0, "total": 0},
    "videos_this_run": 0,
    "ai_invented_total": 0,
    "recent": [],
    "drive": None,
    "updated_at": now_iso(),
}


def record_slot(videos, stop_reason):
    """Mark the current Cairo-hour slot as completed (the gate's dedup).

    Even a slot that produced 0 videos is recorded, so an empty queue does
    not retry all hour long - the next scheduled hour picks new stories up.
    """
    try:
        now = schedule_gate.cairo_now()
        key = schedule_gate.slot_key(now)
        data = {"slots": {}}
        try:
            with open(SLOT_STATE_PATH, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict) and isinstance(loaded.get("slots"), dict):
                data = loaded
        except Exception:
            pass
        slots = data["slots"]
        slots[key] = {
            "videos": videos,
            "stop_reason": stop_reason,
            "completed_at": now_iso(),
            "mode": "scheduled" if SCHEDULED_SLOT else "continuous",
        }
        # keep the newest 90 slots (about four days of heavy scheduling)
        for old in sorted(slots)[:-90]:
            slots.pop(old, None)
        os.makedirs(os.path.dirname(SLOT_STATE_PATH) or ".", exist_ok=True)
        tmp = SLOT_STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, SLOT_STATE_PATH)
        STATUS["slot"] = {"key": key, "videos": videos, "stop_reason": stop_reason}
        log(f"slot {key} recorded: {videos} video(s) ({stop_reason})")
    except Exception as e:
        log(f"::warning::could not record the slot: {e}")


def refresh_drive_status():
    STATUS["drive"] = drive_sync.drive_status()


def write_status():
    STATUS["updated_at"] = now_iso()
    os.makedirs(os.path.dirname(STATUS_PATH) or ".", exist_ok=True)
    tmp = STATUS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(STATUS, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATUS_PATH)


def stopped():
    return os.path.exists(STOP_FILE)


def push_state():
    """Best-effort git commit+push of the state files (GitHub runs only)."""
    if not os.environ.get("GH_TOKEN"):
        return
    try:
        subprocess.run(["git", "config", "user.name", "storypilot-bot"], check=False)
        subprocess.run(["git", "config", "user.email",
                        "41898282+github-actions[bot]@users.noreply.github.com"], check=False)
        subprocess.run(["git", "add", "state/"], check=False)
        r = subprocess.run(["git", "diff", "--cached", "--quiet"], capture_output=True)
        if r.returncode == 0:
            return  # nothing new
        subprocess.run(["git", "commit", "-m", "factory: state update [skip ci]"],
                       check=False, capture_output=True)
        for _ in range(2):
            p = subprocess.run(["bash", "-c", "git pull --rebase origin main && git push"],
                               capture_output=True, text=True)
            if p.returncode == 0:
                log("state pushed to the repo")
                return
            time.sleep(4)
        log("::warning::could not push state - next run may redo one video (harmless)")
    except Exception as e:
        log(f"::warning::push_state failed: {e}")


def _sheet_stories(cache):
    """Collect all sheet stories with a TTL cache (Spark edits mid-run are picked up)."""
    now = time.time()
    if cache["data"] is None or now - cache["at"] > SHEET_TTL_SEC:
        try:
            stories = rp.collect_stories()
            for st in stories:
                st["_hash"] = rp.story_hash(st)
            cache["data"], cache["at"] = stories, now
            STATUS["queue"]["total"] = len(stories)
        except Exception as e:
            log(f"sheet sync failed: {e}")
            if cache["data"] is None:
                cache["data"] = []
    return cache["data"]


def invent_story(state):
    """Ask the keyless AI for a brand-new story (rotating topics, no repeats)."""
    n = int(state.get("ai_invented_count", 0))
    topic = AI_STORY_TOPICS[n % len(AI_STORY_TOPICS)]
    recent = [t.get("title", "") for t in state.get("ai_titles", [])[-40:]]
    system = (
        'You are the showrunner of an Arabic cinematic vertical-video channel. Reply with ONLY '
        'a JSON object: {"title": str, "logline": str, "hook": str, "lesson": str, "genre": str, '
        '"duration": "75 Seconds", "language": "ar", "scenes": [{"index": 1, '
        '"timeRange": "0:00-0:07", "visual": str, "aiPrompt": str, "voiceover": str, "sfx": str}]}. '
        'EXACTLY 10 scenes with contiguous timeRanges totalling 60-90 seconds. Each "voiceover" is '
        'ONE sentence of Modern Standard Arabic (max 12 words, no diacritics); scene 1 is a hook '
        'question, scenes 8-9 carry the twist, scene 10 ends with a question to the audience. Each '
        '"visual" is one directing sentence (25+ words): shot size + subject DOING something + an '
        'explicit CAMERA MOVE (push-in/pull-out/pan/tilt/handheld/orbit - different every scene, '
        'never static) + moving atmosphere (dust/rain/fog/embers/light rays) + light & palette; '
        'cold tones early, warm at the end. "aiPrompt" is a short ENGLISH cinematic image prompt '
        '(different shot size every scene). "sfx" is 3 English layers: ambience + music + hit. '
        'Never repeat a previous title.'
    )
    prompt = f"Write a fresh 75-second director's storyboard story about: {topic}"
    if recent:
        prompt += "\n\nThese were used recently (do NOT repeat them): " + "; ".join(recent[:12])
    text, route = ai_forge.keyless_chat(prompt, system)
    data = ai_forge.extract_json(text)
    if not data.get("scenes") or not data.get("title"):
        raise ValueError("AI story missing title/scenes")
    data["scenes"] = data["scenes"][:12]
    for i, s in enumerate(data["scenes"], 1):
        s.setdefault("index", i)
        s.setdefault("timeRange", f"scene {i}")
        s.setdefault("visual", "")
        s.setdefault("aiPrompt", "")
        s.setdefault("voiceover", "")
        s.setdefault("sfx", "")
    data.setdefault("language", "ar")
    data.setdefault("duration", "60 Seconds")
    data["narration"] = data.get("narration") or " ".join(s["voiceover"] for s in data["scenes"])
    data["logline"] = data.get("logline") or data["title"]
    data["genre"] = data.get("genre") or "مالي"
    data["_route"] = route
    log(f"invented '{data['title']}' via {route}")
    return data


def forge_one(story, out_dir, deadline, source_label):
    """Forge one video and update the persistent state around it."""
    h = story["_hash"]
    STATUS["current"] = {
        "title": story.get("title", ""),
        "source": source_label,
        "started_at": now_iso(),
    }
    write_status()
    t0 = time.time()
    res = ai_forge.forge_story(story, out_dir, deadline=deadline, fps=str(rp.FRAME_RATE))
    dt = time.time() - t0
    ok = res.get("mode") in ("ai", "builtin")
    entry = {
        "title": story.get("title", ""),
        "tab": story.get("tabName", source_label),
        "renderedAt": now_iso(),
        "fps": int(rp.FRAME_RATE),
        "dir": os.path.basename(out_dir),
        "source": source_label,
        "renderer": res.get("mode"),
        "code_by": res.get("model", ""),
        "ai_attempts": res.get("attempts", 0),
    }
    return ok, entry, dt, res


def main():
    t0 = time.time()
    deadline = t0 + FACTORY_BUDGET_MIN * 60
    STATUS["slot"] = {"key": schedule_gate.slot_key(schedule_gate.cairo_now()),
                      "videos": 0, "stop_reason": None}
    STATUS["run"] = {
        "started_at": now_iso(),
        "deadline_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(deadline)),
        "budget_min": FACTORY_BUDGET_MIN,
        "mode": "scheduled" if SCHEDULED_SLOT else "continuous",
        "infinite_stories": INFINITE_STORIES,
    }
    write_status()
    if SCHEDULED_SLOT:
        log(f"factory boot [SCHEDULED]: hours {SCHEDULE_HOURS} Africa/Cairo | "
            f"max {MAX_VIDEOS_PER_SLOT} video(s) this slot | invent-when-empty={INVENT_WHEN_EMPTY} "
            f"| budget {FACTORY_BUDGET_MIN:.0f}m | hyperframes {rp.FRAME_RATE}fps")
    else:
        log(f"factory boot [CONTINUOUS]: budget {FACTORY_BUDGET_MIN:.0f}m | "
            f"infinite-stories={INFINITE_STORIES} | hyperframes {rp.FRAME_RATE}fps")

    # union of state/videos.json + every state/videos.shard*.json written by the
    # parallel hourly-video workers - without this the factory would re-render
    # every story that lives in a shard file
    state = (rp.load_union_state() if hasattr(rp, "load_union_state")
             else rp.load_state())
    state.setdefault("ai_invented_count", 0)
    state.setdefault("ai_titles", [])
    cache = {"data": None, "at": 0.0}
    made = 0
    seq = 0
    invented_this_run = 0
    attempted: set = set()  # story hashes already tried this run (no instant re-loops)
    stop_reason = "budget"

    # first pass right away if the hourly TTL already elapsed (chained runs),
    # then after every finished video - maybe_sync() self-throttles to
    # DRIVE_SYNC_INTERVAL (default 1h), so this is "sync with Drive every hour"
    drive_sync.maybe_sync()
    refresh_drive_status()

    while True:
        if stopped():
            stop_reason = "stopped"
            STATUS["should_continue"] = False
            log("STOP file found - shutting the factory down gracefully")
            break
        if SCHEDULED_SLOT and made >= MAX_VIDEOS_PER_SLOT:
            stop_reason = "slot_complete"
            log(f"slot budget reached ({made} video(s), max {MAX_VIDEOS_PER_SLOT}) - "
                f"next videos at the next scheduled hour ({SCHEDULE_HOURS} Cairo)")
            break
        remaining = deadline - time.time()
        if remaining < MARGIN_SEC:
            stop_reason = "deadline"
            log(f"time budget nearly spent ({(time.time() - t0) / 60:.0f}m used) - "
                f"chaining the next run")
            break
        if remaining < MIN_VIDEO_SLOT_SEC:
            log(f"only {remaining / 60:.0f}m left - not enough for another video safely")
            stop_reason = "deadline"
            break

        stories = _sheet_stories(cache)
        pending = [st for st in stories if rp.is_pending(st, state) and st["_hash"] not in attempted]
        STATUS["queue"]["pending"] = len(pending)
        want_invent = ((INFINITE_STORIES and not SCHEDULED_SLOT)
                       or (SCHEDULED_SLOT and INVENT_WHEN_EMPTY and invented_this_run == 0))
        STATUS["phase"] = ("rendering" if pending
                           else ("inventing" if want_invent else "idle"))
        write_status()

        if pending:
            story = pending[0]
            attempted.add(story["_hash"])
            seq += 1
            slug = f"{seq:02d}-{story['_hash'][:8]}"
            out_dir = os.path.join(rp.VIDEOS_DIR, slug)
            log(f"pending {len(pending)} | forging '{story['title']}' [{story['tabName']}]")
            try:
                ok, entry, dt, res = forge_one(story, out_dir, deadline, "sheet")
                state["rendered"][story["_hash"]] = entry
                state["failed"].pop(story["_hash"], None)
                made += 1
                STATUS["videos_this_run"] = made
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story["title"], "source": "sheet", "ok": ok,
                    "renderer": res.get("mode"), "code_by": res.get("model"),
                    "seconds": round(dt), "at": now_iso(),
                }])[-10:]
                log(f"DONE '{story['title']}' in {dt / 60:.1f}m via {res.get('mode')} "
                    f"(code by {res.get('model')})")
            except Exception as e:
                msg = str(e)[:300]
                log(f"FAILED '{story['title']}': {msg}")
                prev = state["failed"].get(story["_hash"], {})
                state["failed"][story["_hash"]] = {
                    "title": story["title"], "error": msg, "at": now_iso(),
                    "tries": int(prev.get("tries", 0)) + 1,
                }
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story["title"], "source": "sheet", "ok": False,
                    "error": msg[:160], "at": now_iso(),
                }])[-10:]
            STATUS["current"] = None
            rp.save_state(state)
            push_state()
            drive_sync.maybe_sync()
            refresh_drive_status()
            write_status()
            continue

        if want_invent:
            try:
                story = invent_story(state)
            except Exception as e:
                if SCHEDULED_SLOT:
                    # don't burn the slot retrying invention - record it and
                    # let the next scheduled hour try again with a fresh queue
                    log(f"story invention failed: {str(e)[:200]} - ending this slot")
                    stop_reason = "invent_failed"
                    break
                log(f"story invention failed: {str(e)[:200]} - retrying after a pause")
                STATUS["phase"] = "inventing"
                write_status()
                time.sleep(60)
                continue
            story["_hash"] = rp.story_hash(story)
            if story["_hash"] in state["rendered"]:
                log("invented story was already rendered - inventing another")
                continue
            seq += 1
            slug = f"ai{seq:02d}-{story['_hash'][:8]}"
            out_dir = os.path.join(rp.VIDEOS_DIR, slug)
            log(f"sheet queue empty - forging AI-invented story '{story['title']}'")
            try:
                ok, entry, dt, res = forge_one(story, out_dir, deadline, "ai-invented")
                entry["topic"] = AI_STORY_TOPICS[int(state.get("ai_invented_count", 0)) % len(AI_STORY_TOPICS)]
                state["rendered"][story["_hash"]] = entry
                state["ai_invented_count"] = int(state.get("ai_invented_count", 0)) + 1
                state["ai_titles"] = (state.get("ai_titles", []) + [{"title": story["title"]}])[-60:]
                made += 1
                invented_this_run += 1
                STATUS["videos_this_run"] = made
                STATUS["ai_invented_total"] = state["ai_invented_count"]
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story["title"], "source": "ai-invented", "ok": ok,
                    "renderer": res.get("mode"), "code_by": res.get("model"),
                    "seconds": round(dt), "at": now_iso(),
                }])[-10:]
                log(f"DONE (AI-invented) '{story['title']}' in {dt / 60:.1f}m")
            except Exception as e:
                msg = str(e)[:300]
                log(f"FAILED (AI-invented) '{story['title']}': {msg}")
                STATUS["recent"] = (STATUS["recent"] + [{
                    "title": story.get("title", "?"), "source": "ai-invented", "ok": False,
                    "error": msg[:160], "at": now_iso(),
                }])[-10:]
            STATUS["current"] = None
            rp.save_state(state)
            push_state()
            drive_sync.maybe_sync()
            refresh_drive_status()
            write_status()
            continue

        # scheduled mode: nothing pending and no invention -> the slot is
        # done for this hour; do NOT sit and poll (that's continuous
        # behavior) - the next scheduled hour picks new Spark stories up
        if SCHEDULED_SLOT:
            stop_reason = "slot_idle"
            log("queue empty - slot complete, next videos at the next scheduled hour")
            break

        # continuous mode: nothing pending -> wait for Spark to add stories
        STATUS["phase"] = "idle"
        write_status()
        log(f"queue empty - re-checking the sheet in {IDLE_POLL_SEC}s")
        time.sleep(IDLE_POLL_SEC)
        cache["at"] = 0.0  # force a fresh sync next pass

    STATUS["phase"] = ("stopped" if stop_reason == "stopped"
                       else ("slot_done" if SCHEDULED_SLOT else "waiting_for_chain"))
    STATUS["current"] = None
    STATUS["queue"]["pending"] = len([
        st for st in (cache["data"] or []) if rp.is_pending(st, state)])
    STATUS["run"]["finished_at"] = now_iso()
    STATUS["run"]["videos_made"] = made
    STATUS["run"]["stop_reason"] = stop_reason
    # graceful shutdown: flush anything the hourly tick hasn't synced yet
    # (dedup still applies - only videos missing from Drive are uploaded)
    if stop_reason != "stopped":
        try:
            drive_sync.maybe_sync(respect_ttl=False)
        except Exception as e:
            log(f"::warning::final drive sync failed: {str(e)[:200]}")
    refresh_drive_status()
    if SCHEDULED_SLOT:
        # record BEFORE pushing so the schedule gate sees this slot as done
        # (one video session per scheduled hour, never two)
        record_slot(made, stop_reason)
    write_status()
    rp.save_state(state)
    push_state()
    log(f"factory run complete: {made} videos | {STATUS['queue']['pending']} still pending | "
        f"reason={stop_reason}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        STATUS["phase"] = "interrupted"
        write_status()
        log("interrupted")
