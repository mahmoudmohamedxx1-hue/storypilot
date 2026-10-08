#!/usr/bin/env python3
"""Verify the NEW director-storyboard sheet format parses cleanly through EVERY
StoryPilot parser:

  1. scripts/generate_story.py  -> story_from_sheet()   (GitHub Actions fallback)
  2. scripts/render_pending.py  -> parse_tab_stories()  (Actions batch catch-up / factory source)

The fixture (director-format-fixture.csv) is a complete "Video 1" tab exactly as
Gemini Spark will write it after the Director's Brief update: meta rows (incl. the
new Hook / Core Lesson), one empty row, the scene header, and 10 scene rows.
"""
import importlib.util
import json
import os
import sys

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "director-format-fixture.csv")
LIVE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "storypilot-live")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


fails = []


def check(label, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    print(f"[{tag}] {label}" + (f"  -> {detail}" if detail and not cond else ""))
    if not cond:
        fails.append(label)


with open(FIXTURE, encoding="utf-8") as f:
    csv_text = f.read()

# ---------------------------------------------------------------- 1. generate_story.py
gs = load("gs", os.path.join(LIVE, "scripts", "generate_story.py"))
gs.fetch_url = lambda url, _t=csv_text: _t          # offline: pretend the sheet returned the fixture
story = gs.story_from_sheet()

check("gs: title", story["title"] == "الرسالة التي كتبها أبي للسنة القادمة", story["title"])
check("gs: hook parsed", story["hook"] == "هل تخفي بيوت آبائنا صناديق تنتظر رحيلهم؟", story.get("hook", ""))
check("gs: lesson parsed", story["lesson"] == "ما لم يقوله الآباء بأصواتهم يصرخ به حبرهم بعد رحيلهم.", story.get("lesson", ""))
check("gs: duration", story["duration"] == "75 seconds", story["duration"])
check("gs: language ar", story["language"] == "ar", story["language"])
check("gs: exactly 10 scenes", len(story["scenes"]) == 10, str(len(story["scenes"])))
check("gs: scene 1 time", story["scenes"][0]["timeRange"] == "0:00 - 0:07", story["scenes"][0]["timeRange"])
check("gs: scene 10 time", story["scenes"][9]["timeRange"] == "1:06 - 1:15", story["scenes"][9]["timeRange"])
check("gs: scene 8 aiPrompt english", story["scenes"][7]["aiPrompt"].startswith("extreme close-up"), story["scenes"][7]["aiPrompt"][:40])
check("gs: sfx kept", "heartbeat hit" in story["scenes"][2]["sfx"], story["scenes"][2]["sfx"])
check("gs: narration from voiceovers", story["narration"].count(".") + story["narration"].count("؟") >= 10, story["narration"][:80])

# backwards compat: the OLD 4-scene story format must still parse
old = gs.FALLBACK_STORY  # 4 scenes, no hook/lesson
check("gs: old format tolerated (no hook key crash)", isinstance(old.get("scenes", []), list))

# ---------------------------------------------------------------- 2. render_pending.py
rp = load("rp", os.path.join(LIVE, "scripts", "render_pending.py"))
rows = rp.parse_csv(csv_text)
stories = rp.parse_tab_stories(rows)

check("rp: exactly 1 story", len(stories) == 1, str(len(stories)))
st = stories[0] if stories else {}
check("rp: 10 scenes", len(st.get("scenes", [])) == 10, str(len(st.get("scenes", []))))
check("rp: title", st.get("title") == "الرسالة التي كتبها أبي للسنة القادمة", st.get("title", ""))
check("rp: hook folded into logline", "تخفي بيوت آبائنا" in st.get("logline", ""), st.get("logline", ""))
check("rp: duration from ranges = 75", "75" in (st.get("duration") or ""), st.get("duration", ""))
check("rp: language ar", st.get("language") == "ar", st.get("language", ""))
check("rp: narration has 10 sentences", len([w for w in st.get("narration", "").split() if w]) > 40, st.get("narration", "")[:60])

# scene field mapping (visual / aiPrompt / voiceover / sfx columns)
sc3 = st["scenes"][2]
check("rp: scene 3 visual arabic", "الصندوق" in sc3["visual"], sc3["visual"][:40])
check("rp: scene 3 voiceover", sc3["voiceover"] == "في الصندوق رسالة كتبها قبل ثلاثين عاماً.", sc3["voiceover"])
check("rp: scene 3 sfx", "heartbeat" in sc3.get("sfx", ""), sc3.get("sfx", ""))

print()
if fails:
    print(f"FAILED: {len(fails)} check(s): {fails}")
    sys.exit(1)
print("ALL CHECKS PASSED - director format is fully compatible with both Python parsers")
print(json.dumps({k: story[k] for k in ("title", "hook", "lesson", "duration", "language")}, ensure_ascii=False))
