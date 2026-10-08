// Auto-generated from scripts/generate_story.py - do not edit by hand;
// regenerate with scripts/gen-bundle-templates.py
// Story source: Google Sheet (Gemini Spark director storyboard, 10 scenes + hook/lesson) -> keyless freellmpool/llm7 -> fallback
export const GENERATE_STORY_PY = `#!/usr/bin/env python3
"""StoryPilot - Hourly story source.

Primary : the Google Sheet that Gemini Spark updates every hour (tab 1 = story).
Optional: a fresh story generated KEYLESS via freellmpool (GLM Flash first,
          auto-failover to the keyless pool) when USE_AI_STORY=true or the
          sheet is unreachable.
Fallback: a built-in sample story so the pipeline never breaks.

Writes  : story.json (consumed by generate_video.py)
          sheet_code.py (the raw generator code from the sheet tab, reference only)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

SHEET_ID = os.environ.get("SHEET_ID", "__SHEET_ID__")
CODE_TAB = os.environ.get("CODE_TAB", "كود بايثون - المولد الآلي")
USE_AI_STORY = os.environ.get("USE_AI_STORY", "false").lower() in ("1", "true", "yes")
AI_ENHANCE = os.environ.get("AI_ENHANCE", "true").lower() in ("1", "true", "yes")
FLP_MODEL = os.environ.get("FLP_MODEL", "glm-4.7-flash")
LLM7_MODEL = os.environ.get("LLM7_MODEL", "GLM-5.3-Flash")
STORY_TOPIC = os.environ.get("STORY_TOPIC", "").strip()
STORY_JSON = os.environ.get("STORY_JSON", "").strip()
OUT = os.environ.get("STORY_PATH", "story.json")
UA = {"User-Agent": "Mozilla/5.0 (compatible; StoryPilotAgent/1.0)"}

FALLBACK_STORY = {
    "title": "The Lighthouse That Counted Storms",
    "logline": "A lonely lighthouse keeper discovers his lamp flickers once for every ship the storm plans to take.",
    "genre": "Sci-Fi Mystery / Fantasy",
    "duration": "60 Seconds",
    "language": "en",
    "scenes": [
        {"index": 1, "timeRange": "0:00 - 0:10", "visual": "Waves hammer a black rock lighthouse at dusk; an old keeper climbs the spiral stairs with a storm lantern.", "aiPrompt": "Cinematic wide shot, stormy sea, gothic lighthouse, rain, moody blue palette, photorealistic", "voiceover": "Every keeper before him heard the sea speak. He was the first to hear it count.", "sfx": "thunder, rain on glass"},
        {"index": 2, "timeRange": "0:10 - 0:25", "visual": "The great lamp flares once, unbidden. The keeper looks at a logbook where every past flare is inked beside a lost ship.", "aiPrompt": "Macro shot of antique logbook, candlelight, inked ship names, tense atmosphere", "voiceover": "One flare. He checked the log. One flare meant one ship would not come home.", "sfx": "creaking iron, wind"},
        {"index": 3, "timeRange": "0:25 - 0:45", "visual": "He fights the storm to the lamp room and dims the light himself, standing in the dark while the sea screams.", "aiPrompt": "Dramatic silhouette, keeper shutting off lighthouse beam, lightning, vertical composition", "voiceover": "So he did what no keeper had dared. He turned off the light.", "sfx": "storm swell"},
        {"index": 4, "timeRange": "0:45 - 0:60", "visual": "Dawn. Calm water. Three fishing boats sail home under a pink sky; the keeper sleeps against the cold lamp.", "aiPrompt": "Sunrise over calm sea, fishing boats returning, warm pink and gold, hopeful", "voiceover": "At dawn, three boats came home. The sea had lost count... and so had the storm.", "sfx": "gentle waves, gulls"},
    ],
    "narration": "Every keeper before him heard the sea speak. He was the first to hear it count. One flare meant one ship would not come home. So he turned off the light. At dawn, three boats came home.",
}


def fetch_url(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_csv(text):
    rows, row, cell, q = [], [], "", False
    for i, c in enumerate(text):
        if q:
            if c == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    cell += '"'
                else:
                    q = False
            else:
                cell += c
        elif c == '"':
            q = True
        elif c == ",":
            row.append(cell); cell = ""
        elif c == "\\n":
            row.append(cell); rows.append(row); row = []; cell = ""
        elif c != "\\r":
            cell += c
    if cell or row:
        row.append(cell); rows.append(row)
    return rows


def detect_language(t):
    ar = len(re.findall(r"[\\u0600-\\u06FF]", t))
    la = len(re.findall(r"[A-Za-z]", t))
    return "ar" if ar > la else "en"


def map_columns(header_cells):
    """Map scene-table columns by keyword (old and updated Spark formats)."""
    keys = {
        "time": ["time", "duration", "المدة", "وقت", "مدة"],
        "visual": ["visual", "scene desc", "وصف", "المشهد", "مشهد", "scene"],
        "prompt": ["prompt", "ai", "برومبت", "image", "صورة"],
        "voiceover": ["voiceover", "voice", "narration", "التعليق", "الصوتي", "الحوار", "صوت"],
        "sfx": ["sfx", "audio", "المؤثرات", "صوتيات"],
    }
    skip_exact = ("scene", "scene #", "#", "رقم", "المشهد", "عدد", "index", "no.")
    m = {}
    for idx, c in enumerate(header_cells):
        cl = (c or "").strip().lower()
        if not cl or cl.strip(":#. ") in skip_exact:
            continue  # the scene-number column is not content
        for field, names in keys.items():
            if field not in m and any(n in cl for n in names):
                m[field] = idx
    return m


def looks_like_header(cells):
    first = (cells[0] if cells else "").strip().lower().rstrip(":# ")
    if first in ("scene", "scene #", "المشهد", "رقم", "#"):
        return True
    return len(map_columns(cells)) >= 2


def story_from_sheet():
    base = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
    csv_text = fetch_url(f"{base}/export?format=csv")
    rows = parse_csv(csv_text)
    story = {"title": "Untitled Story", "logline": "", "genre": "", "duration": "60 Seconds", "scenes": [], "narration": ""}
    header_idx, narration_idx, colmap = None, None, {}
    for i, r in enumerate(rows):
        cells = [c.strip() for c in r]
        first_raw = (cells[0] if cells else "").strip()
        first = first_raw.rstrip(":").lower()
        # tolerant label matching - survives Spark automation format updates
        if len(cells) > 1 and cells[1]:
            if first in ("story title", "title") or "عنوان" in first_raw or "title" in first:
                story["title"] = cells[1]
            elif "logline" in first or "الفقرة التعريفية" in first_raw or "الملخص" in first_raw:
                story["logline"] = cells[1]
            elif "genre" in first or "النوع" in first_raw:
                story["genre"] = cells[1]
            elif "duration" in first or "المدة" in first_raw:
                story["duration"] = cells[1]
        if cells and looks_like_header(cells) and len(" ".join(cells)) < 220:
            header_idx = i
            colmap = map_columns(cells)
        joined = " ".join(cells)
        if "Complete Voiceover Narration" in joined or "التعليق الصوتي الكامل" in joined:
            narration_idx = i
    if header_idx is not None:
        cmap = colmap or {"time": 1, "visual": 2, "prompt": 3, "voiceover": 4, "sfx": 5}
        for i in range(header_idx + 1, len(rows)):
            if narration_idx is not None and i >= narration_idx:
                break
            cells = [c.strip() for c in rows[i]]
            if not cells or not cells[0] or not any(cells[1:]):
                continue
            def g(field, default=""):
                idx = cmap.get(field)
                return cells[idx] if idx is not None and idx < len(cells) else default
            story["scenes"].append({
                "index": len(story["scenes"]) + 1,
                "timeRange": g("time"),
                "visual": g("visual"),
                "aiPrompt": g("prompt"),
                "voiceover": g("voiceover"),
                "sfx": g("sfx"),
            })
    if narration_idx is not None:
        parts = []
        for i in range(narration_idx + 1, len(rows)):
            line = " ".join(c.strip() for c in rows[i] if c.strip())
            if line:
                parts.append(line)
        story["narration"] = " ".join(parts)
    if not story["narration"] and story["scenes"]:
        story["narration"] = " ".join(s["voiceover"] for s in story["scenes"] if s["voiceover"])
    story["language"] = detect_language(story["title"] + " " + story["narration"])
    if not story["scenes"]:
        raise ValueError("sheet has no scene rows")
    return story


def save_sheet_code():
    """Also save the raw Python code tab from the sheet (reference)."""
    try:
        base = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
        url = f"{base}/gviz/tq?tqx=out:csv&sheet={urllib.parse.quote(CODE_TAB)}"
        rows = parse_csv(fetch_url(url))
        lines = []
        started = False
        for r in rows:
            cell = r[1] if len(r) > 1 else ""
            if not started and (cell.startswith("import ") or cell.startswith("#!")):
                started = True
            if started:
                lines.append(cell)
        if lines:
            with open("sheet_code.py", "w", encoding="utf-8") as f:
                f.write("\\n".join(lines))
            print(f"[story] saved sheet generator code ({len(lines)} lines) -> sheet_code.py", flush=True)
    except Exception as e:
        print(f"[story] sheet code tab not saved: {e}", flush=True)


SYSTEM_PROMPT = (
    "You are StoryPilot, an expert short-form video scriptwriter. "
    "Reply with ONE JSON object and nothing else. No markdown fences. Schema: "
    '{"title": str, "logline": str, "genre": str, "duration": "60 Seconds", '
    '"scenes": [{"timeRange": str, "visual": str, "aiPrompt": str, "voiceover": str, "sfx": str}] , '
    '"narration": str}. Exactly 4-6 scenes, each voiceover is 1-3 spoken sentences, '
    "visual is one cinematic sentence, aiPrompt is a short image-generation prompt. "
    "Match the language of the topic."
)


def story_from_freellmpool():
    topic = STORY_TOPIC or "a surprising 60-second micro-story with a twist ending, cinematic and emotional"
    prompt = f"Write a fresh hourly vertical-video story about: {topic}"
    exe = shutil.which("freellmpool")
    base = [exe] if exe else [sys.executable, "-m", "freellmpool"]
    # Try the configured model first (e.g. a GLM Flash route), then fail over to
    # guaranteed-keyless pool routes. "auto" lets freellmpool pick a live keyless model.
    attempts = []
    for m in [FLP_MODEL, "zhipu/glm-4.7-flash", "ovh/Qwen3-32B", "auto"]:
        if m and m not in attempts:
            attempts.append(m)
    last_err = ""
    for model in attempts:
        cmd = base + [
            "ask", "-m", model, "--json", "--timeout", "90",
            "-s", SYSTEM_PROMPT, prompt,
        ]
        print(f"[story] trying freellmpool model: {model}", flush=True)
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            last_err = f"{model}: timed out"
            print(f"[story] {last_err}", flush=True)
            continue
        raw = (out.stdout or "") + (out.stderr or "")
        m2 = re.search(r"\\{[\\s\\S]*\\}", raw)
        if not m2:
            last_err = f"{model}: no JSON in reply ({raw[:160]})"
            print(f"[story] {last_err}", flush=True)
            continue
        try:
            data = json.loads(m2.group(0))
        except json.JSONDecodeError:
            last_err = f"{model}: unparseable JSON"
            print(f"[story] {last_err}", flush=True)
            continue
        if not data.get("scenes"):
            last_err = f"{model}: no scenes"
            print(f"[story] {last_err}", flush=True)
            continue
        data.setdefault("duration", "60 Seconds")
        data["language"] = detect_language(json.dumps(data, ensure_ascii=False))
        for i, s in enumerate(data["scenes"], 1):
            s.setdefault("index", i)
            s.setdefault("timeRange", f"scene {i}")
        print(f"[story] served by: {model}", flush=True)
        return data
    # llm7 direct fallback (keyless GLM-5.3-Flash) when the whole pool is down
    try:
        raw = llm7_chat(SYSTEM_PROMPT, prompt)
        m3 = re.search(r"{[sS]*}", raw)
        if m3:
            data = json.loads(m3.group(0))
            if data.get("scenes"):
                data.setdefault("duration", "60 Seconds")
                data["language"] = detect_language(json.dumps(data, ensure_ascii=False))
                for i, s in enumerate(data["scenes"], 1):
                    s.setdefault("index", i)
                    s.setdefault("timeRange", f"scene {i}")
                print(f"[story] served by: llm7 ({LLM7_MODEL})", flush=True)
                return data
    except Exception as e:
        print(f"[story] llm7 fallback failed: {str(e)[:100]}", flush=True)
    raise ValueError(f"all freellmpool attempts failed ({last_err})")


def story_from_payload():
    """Full story JSON provided by the StoryPilot app (any sheet tab, any format).
    May carry _story_hash (stable library matching) and _polish (app-side GLM
    enhancement via the z.ai SDK) which pass straight through."""
    data = json.loads(STORY_JSON)
    if not data.get("title") or not data.get("scenes"):
        raise ValueError("payload missing title/scenes")
    data.setdefault("duration", "60 Seconds")
    data.setdefault("narration", " ".join(s.get("voiceover", "") for s in data["scenes"]))
    data["language"] = data.get("language") or detect_language(data["title"] + " " + data["narration"])
    for i, s in enumerate(data["scenes"], 1):
        s.setdefault("index", i)
        s.setdefault("timeRange", f"scene {i}")
        s.setdefault("visual", "")
        s.setdefault("aiPrompt", "")
        s.setdefault("voiceover", "")
        s.setdefault("sfx", "")
    return data


def _valid_polish(data, scenes):
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


def _apply_polish(story, data, model_label):
    scenes = story["scenes"]
    for s, v in zip(scenes, data["voiceovers"]):
        if v.strip():
            s["voiceover"] = v.strip()[:1400]
    story["_polish"] = {
        "title": str(data.get("title") or story.get("title", "")).strip()[:120],
        "description": str(data.get("description", "")).strip()[:600],
        "tags": [str(t).strip() for t in data.get("tags", []) if str(t).strip()][:12],
        "model": model_label,
    }
    return story


def ai_polish_story(story):
    """Keyless AI polish (single-story mode). Chain: freellmpool -> llm7 direct
    (GLM-5.3-Flash, no key). Never raises; returns the story polished or unchanged."""
    if not AI_ENHANCE or story.get("_polish"):
        return story  # already polished app-side (GLM) or disabled
    scenes = story.get("scenes", [])
    if not scenes:
        return story
    compact = json.dumps(
        {
            "title": story.get("title", ""),
            "logline": story.get("logline", ""),
            "scenes": [{"visual": s.get("visual", ""), "voiceover": s.get("voiceover", "")} for s in scenes],
        },
        ensure_ascii=False,
    )
    prompt = f"Story:\\n{compact}\\n\\nPolish it exactly per the schema ({len(scenes)} scenes)."

    # --- route 1: freellmpool CLI ---
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
            m2 = re.search(r"{[sS]*}", raw)
            if not m2:
                print(f"[polish] freellmpool {model}: no JSON ({raw.strip()[:90]})", flush=True)
                continue
            data = json.loads(m2.group(0))
            if _valid_polish(data, scenes):
                print(f"[polish] served by freellmpool model: {model}", flush=True)
                return _apply_polish(story, data, f"freellmpool keyless ({model})")
        except Exception as e:
            print(f"[polish] freellmpool {model} failed: {str(e)[:100]}", flush=True)

    # --- route 2: llm7 direct (keyless GLM-5.3-Flash) ---
    try:
        raw = llm7_chat(POLISH_PROMPT, prompt)
        m3 = re.search(r"{[sS]*}", raw)
        if m3:
            data = json.loads(m3.group(0))
            if _valid_polish(data, scenes):
                print(f"[polish] served by llm7 model: {LLM7_MODEL}", flush=True)
                return _apply_polish(story, data, f"llm7 keyless ({LLM7_MODEL})")
        print(f"[polish] llm7 reply unusable ({raw.strip()[:90]})", flush=True)
    except Exception as e:
        print(f"[polish] llm7 failed: {str(e)[:100]}", flush=True)

    print("[polish] all keyless routes failed - using original text", flush=True)
    return story


def main():
    story = None
    source = "none"
    if STORY_JSON:
        try:
            story = story_from_payload()
            source = "storypilot library payload"
        except Exception as e:
            print(f"[story] STORY_JSON invalid ({e}); falling back to sheet", flush=True)
    if story is None and not USE_AI_STORY:
        try:
            story = story_from_sheet()
            source = "google-sheet (gemini spark hourly)"
        except Exception as e:
            print(f"[story] sheet unavailable: {e}", flush=True)
    if story is None:
        try:
            story = story_from_freellmpool()
            source = f"freellmpool keyless ({FLP_MODEL} first, auto-failover)"
        except Exception as e:
            print(f"[story] freellmpool failed: {e}", flush=True)
            story = FALLBACK_STORY
            source = "built-in fallback"
    elif source != "storypilot library payload":
        # sheet story (not an app payload) - keyless AI polish of the narration
        story = ai_polish_story(story)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(story, f, ensure_ascii=False, indent=2)
    if source != "storypilot library payload":
        save_sheet_code()
    print(f"[story] source = {source}", flush=True)
    print(f"[story] '{story.get('title')}' | {len(story.get('scenes', []))} scenes -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
`
