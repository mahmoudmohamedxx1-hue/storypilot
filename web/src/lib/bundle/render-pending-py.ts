export const RENDER_PENDING_PY = `#!/usr/bin/env python3
"""StoryPilot - Continuous factory batch renderer (the "make ALL videos" queue).

Guarantees every story in the Google Sheet eventually becomes a video:

  1. discovers every tab of the sheet (keyless, public htmlview)
  2. parses ALL stories with the same universal multi-format parser the app uses
     (Story / Batch EN+AR / Tracker / Arabic tabs - tolerant to Spark updates)
  3. loads the render state: union of state/videos.json (legacy) + every
     state/videos.shard*.json (parallel workers each own one shard file)
  4. a story is PENDING when its content-hash is not in the rendered state yet;
     edited stories (new Spark content) change their hash and re-queue
  5. SHARDING: with NUM_SHARDS > 1 the pending queue is interleaved across
     workers (story i -> worker i % NUM_SHARDS); all workers check out the
     same commit so the split is deterministic and lossless
  6. KEYLESS AI POLISH: each story's voiceovers are tightened by freellmpool
     (FLP_MODEL first, auto-failover) which also writes the platform
     title/description/tags - on ANY failure the original text is used
  7. renders each story via generate_video.py (hyperframes FRAME_RATE)
  8. writes videos/<nn>-<hash8>/{output.mp4,meta.json,thumb.jpg,story.json}
     + updates this worker's state file + batch_summary.json

Time-budgeted: stops STARTING new videos near BUDGET_MIN so the workflow never
times out; the next dispatch (app continuous loop / hourly cron) resumes the
queue where it left off. Failed stories are retried once on a later run, then
left alone until edited.
"""
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

SHEET_ID = os.environ.get("SHEET_ID", "__SHEET_ID__")
CODE_TAB_EXACT = "\\u0643\\u0648\\u062f \\u0628\\u0627\\u064a\\u062b\\u0648\\u0646 - \\u0627\\u0644\\u0645\\u0648\\u0644\\u062f \\u0627\\u0644\\u0622\\u0644\\u064a"  # the sheet's code tab
BUDGET_MIN = float(os.environ.get("BUDGET_MIN", "36"))
MAX_VIDEOS = int(os.environ.get("MAX_VIDEOS", "4"))
FRAME_RATE = os.environ.get("FRAME_RATE", "60")  # hyperframes
RENDER_MARGIN_SEC = float(os.environ.get("RENDER_MARGIN_SEC", "480"))
SUBPROC_TIMEOUT = int(os.environ.get("SUBPROC_TIMEOUT", "1500"))
SHARD_INDEX = int(os.environ.get("SHARD_INDEX", "0"))
NUM_SHARDS = max(1, int(os.environ.get("NUM_SHARDS", "1")))
AI_ENHANCE = os.environ.get("AI_ENHANCE", "true").lower() in ("1", "true", "yes")
FLP_MODEL = os.environ.get("FLP_MODEL", "__FLP_MODEL__")
LLM7_MODEL = os.environ.get("LLM7_MODEL", "GLM-5.3-Flash")
STATE_DIR = os.environ.get("STATE_DIR", "state")
# each parallel worker owns its own shard file (no git conflicts between workers)
STATE_PATH = os.environ.get(
    "STATE_PATH",
    os.path.join(STATE_DIR, f"videos.shard{SHARD_INDEX}.json") if NUM_SHARDS > 1 else os.path.join(STATE_DIR, "videos.json"),
)
VIDEOS_DIR = os.environ.get("VIDEOS_DIR", "videos")
UA = {"User-Agent": "Mozilla/5.0 (compatible; StoryPilotAgent/1.0)"}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ------------------------------- fetch / csv --------------------------------

def fetch_url(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_csv(text):
    rows, row, cell, q = [], [], "", False
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if q:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    cell += '"'
                    i += 1
                else:
                    q = False
            else:
                cell += c
        elif c == '"':
            q = True
        elif c == ",":
            row.append(cell)
            cell = ""
        elif c == "\\n":
            row.append(cell)
            rows.append(row)
            row = []
            cell = ""
        elif c != "\\r":
            cell += c
        i += 1
    if cell or row:
        row.append(cell)
        rows.append(row)
    return rows


# ---------------------- text helpers (hash-parity with the app) -------------

def detect_language(t):
    ar = len(re.findall(r"[\\u0600-\\u06FF]", t))
    la = len(re.findall(r"[A-Za-z]", t))
    return "ar" if ar > la else "en"


def strip_html(s):
    s = re.sub(r"<style[\\s\\S]*?</style>", " ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = s.replace("&nbsp;", " ")
    s = re.sub(r"\\s{2,}", " ", s)
    return s.strip()


def clean(s, max_len=900):
    t = strip_html(str(s or ""))
    t = t.replace("\\\\n", " ")
    t = re.sub(r"[\\x00-\\x1f]", " ", t)
    t = re.sub(r"\\s{2,}", " ", t)
    t = t.strip()
    return t[: max_len - 1] + "\\u2026" if len(t) > max_len else t


TIME_RE = re.compile(r"^\\d{1,2}:\\d{2}\\s*[-\\u2013\\u2014]\\s*\\d{1,2}:\\d{2}$")


def looks_like_time(s):
    t = re.sub(r"\\s+", " ", (s or "").strip())
    return bool(TIME_RE.match(t))


def time_range_to_sec(label):
    m = re.search(r"(\\d{1,2}):(\\d{2})\\s*[-\\u2013\\u2014]\\s*(\\d{1,2}):(\\d{2})", label or "")
    if not m:
        return 0
    def tosec(mm, ss):
        return int(mm) * 60 + int(ss)
    return max(0, tosec(m.group(3), m.group(4)) - tosec(m.group(1), m.group(2)))


def duration_from_ranges(scenes):
    total = sum(time_range_to_sec(s.get("timeRange", "")) for s in scenes)
    return f"{total} seconds" if total > 0 else ""


def story_hash(st):
    """EXACT same hash the StoryPilot app computes (src/lib/sheet.ts storyHash)."""
    norm = json.dumps(
        {
            "t": re.sub(r"\\s+", " ", st.get("title", "")).lower().strip(),
            "d": (st.get("duration") or "").lower(),
            "s": [
                [
                    s.get("timeRange", ""),
                    (s.get("heading") or "").lower(),
                    s.get("visual", "").lower(),
                    s.get("voiceover", "").lower(),
                ]
                for s in st.get("scenes", [])
            ],
        },
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.md5(norm.encode("utf-8")).hexdigest()


# ------------------------------ tab discovery -------------------------------

TAB_RE = re.compile(
    r'items\\.push\\(\\{name:\\s*"((?:[^"\\\\]|\\\\.)*)",\\s*pageUrl:[^"]*"[^"]*gid=(\\d+)",\\s*gid:\\s*"(\\d+)"'
)


def _unescape_name(m_name):
    def hx(mm):
        return chr(int(mm.group(1), 16))
    s = re.sub(r"\\\\x([0-9a-fA-F]{2})", hx, m_name)
    return s.replace("\\\\/", "/").strip()


def list_tabs():
    html = fetch_url(f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/htmlview")
    tabs = []
    for m in TAB_RE.finditer(html):
        name = _unescape_name(m.group(1))
        if name:
            tabs.append({"gid": m.group(2), "name": name})
    if not tabs:
        tabs = [{"gid": "0", "name": "Sheet"}]
    return tabs


def is_code_tab(name):
    n = (name or "").strip()
    return (
        n == CODE_TAB_EXACT
        or "\\u0643\\u0648\\u062f \\u0628\\u0627\\u064a\\u062b\\u0648\\u0646" in n
        or "\\u0627\\u0644\\u0645\\u0648\\u0644\\u062f \\u0627\\u0644\\u0622\\u0644\\u064a" in n
        or bool(re.search(r"python code", n, re.I))
    )


def fetch_tab_csv(gid):
    return fetch_url(f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&gid={gid}")


# --------------------- universal multi-format story parser ------------------

META_MAP = {
    "story title": "title", "\\u0627\\u0644\\u0639\\u0646\\u0648\\u0627\\u0646": "title", "video title": "title",
    "title": "title", "\\u0639\\u0646\\u0648\\u0627\\u0646 \\u0627\\u0644\\u0641\\u064a\\u062f\\u064a\\u0648": "title",
    "logline": "logline", "\\u0627\\u0644\\u0641\\u0642\\u0631\\u0629 \\u0627\\u0644\\u062a\\u0639\\u0631\\u064a\\u0641\\u064a\\u0629": "logline",
    "genre": "genre", "\\u0627\\u0644\\u0646\\u0648\\u0639": "genre",
    "target duration": "duration", "\\u0627\\u0644\\u0645\\u062f\\u0629 \\u0627\\u0644\\u0645\\u0633\\u062a\\u0647\\u062f\\u0641\\u0629": "duration",
    "\\u0627\\u0644\\u0645\\u062f\\u0629": "duration", "duration": "duration",
    "hook": "hook", "\\u0627\\u0644\\u062e\\u0637\\u0627\\u0641 \\u0627\\u0644\\u062c\\u0627\\u0630\\u0628": "hook", "\\u0627\\u0644\\u062e\\u0637\\u0627\\u0641": "hook",
    "core lesson": "lesson", "\\u0627\\u0644\\u062f\\u0631\\u0633 \\u0627\\u0644\\u0623\\u0633\\u0627\\u0633\\u064a": "lesson", "\\u0627\\u0644\\u062f\\u0631\\u0633": "lesson",
    "complete voiceover narration": "narration", "\\u0627\\u0644\\u062a\\u0639\\u0644\\u064a\\u0642 \\u0627\\u0644\\u0635\\u0648\\u062a\\u064a \\u0627\\u0644\\u0643\\u0627\\u0645\\u0644": "narration",
}


def at(cells, i):
    return cells[i] if 0 <= i < len(cells) else ""


def row_meta(cells):
    for i in range(len(cells) - 1):
        label = re.sub(r"[::\\s]+$", "", cells[i]).strip().lower()
        if label and label in META_MAP and cells[i + 1]:
            return META_MAP[label], cells[i + 1].strip()
    return None


def row_concat_meta(cells):
    for i in range(len(cells) - 1):
        low = cells[i].lower()
        has_title = bool(re.search(r"\\u0639\\u0646\\u0648\\u0627\\u0646 \\u0627\\u0644\\u0641\\u064a\\u062f\\u064a\\u0648|story title", low)) or bool(
            re.match(r"title:", low)
        )
        joined = len(
            re.findall(r"\\u0639\\u0646\\u0648\\u0627\\u0646|duration|hook|\\u0627\\u0644\\u0645\\u062f\\u0629|\\u0627\\u0644\\u062e\\u0637\\u0627\\u0641|\\u0627\\u0644\\u062f\\u0631\\u0633|title", low)
        )
        if has_title and joined >= 3 and cells[i + 1] and len(cells[i + 1]) > 3:
            return "title", cells[i + 1].strip()
    return None


def row_section_anchor(cells):
    non_empty = [c for c in cells if c]
    if len(non_empty) > 2:
        return None
    for c in non_empty:
        m = re.match(
            r"^(.{4,120}?)\\s*\\((\\d+(?:\\.\\d+)?\\s*(?:seconds?|\\u062b\\u0627\\u0646\\u064a\\u0629|mins?|minutes?|\\u062f\\u0642\\u064a\\u0642\\u0629)[\\s\\S]*?)\\)$",
            c,
            re.I,
        )
        if m and not re.match(r"^\\d", m.group(1).strip()):
            return m.group(1).strip(), m.group(2).strip()
    return None


def split_concat_value(value):
    m = re.search(r"(\\d+)\\s*(?:\\u062b\\u0627\\u0646\\u064a\\u0629|seconds?)\\s*(?:\\(([^)]*)\\))?", value, re.I)
    if m:
        title = value[: m.start()].strip()
        duration = m.group(0).strip()
        hook = clean(value[m.end():], 400)
    else:
        title = clean(value, 160)
        duration = ""
        hook = ""
    return title, duration, hook


def detect_scene_header(cells):
    joined = " ".join(cells).lower()
    if "Scene #" in cells or "\\u0627\\u0644\\u0645\\u0634\\u0647\\u062f" in cells:
        return "story"
    if "Time / Scene" in cells or ("scene title" in joined and "voiceover" in joined):
        return "tracker"
    if "\\u0627\\u0644\\u062a\\u0648\\u0642\\u064a\\u062a" in cells and "\\u0639\\u0646\\u0648\\u0627\\u0646 \\u0627\\u0644\\u0645\\u0634\\u0647\\u062f" in joined:
        return "arabic"
    if "visual scene description" in joined and "duration" in joined:
        return "story"
    return None


def parse_scene_row(cells, fmt):
    c = [x.strip() for x in cells]
    if fmt == "story":
        if not c[0] or not re.match(r"(?i)^(?:scene\\s*\\d+|\\u0627\\u0644\\u0645\\u0634\\u0647\\u062f\\s*\\d*)$", c[0]):
            return None
        if not looks_like_time(at(c, 1)):
            return None
        return {
            "index": 0, "timeRange": at(c, 1), "visual": clean(at(c, 2), 900),
            "aiPrompt": clean(at(c, 3), 600), "voiceover": clean(at(c, 4), 1400), "sfx": clean(at(c, 5), 120),
        }
    if fmt in ("numbered", "arabic"):
        i = next((k for k, x in enumerate(c) if x), -1)
        if i < 0 or not re.match(r"^\\d{1,2}$", at(c, i)) or not looks_like_time(at(c, i + 1)):
            return None
        return {
            "index": int(at(c, i)), "timeRange": at(c, i + 1), "heading": clean(at(c, i + 2), 120),
            "visual": clean(at(c, i + 3), 900), "aiPrompt": clean(at(c, i + 2), 600),
            "voiceover": clean(at(c, i + 4), 1400), "sfx": "",
        }
    # tracker: [time, scene title, visual, voiceover]
    i = next((k for k, x in enumerate(c) if x), -1)
    if i < 0 or not looks_like_time(at(c, i)):
        return None
    return {
        "index": 0, "timeRange": at(c, i), "heading": clean(at(c, i + 1), 120),
        "visual": clean(at(c, i + 2), 900), "aiPrompt": clean(at(c, i + 1), 600),
        "voiceover": clean(at(c, i + 3), 1400), "sfx": "",
    }


PURE_DURATION_RE = re.compile(r"^(\\d+(?:\\.\\d+)?)\\s*(?:seconds?|secs?|\\u062b\\u0627\\u0646\\u064a\\u0629)\\s*(?:\\([^)]*\\))?$", re.I)


def parse_tab_stories(rows):
    """Parses ANY story tab into one or more stories (state machine)."""
    drafts = []
    state = {
        "title": "", "logline": "", "genre": "", "duration": "", "hook": "", "lesson": "",
        "narration": "", "scenes": [], "narration_anchor": False,
    }

    def new_draft():
        return {
            "title": "", "logline": "", "genre": "", "duration": "", "hook": "", "lesson": "",
            "narration": "", "scenes": [], "narration_anchor": False,
        }

    cur = new_draft()
    fmt = None
    in_narration = False
    pending = {"title": None, "duration": None, "hook": None, "lesson": None}

    def reset_pendings():
        pending.update({"title": None, "duration": None, "hook": None, "lesson": None})

    def pendings_ready():
        return pending["title"] is not None or pending["duration"] is not None

    def finalize():
        nonlocal cur
        if cur["title"] or cur["scenes"]:
            drafts.append(cur)
        cur = new_draft()

    def start_section():
        finalize()  # push the previous draft, then apply collected orphan rows to the FRESH one
        if pending["title"]:
            cur["title"] = clean(pending["title"], 160)
        if pending["duration"]:
            cur["duration"] = clean(pending["duration"], 60)
        if pending["hook"]:
            cur["hook"] = clean(pending["hook"], 400)
        if pending["lesson"]:
            cur["lesson"] = clean(pending["lesson"], 400)
        reset_pendings()

    for raw_row in rows:
        cells = [str(x or "").strip() for x in raw_row]

        if in_narration:
            line = " ".join([c for c in cells if c]).strip()
            if line:
                cur["narration"] = (cur["narration"] + " " if cur["narration"] else "") + clean(line, 800)
                continue
            in_narration = False

        concat = row_concat_meta(cells)
        if concat:
            if cur["scenes"] or pendings_ready():
                start_section()
            title, duration, hook = split_concat_value(concat[1])
            if title:
                cur["title"] = clean(title, 160)
            if duration:
                cur["duration"] = clean(duration, 60)
            if hook:
                cur["hook"] = clean(hook, 400)
            continue

        header_fmt = detect_scene_header(cells)
        if header_fmt:
            if pendings_ready():
                start_section()
            fmt = header_fmt
            in_narration = False
            continue

        scene = parse_scene_row(cells, fmt) if fmt else None
        if not scene:
            for sniff_fmt in ("numbered", "tracker"):
                scene = parse_scene_row(cells, sniff_fmt)
                if scene:
                    if not fmt:
                        fmt = sniff_fmt
                    break
        if scene:
            if pendings_ready():
                start_section()
            cur["scenes"].append(scene)
            continue

        meta = row_meta(cells)
        if meta:
            key, value = meta
            if key in ("title", "hook") and cur["scenes"]:
                finalize()
                reset_pendings()
            if key == "title":
                cur["title"] = clean(value, 160)
            elif key == "logline":
                cur["logline"] = clean(value, 400)
            elif key == "genre":
                cur["genre"] = clean(value, 80)
            elif key == "duration":
                cur["duration"] = clean(value, 60)
            elif key == "hook":
                cur["hook"] = clean(value, 400)
            elif key == "lesson":
                cur["lesson"] = clean(value, 400)
            elif key == "narration":
                in_narration = True
                if value and not re.match(r"^[-\\u2013\\u2014:]*$", value):
                    cur["narration"] = clean(value, 800)
            continue

        anchor = row_section_anchor(cells)
        if anchor:
            if cur["scenes"] or cur["title"] or pendings_ready():
                start_section()
            cur["title"] = clean(anchor[0], 160)
            cur["duration"] = clean(anchor[1], 60)
            continue

        non_empty_raw = [c for c in cells if c]
        if len(non_empty_raw) == 2:
            dur_idx = -1
            for k, x in enumerate(cells):
                if re.match(r"^\\d+\\s*(?:seconds?|\\u062b\\u0627\\u0646\\u064a\\u0629)", x, re.I) or re.match(
                    r"^\\d+\\s*(?:mins?|minutes?|\\u062f\\u0642\\u064a\\u0642\\u0629)", x, re.I
                ):
                    dur_idx = k
                    break
            if dur_idx > 0 and at(cells, dur_idx - 1) and not looks_like_time(at(cells, dur_idx - 1)):
                if cur["scenes"]:
                    finalize()
                    reset_pendings()
                cur["title"] = clean(at(cells, dur_idx - 1), 160)
                cur["duration"] = clean(at(cells, dur_idx), 60)
                continue

        if len(non_empty_raw) == 1:
            raw = non_empty_raw[0]
            if re.search(r"</?[a-z][\\s>]|gsap\\.|@keyframes|[{};]|\\.svg", raw, re.I):
                continue
            txt = clean(raw, 500)
            if not txt:
                continue
            if PURE_DURATION_RE.match(txt):
                if pending["duration"] is None:
                    pending["duration"] = txt
            elif not looks_like_time(txt) and len(txt) >= 4:
                if pending["title"] is None:
                    pending["title"] = txt
                elif pending["hook"] is None:
                    pending["hook"] = txt
                elif pending["lesson"] is None:
                    pending["lesson"] = txt
            continue
    finalize()

    # normalize + dedupe by title (prefer drafts with more scenes)
    by_title = {}
    order = []
    for d in drafts:
        st = normalize_draft(d)
        if not st:
            continue
        key = re.sub(r"\\s+", " ", st["title"].lower()).strip()
        if key not in by_title:
            by_title[key] = st
            order.append(key)
        elif len(st["scenes"]) > len(by_title[key]["scenes"]):
            by_title[key] = st
    return [by_title[k] for k in order]


def normalize_draft(d):
    if not d["scenes"]:
        return None
    title = clean(d["title"], 160) or "Untitled Story"
    logline = clean(d["hook"] or d["logline"] or d["lesson"], 400)
    narration = d["narration"] or " ".join([s["voiceover"] for s in d["scenes"] if s["voiceover"]])
    scenes = []
    for i, s in enumerate(d["scenes"], 1):
        sc = dict(s)
        sc["index"] = i
        scenes.append(sc)
    return {
        "title": title,
        "logline": logline,
        "genre": clean(d["genre"], 80),
        "duration": d["duration"] or duration_from_ranges(d["scenes"]) or "60 Seconds",
        "scenes": scenes,
        "narration": clean(narration, 4000),
        "language": detect_language(title + " " + narration),
    }


# ------------------------------- state / queue ------------------------------

def load_state():
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                data.setdefault("rendered", {})
                data.setdefault("failed", {})
                return data
        except Exception as e:
            print(f"[state] unreadable ({e}) - starting fresh", flush=True)
    return {"rendered": {}, "failed": {}}


def load_union_state():
    """Done-set across ALL workers: legacy state/videos.json + every shard file.
    All workers of a run check out the same commit, so this union (and therefore
    the pending queue below) is identical on every worker - the interleaved
    sharding in main() partitions it deterministically."""
    done = {"rendered": {}, "failed": {}}
    paths = [os.path.join(STATE_DIR, "videos.json")] + sorted(glob.glob(os.path.join(STATE_DIR, "videos.shard*.json")))
    for p in paths:
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            done["rendered"].update(data.get("rendered", {}))
            done["failed"].update(data.get("failed", {}))
        except Exception as e:
            print(f"[state] skipping unreadable {p}: {e}", flush=True)
    return done


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH) or ".", exist_ok=True)
    rendered = state.get("rendered", {})
    if len(rendered) > 400:
        keep = sorted(rendered.items(), key=lambda kv: kv[1].get("renderedAt", ""), reverse=True)[:400]
        state["rendered"] = dict(keep)
    state["failed"] = {
        h: v for h, v in state.get("failed", {}).items() if int(v.get("tries", 0)) < 3
    }
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)


def collect_stories():
    stories = []
    for tab in list_tabs():
        if is_code_tab(tab["name"]):
            continue
        try:
            rows = parse_csv(fetch_tab_csv(tab["gid"]))
        except Exception as e:
            print(f"[sheet] tab '{tab['name']}' unavailable: {e}", flush=True)
            continue
        found = parse_tab_stories(rows)
        for st in found:
            st["tabName"] = tab["name"]
        stories.extend(found)
        if found:
            print(f"[sheet] '{tab['name']}': {len(found)} stories", flush=True)
    return stories


def is_pending(st, state):
    h = st["_hash"]
    if h in state["rendered"]:
        return False
    f = state["failed"].get(h)
    if f and int(f.get("tries", 0)) >= 2:
        return False
    return True


# ------------------------- keyless AI polish (freellmpool) -------------------

POLISH_PROMPT = (
    "You are StoryPilot's script doctor for short vertical videos. "
    "Reply with ONE JSON object and nothing else. No markdown fences. Given a story, "
    "improve the voiceover lines for narration: tighten pacing, strengthen the opening "
    "hook, keep the SAME language and meaning, 1-3 spoken sentences per line. Also write "
    "platform metadata. Schema: "
    '{"voiceovers": [str, ...] (exactly one entry per scene, same order), '
    '"title": str (catchy, same language, max 80 chars), '
    '"description": str (2-3 sentences, same language), '
    '"tags": [str, ...] (8-12 short tags without #, same language)}'
)


def _valid_polish(data, scenes):
    """Validate a polish reply: one non-empty voiceover string per scene."""
    if not isinstance(data, dict):
        return False
    vs = data.get("voiceovers")
    if not isinstance(vs, list) or len(vs) != len(scenes):
        return False
    if not all(isinstance(v, str) and v.strip() for v in vs):
        return False
    data.setdefault("title", "")
    data.setdefault("description", "")
    data.setdefault("tags", [])
    return True


def llm7_chat(system, user, timeout=90):
    """KEYLESS OpenAI-compatible chat via llm7.io (no API key; works from
    GitHub runners - GLM-5.3-Flash is in its live catalog). Retries briefly
    on transient rate limits (429/5xx)."""
    import urllib.error
    body = json.dumps(
        {
            "model": LLM7_MODEL,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
    ).encode("utf-8")
    last_err = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(
                "https://api.llm7.io/v1/chat/completions",
                data=body,
                headers={"Content-Type": "application/json", "Authorization": "Bearer unused"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            return str(((data.get("choices") or [{}])[0].get("message") or {}).get("content", "") or "")
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code in (429, 500, 502, 503, 504) and attempt < 1:
                time.sleep(15)
                continue
            raise
        except Exception:
            raise
    raise RuntimeError(f"llm7 retries exhausted ({last_err})")


def ai_polish(story):
    """Keyless AI polish pass. Chain: freellmpool (FLP_MODEL first, then pool
    routes, then auto) -> llm7 direct (GLM-5.3-Flash, no key). Returns a dict
    or None (never raises) - the original sheet text is used on total failure."""
    if not AI_ENHANCE:
        return None
    scenes = story.get("scenes", [])
    if not scenes:
        return None
    compact = json.dumps(
        {
            "title": story.get("title", ""),
            "logline": story.get("logline", ""),
            "scenes": [{"visual": s.get("visual", ""), "voiceover": s.get("voiceover", "")} for s in scenes],
        },
        ensure_ascii=False,
    )
    prompt = f"Story:\\n{compact}\\n\\nPolish it exactly per the schema ({len(scenes)} scenes)."

    # --- route 1: freellmpool CLI (pool of keyless providers) ---
    exe = shutil.which("freellmpool")
    base = [exe] if exe else [sys.executable, "-m", "freellmpool"]
    attempts = []
    for m in [FLP_MODEL, "zhipu/glm-4.7-flash", "ovh/Qwen3-32B", "auto"]:
        if m and m not in attempts:
            attempts.append(m)
    for model in attempts:
        try:
            cmd = base + ["ask", "-m", model, "--json", "--timeout", "60", "-s", POLISH_PROMPT, prompt]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
            raw = (out.stdout or "") + (out.stderr or "")
            m2 = re.search(r"\{[\s\S]*\}", raw)
            if not m2:
                print(f"[polish] freellmpool {model}: no JSON ({raw.strip()[:90]})", flush=True)
                continue
            data = json.loads(m2.group(0))
            if not _valid_polish(data, scenes):
                continue
            data["model"] = f"freellmpool keyless ({model})"
            print(f"[polish] served by freellmpool model: {model}", flush=True)
            return data
        except Exception as e:
            print(f"[polish] freellmpool {model} failed: {str(e)[:100]}", flush=True)

    # --- route 2: llm7 direct (keyless, GLM-5.3-Flash) ---
    try:
        raw = llm7_chat(POLISH_PROMPT, prompt)
        m3 = re.search(r"\{[\s\S]*\}", raw)
        if m3:
            data = json.loads(m3.group(0))
            if _valid_polish(data, scenes):
                data["model"] = f"llm7 keyless ({LLM7_MODEL})"
                print(f"[polish] served by llm7 model: {LLM7_MODEL}", flush=True)
                return data
        print(f"[polish] llm7 reply unusable ({raw.strip()[:90]})", flush=True)
    except Exception as e:
        print(f"[polish] llm7 failed: {str(e)[:100]}", flush=True)

    print("[polish] all keyless routes failed - using original sheet text", flush=True)
    return None


def apply_polish(story):
    """Polish voiceovers in-place (hash stays keyed to the ORIGINAL sheet story)."""
    try:
        polish = ai_polish(story)
    except Exception as e:
        print(f"[polish] unexpected error: {e}", flush=True)
        polish = None
    if not polish:
        return None
    for s, v in zip(story["scenes"], polish["voiceovers"]):
        v = v.strip()
        if v:
            s["voiceover"] = v[:1400]
    info = {
        "title": str(polish.get("title", "")).strip()[:120],
        "description": str(polish.get("description", "")).strip()[:600],
        "tags": [str(t).strip() for t in polish.get("tags", []) if str(t).strip()][:12],
        "model": str(polish.get("model", "keyless ai")),
    }
    story["_polish"] = info
    return info


# --------------------------------- rendering --------------------------------

def render_one(story, out_dir):
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    payload = {k: v for k, v in story.items() if not k.startswith("_")}
    payload["_story_hash"] = story["_hash"]
    if story.get("_polish"):
        payload["_polish"] = story["_polish"]
    story_path = os.path.join(out_dir, "story.json")
    with open(story_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    env = dict(os.environ)
    env["STORY_PATH"] = story_path
    env["OUT_DIR"] = out_dir
    env["FRAME_RATE"] = FRAME_RATE
    r = subprocess.run(
        [sys.executable, "generate_video.py"],
        env=env, capture_output=True, text=True, timeout=SUBPROC_TIMEOUT,
    )
    tail = ((r.stdout or "") + (r.stderr or ""))[-1200:]
    print(tail, flush=True)
    if r.returncode != 0 or not os.path.exists(os.path.join(out_dir, "output.mp4")):
        raise RuntimeError(f"generate_video.py exit={r.returncode}: {tail[-300:]}")

    # keep only the deliverables in the artifact (drop kb_/seg_/cap_ intermediates)
    keep = {"output.mp4", "meta.json", "thumb.jpg", "story.json"}
    for name in os.listdir(out_dir):
        if name in keep:
            continue
        p = os.path.join(out_dir, name)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)


def main():
    t0 = time.time()
    os.makedirs(VIDEOS_DIR, exist_ok=True)
    os.makedirs(STATE_DIR, exist_ok=True)
    # my own shard file (what I write) + the union across all workers (what I skip)
    my_state = load_state()
    union = load_union_state() if NUM_SHARDS > 1 else my_state

    stories = collect_stories()
    if not stories:
        print("[queue] no stories found in any tab - nothing to do", flush=True)
        write_summary([], [], 0, 0, 0)
        return

    seen = set()
    queue_all = []
    for st in stories:
        h = story_hash(st)
        if h in seen:
            continue
        seen.add(h)
        st["_hash"] = h
        queue_all.append(st)

    pending_all = [st for st in queue_all if is_pending(st, union)]
    # interleaved sharding: story i belongs to worker i % NUM_SHARDS.
    # every worker computes the same pending_all (same checkout commit) so the
    # shards partition the queue with no overlap and no gaps.
    my_pending = [st for i, st in enumerate(pending_all) if i % NUM_SHARDS == SHARD_INDEX]
    print(
        f"[queue] worker {SHARD_INDEX}/{NUM_SHARDS}: {len(queue_all)} stories in the sheet | "
        f"{len(pending_all)} pending overall | {len(my_pending)} mine | "
        f"budget {BUDGET_MIN:.0f}m | max {MAX_VIDEOS}/worker | hyperframes {FRAME_RATE}fps | "
        f"AI polish {'on (freellmpool keyless)' if AI_ENHANCE else 'off'}",
        flush=True,
    )

    rendered, failed = [], []
    budget_sec = BUDGET_MIN * 60.0
    todo = my_pending if MAX_VIDEOS <= 0 else my_pending[:MAX_VIDEOS]
    for st in todo:
        elapsed = time.time() - t0
        if elapsed + RENDER_MARGIN_SEC > budget_sec:
            print(
                f"[queue] time budget nearly exhausted ({elapsed / 60:.1f}m used) - "
                f"deferring the rest to the next dispatch",
                flush=True,
            )
            break
        h = st["_hash"]
        slug = f"{len(rendered) + len(failed) + 1:02d}-{h[:8]}"
        out_dir = os.path.join(VIDEOS_DIR, slug)
        print(f"[render] ({len(rendered) + len(failed) + 1}/{len(todo)}) '{st['title']}' [{st['tabName']}]", flush=True)
        polish_info = apply_polish(st)
        if polish_info:
            print(f"[polish] AI title: {polish_info['title'][:60]}", flush=True)
        try:
            render_one(st, out_dir)
            my_state["rendered"][h] = {
                "title": st["title"],
                "tab": st["tabName"],
                "renderedAt": now_iso(),
                "fps": int(FRAME_RATE),
                "dir": slug,
                "worker": SHARD_INDEX,
                "aiPolish": bool(polish_info),
            }
            my_state["failed"].pop(h, None)
            rendered.append({"hash": h, "title": st["title"], "dir": slug, "tab": st["tabName"], "aiPolish": bool(polish_info)})
            save_state(my_state)  # persist progress after every video
        except Exception as e:
            msg = str(e)[:300]
            print(f"[render] FAILED '{st['title']}': {msg}", flush=True)
            prev = my_state["failed"].get(h, {})
            my_state["failed"][h] = {
                "title": st["title"], "error": msg, "at": now_iso(),
                "tries": int(prev.get("tries", 0)) + 1,
            }
            failed.append({"hash": h, "title": st["title"], "error": msg})
            save_state(my_state)

    pending_after = len([st for st in queue_all if is_pending(st, load_union_state() if NUM_SHARDS > 1 else my_state)])
    write_summary(rendered, failed, len(pending_all), pending_after, len(queue_all))
    save_state(my_state)
    print(
        f"[queue] worker {SHARD_INDEX} done: {len(rendered)} rendered, {len(failed)} failed, "
        f"{pending_after} still pending overall -> the continuous loop / next cron continues",
        flush=True,
    )


def write_summary(rendered, failed, pending_before, pending_after, total):
    data = {
        "worker": SHARD_INDEX,
        "num_shards": NUM_SHARDS,
        "rendered": rendered,
        "failed": failed,
        "pending_before": pending_before,
        "pending_after": pending_after,
        "total_stories": total,
        "fps": int(FRAME_RATE),
        "at": now_iso(),
    }
    os.makedirs(os.path.dirname(STATE_PATH) or ".", exist_ok=True)
    with open("batch_summary.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
`
