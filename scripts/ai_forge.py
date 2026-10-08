#!/usr/bin/env python3
"""StoryPilot - AI Hyperframe Forge.

THE KEYLESS AI WRITES THE HYPERFRAME CODE THAT IS RENDERED AFTER THAT.

For every story, the forge asks a KEYLESS AI (freellmpool pool first, then the
always-open Pollinations text API - no API keys anywhere) to write a COMPLETE
Python renderer script for that specific story:

    story.json ---(keyless AI writes)---> ai_renderer.py --(sandbox run)---> output.mp4
                                              ^            |
                                              `-- repair --'  (stderr fed back to the AI)

Pipeline per story:
  1. ask the keyless AI for a full 1080x1920 @ FRAME_RATE (60) hyperframe script
     obeying the exact same env contract as generate_video.py (STORY_PATH/OUT_DIR/FRAME_RATE)
  2. py_compile it, run it in a sandboxed subprocess (timeout, captured output)
  3. validate the result with ffprobe (size, 1080x1920, >=30fps, has audio, sane duration)
  4. on ANY failure: feed the error tail back to the AI and ask it to REPAIR
     its own script (AI_ATTEMPTS times, default 3)
  5. if every AI attempt fails, fall back to the battle-tested built-in
     generate_video.py so a video ALWAYS gets produced

The model that actually wrote the code is recorded in meta.json/renderer.
"""
import json
import os
import py_compile
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

AI_ATTEMPTS = int(os.environ.get("AI_ATTEMPTS", "3"))
RENDER_TIMEOUT = int(os.environ.get("RENDER_TIMEOUT", "900"))          # per AI script run
CHAT_TIMEOUT = int(os.environ.get("CHAT_TIMEOUT", "300"))              # per AI chat call
FLP_ENABLED = os.environ.get("FLP_ENABLED", "true").lower() in ("1", "true", "yes")
# The pool's live catalog drifts (GLM/Qwen routes come and go) - "auto" lets
# freellmpool pick a healthy keyless model, named coders are tried after it.
FLP_MODELS = []
for _m in [os.environ.get("FLP_MODEL", "auto"), "auto", "ovh/gpt-oss-120b",
           "ovh/Qwen3-Coder-30B-A3B-Instruct", "kilo/openrouter/free"]:
    if _m and _m not in FLP_MODELS:
        FLP_MODELS.append(_m)
POLLINATIONS_MODELS = [m for m in [
    os.environ.get("POLLINATIONS_MODEL", ""), "openai"] if m]
POLLINATIONS_URL = os.environ.get("POLLINATIONS_URL", "https://text.pollinations.ai/openai")
MAX_TOKENS = int(os.environ.get("AI_MAX_TOKENS", "8000"))

DEBUG = os.environ.get("AI_FORGE_DEBUG", "")


def log(msg):
    print(f"[forge] {msg}", flush=True)


# --------------------------------------------------------------------------
# Keyless AI chat - freellmpool CLI chain first, Pollinations text API second
# --------------------------------------------------------------------------

def _freellmpool_chat(prompt, system, model):
    """One freellmpool CLI call. Returns reply text or raises.

    Runs the CLI in its OWN process group and kills the whole tree on timeout -
    freellmpool may fork pool workers that inherit the stdout pipe, and a
    plain subprocess.run(timeout=...) kill would leave them holding the pipe
    (which stalls the factory until the job timeout).
    """
    exe = shutil.which("freellmpool")
    base = [exe] if exe else [sys.executable, "-m", "freellmpool"]
    cmd = base + ["ask", "-m", model, "--json", "--timeout", "90", "-s", system, prompt]
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
    except FileNotFoundError as e:
        raise RuntimeError(f"freellmpool {model}: {e}")
    try:
        out, err = p.communicate(timeout=150)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except Exception:
            p.kill()
        try:
            out, err = p.communicate(timeout=10)
        except Exception:
            out, err = "", ""
        raise RuntimeError(f"freellmpool {model}: timed out after 150s (tree killed)")
    raw = (out or "") + (err or "")
    if p.returncode != 0 or not raw.strip():
        raise RuntimeError(f"freellmpool {model}: rc={p.returncode} {raw[:150]}")
    # --json emits {"content": ...} on success but errors may wrap it; be tolerant
    try:
        data = json.loads(raw)
        if isinstance(data, dict) and data.get("content"):
            return str(data["content"])
    except json.JSONDecodeError:
        pass
    return raw  # plain text reply


def _pollinations_chat(prompt, system, model):
    """One keyless Pollinations OpenAI-compatible call. Returns text or raises."""
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": MAX_TOKENS,
        "temperature": 0.7,
        # gpt-oss burns the token budget on hidden reasoning unless told not to
        "reasoning_effort": "low",
    }).encode("utf-8")
    req = urllib.request.Request(
        POLLINATIONS_URL, data=body,
        headers={"Content-Type": "application/json", "User-Agent": "StoryPilotForge/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=CHAT_TIMEOUT) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:
            pass
        raise RuntimeError(f"pollinations {model}: HTTP {e.code} {detail}")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError(f"pollinations {model}: non-JSON reply {raw[:160]}")
    if not isinstance(data, dict) or "choices" not in data:
        raise RuntimeError(f"pollinations {model}: unexpected body {raw[:160]}")
    msg = (data.get("choices") or [{}])[0].get("message") or {}
    text = msg.get("content") or ""
    if not text.strip():
        raise RuntimeError(f"pollinations {model}: empty content {raw[:160]}")
    return text


def keyless_chat(prompt, system):
    """Ask the keyless AI. Tries every freellmpool route, then Pollinations.

    Returns (text, route) or raises RuntimeError with all route errors.
    """
    errors = []
    routes = []
    if FLP_ENABLED:
        routes += [("freellmpool", m) for m in FLP_MODELS]
    routes += [("pollinations", m) for m in POLLINATIONS_MODELS]
    for kind, model in routes:
        label = f"{kind}:{model}"
        try:
            log(f"asking keyless AI ... {label}")
            t0 = time.time()
            if kind == "freellmpool":
                text = _freellmpool_chat(prompt, system, model)
            else:
                text = _pollinations_chat(prompt, system, model)
            dt = time.time() - t0
            log(f"served by {label} ({dt:.0f}s, {len(text)} chars)")
            return text, label
        except Exception as e:
            msg = f"{label}: {str(e)[:200]}"
            errors.append(msg)
            log(f"route failed - {msg}")
    raise RuntimeError("all keyless AI routes failed: " + " | ".join(errors))


def extract_code_block(text):
    """Pull the biggest fenced python code block out of an AI reply."""
    blocks = re.findall(r"```(?:python|py)?\s*([\s\S]*?)```", text)
    if not blocks:
        # model sometimes returns bare code - accept if it looks like a script
        stripped = text.strip()
        if "import " in stripped and "def " in stripped:
            return stripped
        return None
    return max(blocks, key=len).strip()


# Progressive repairs for the usual LLM JSON sins. Each repair is only tried
# when the previous parse failed, so well-formed replies take the fast path.
_RE_TRAILING_COMMA = re.compile(r",\s*([}\]])")
_RE_MISSING_COMMA = re.compile(r'(["\]\}\w])\s*\n(\s*["{\[])')  # "v"\n"k" / }\n{ / 100\n"
_SMART_QUOTES = {"\u201c": '"', "\u201d": '"', "\u201e": '"', "\u00ab": '"', "\u00bb": '"'}


def _json_repair_chain(s):
    """Yield progressively-repaired copies of a possibly-broken JSON document."""
    yield s
    no_tc = _RE_TRAILING_COMMA.sub(r"\1", s)          # trailing commas
    yield no_tc
    norm = s
    for bad, good in _SMART_QUOTES.items():            # smart quotes -> ascii
        norm = norm.replace(bad, good)
    yield norm
    norm_ntc = _RE_TRAILING_COMMA.sub(r"\1", norm)
    yield norm_ntc
    yield _RE_MISSING_COMMA.sub(r'\1,\n\2', norm_ntc)  # missing commas between lines
    yield _RE_MISSING_COMMA.sub(r'\1,\n\2', no_tc)
    for base in (norm_ntc, s):                         # truncated tail -> close brackets
        fixed = _balance_truncated(base)
        if fixed:
            yield fixed


def _balance_truncated(s):
    """Append the missing }/] closers when the JSON was cut mid-document."""
    if s.count('"') % 2:                               # cut mid-string - close it
        s = s + '"'
    blanked = re.sub(r'"(?:[^"\\]|\\.)*"', '""', s)    # brackets in strings don't count
    stack = []
    for ch in blanked:
        if ch in "{[":
            stack.append(ch)
        elif ch == "}" and stack and stack[-1] == "{":
            stack.pop()
        elif ch == "]" and stack and stack[-1] == "[":
            stack.pop()
    if not stack:
        return None
    return s + "".join("}" if c == "{" else "]" for c in reversed(stack))


def extract_json(text):
    """Pull the first JSON object out of an AI reply (tolerant).

    Handles code fences, prose around the JSON, trailing commas, smart
    quotes, missing commas between lines and truncated tails - each fix is
    attempted only after the plain parse fails.
    """
    if not text or not text.strip():
        raise ValueError("empty reply")
    body = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", body)
    if fence:                                           # prefer a fenced block
        body = fence.group(1)
    start, end = body.find("{"), body.rfind("}")
    if start < 0:
        raise ValueError("no JSON object in reply")
    # try the FULL tail first (lossless for truncated replies - the
    # raw_decode salvage strips trailing prose), then the {}-sliced view
    # (prose after the JSON can never amputate a truncated tail then)
    snippets = [body[start:]]
    if end > start:
        snippets.append(body[start:end + 1])
    first_err = None
    for snippet in snippets:
        for cand in _json_repair_chain(snippet):
            try:
                data = json.loads(cand)
                if isinstance(data, dict):
                    return data
            except Exception as e:
                first_err = first_err or e
                try:                                        # salvage: first complete
                    data, _ = json.JSONDecoder().raw_decode(cand)  # object, ignore
                    if isinstance(data, dict):                    # trailing junk
                        return data
                except Exception:
                    pass
    raise ValueError("unparseable JSON reply: " + str(first_err)[:160])


# --------------------------------------------------------------------------
# The hyperframe code-writer prompt (the contract the AI code must obey)
# --------------------------------------------------------------------------

CODEWRITER_SYSTEM = """You are HyperframeForge, an elite Python video-rendering engineer for StoryPilot.
You write COMPLETE, self-contained, production-ready Python 3.11 scripts that render ONE vertical
story video at 1080x1920 and 60 fps ("hyperframes" - silky continuous motion), and you ALWAYS
produce a working script.

ENV CONTRACT your script MUST obey (the pipeline depends on it):
1. Read environment variables at startup:
   STORY_PATH = path to story.json (the story to render)
   OUT_DIR    = output directory (already exists - write everything there)
   FRAME_RATE = fps (default 60)
   TTS_VOICE_AR / TTS_VOICE_EN = Edge-TTS voices (defaults ar-EG-ShakirNeural / en-US-ChristopherNeural)
2. Write ALL of these files, then exit with code 0:
   OUT_DIR/output.mp4  -> 1080x1920, FRAME_RATE fps, H.264 video + AAC audio, +faststart
   OUT_DIR/thumb.jpg   -> a beautiful 1080x1920 JPEG title frame
   OUT_DIR/meta.json   -> {"title": str, "duration_sec": float, "fps": int, "width": 1080,
                           "height": 1920, "renderer": "ai-hyperframe", "story_hash": story.get("_story_hash", "")}
3. Print progress with print(..., flush=True). NEVER call sys.exit(nonzero) after a good render.

story.json shape (director's storyboard - typically 10 scenes, 60-90 s total):
  {"title": str, "logline": str, "hook": str (opening hook line), "lesson": str (takeaway),
   "genre": str, "duration": "75 Seconds", "language": "ar" or "en", "narration": str,
   "_story_hash": str,
   "scenes": [{"index": 1, "timeRange": "0:00-0:07", "visual": str, "aiPrompt": str,
               "voiceover": str, "sfx": str}, ...]}

TOOLS AVAILABLE (already installed, use them):
- ffmpeg + ffprobe on PATH
- PIL (Pillow) 10+, numpy
- edge-tts is ASYNC - use EXACTLY this pattern, NEVER wrap it in subprocess or python -c:
    import asyncio, edge_tts
    async def _tts(text, path, voice):
        await edge_tts.Communicate(text, voice).save(path)
    asyncio.run(_tts("your narration text", "voice.mp3", "ar-EG-ShakirNeural"))
  Do NOT pass arbitrary text through f-strings into subprocess calls - that breaks on quotes.
- moviepy 2.x ONLY: "from moviepy import ..." (moviepy.editor DOES NOT EXIST in v2;
  concatenate_videoclips(..., method="chain") when all clips share the same size)
- Arabic text MUST be shaped + reordered before ANY draw - exact pattern:
    import arabic_reshaper
    from bidi.algorithm import get_display
    shaped = get_display(arabic_reshaper.reshape("النص العربي"))
- Fonts in ./fonts (cwd is the repo root): Cairo-VF.ttf, NotoSansArabic-VF.ttf,
  Amiri-Bold.ttf, Montserrat-VF.ttf  -> ImageFont.truetype("fonts/Cairo-VF.ttf", 64)
  Wrap Arabic text on the LOGICAL string, then shape each line, measure with font.getbbox.
- Optional keyless cinematic scene images (recommended - cache to files, retry twice,
  fall back to a PIL gradient when the request fails):
    import urllib.request, urllib.parse
    url = ("https://image.pollinations.ai/prompt/" + urllib.parse.quote(prompt)[:380]
           + f"?width=1080&height=1920&nologo=true&model=flux&seed={seed}")
    with urllib.request.urlopen(url, timeout=150) as r: open(dest, "wb").write(r.read())

COMPACTNESS IS MANDATORY (your reply is hard-limited to ~6000 characters - longer
replies get CUT OFF mid-line and become useless):
- The ENTIRE script must be under 150 lines / 6 KB. Dense, production-grade code only.
- One-line comments only where truly needed. No blank-line padding. No docstrings.
- Build ONE small frame-render helper + ONE ffmpeg pipe + a tiny main(). Reuse code.
- Prefer simple loops and dict lookups over classes.

PERFORMANCE RULES (4 GB runner, 60 fps is heavy - OOM = failure):
- NEVER buffer all frames in memory. Stream frames into ffmpeg via subprocess stdin:
    cmd = ["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1080x1920",
           "-r", str(fps), "-i", "-", "-i", "voice.mp3",
           "-c:v", "libx264", "-preset", "faster", "-crf", "21", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for frame in frames: proc.stdin.write(frame.tobytes())
    proc.stdin.close(); proc.wait()
  or pre-render each scene image ONCE with PIL and animate with ffmpeg zoompan/xfade filters.
- Prefer numpy math over per-pixel Python loops. Target < 8 min total for a 60-90 s video.
- At the very end, if threads hang, os._exit(0) is acceptable AFTER output.mp4 is complete.

DIRECTOR'S STORYBOARD (the sheet is authored by a showrunner - obey it):
- Each scene's "visual" is a DIRECTING sentence: shot size + subject DOING something in present
  tense + an explicit CAMERA MOVE (slow push-in / pull-out / pan left / pan right / tilt up /
  handheld tremble / drifting orbit) + moving ATMOSPHERE (drifting dust, heavy rain, sea spray,
  falling snow, rolling fog, rising embers, light rays) + light & palette notes.
  The storyboard is LAW: implement each scene's OWN camera move and moving atmosphere exactly
  as written, and make them DIFFER from scene to scene. Two consecutive scenes that move the
  same way, or any scene where nothing moves, is a FAILURE.
- Scene 1 is the hook (question/shock). The last scene carries the payoff + a question to the
  audience. Each voiceover is ONE short sentence - cut exactly on its end, never mid-word.
- Palette arc across the video: cold tension early -> warm resolution at the end.
- "sfx" names 3 layers (ambience + music + hit). You have no music library: if you can
  cheaply synthesize a subtle fitting numpy drone/pad, do it; otherwise skip music entirely.

HYPERFRAME QUALITY BAR (this is why you exist - a slideshow is a FAILURE):
- Continuous motion on every frame: ken-burns zoom/pan on scene images, animated gradient or
  particle backgrounds, caption text that reveals word-by-word or phrase-by-phrase in sync with
  the narration, smooth crossfades between scenes, a subtle moving progress bar, gentle scale
  breathing on titles. Never hold one static frame longer than ~0.5 s.
- Structure: title card (2-3 s) -> scenes (each ~ its narration duration) -> closing card
  (2-3 s) with a subscribe hint in the story language.
- Arabic RTL typography: shaped text, right-aligned, line spacing >= 1.4x, soft shadow/scrims
  behind text for readability, big bold fonts.
- Cinematic grade: vignette, coherent palette derived from the genre, film-like contrast.

Respond with EXACTLY ONE ```python code block containing the ENTIRE script. No prose."""

REPAIR_SUFFIX = """

YOUR PREVIOUS SCRIPT FAILED. Here is what happened:
---
{error}
---
Fix the bugs and return the FULL corrected script as one complete ```python code block.
If your previous reply was CUT OFF mid-line (token limit), that is also a failure: rewrite
it COMPACT (under 140 lines) so it completes. Simplify ambitious features - a finished,
working, beautiful video beats an ambitious broken one."""


# --------------------------------------------------------------------------
# Sandbox execution + validation
# --------------------------------------------------------------------------

def _ffprobe(path):
    cmd = ["ffprobe", "-v", "error", "-show_entries",
           "stream=codec_type,width,height,r_frame_rate,duration",
           "-show_entries", "format=duration,size", "-of", "json", path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return None
    return json.loads(r.stdout or "{}")


def validate_output(out_dir, fps_min=30):
    """ffprobe-validate OUT_DIR/output.mp4. Returns (ok, reason)."""
    mp4 = os.path.join(out_dir, "output.mp4")
    if not os.path.exists(mp4):
        return False, "output.mp4 missing"
    if os.path.getsize(mp4) < 80_000:
        return False, f"output.mp4 too small ({os.path.getsize(mp4)} bytes)"
    try:
        data = _ffprobe(mp4)
    except Exception as e:
        return False, f"ffprobe failed: {e}"
    if not data:
        return False, "ffprobe returned nothing"
    streams = data.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not v:
        return False, "no video stream"
    if not a:
        return False, "no audio stream (narration missing)"
    if int(v.get("width") or 0) != 1080 or int(v.get("height") or 0) != 1920:
        return False, f"wrong size {v.get('width')}x{v.get('height')} (need 1080x1920)"
    try:
        num, den = (v.get("r_frame_rate") or "0/1").split("/")
        fps = float(num) / max(float(den), 1)
    except Exception:
        fps = 0
    if fps < fps_min:
        return False, f"fps {fps:.0f} < {fps_min} (hyperframes require smooth motion)"
    dur = float(v.get("duration") or data.get("format", {}).get("duration") or 0)
    if not (8.0 <= dur <= 420.0):
        return False, f"duration {dur:.1f}s outside 8-420s"
    return True, f"ok 1080x1920@{fps:.0f}fps {dur:.1f}s audio=yes"


def _ensure_meta_thumb(out_dir, story, renderer_label):
    """Fill in meta.json / thumb.jpg if the AI script forgot them."""
    meta_path = os.path.join(out_dir, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
        except Exception:
            meta = {}
    meta.setdefault("title", story.get("title", "StoryPilot"))
    meta.setdefault("renderer", renderer_label)
    meta.setdefault("fps", int(os.environ.get("FRAME_RATE", "60")))
    meta.setdefault("width", 1080)
    meta.setdefault("height", 1920)
    meta.setdefault("story_hash", story.get("_story_hash") or story.get("_hash", ""))
    probe = _ffprobe(os.path.join(out_dir, "output.mp4")) or {}
    dur = probe.get("format", {}).get("duration")
    if dur:
        meta.setdefault("duration_sec", float(dur))
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    thumb = os.path.join(out_dir, "thumb.jpg")
    if not os.path.exists(thumb):
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "1", "-i", os.path.join(out_dir, "output.mp4"),
             "-frames:v", "1", "-vf", "scale=540:960", "-q:v", "3", thumb],
            capture_output=True, timeout=90,
        )


def _run_script(script_path, out_dir, timeout):
    """Run the AI-written script in a subprocess with the render env contract."""
    env = dict(os.environ)
    env["STORY_PATH"] = os.path.join(out_dir, "story.json")
    env["OUT_DIR"] = out_dir
    env.setdefault("FRAME_RATE", "60")
    try:
        r = subprocess.run(
            [sys.executable, "-X", "utf8", script_path],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=timeout,
        )
        out = ((r.stdout or "") + "\n" + (r.stderr or ""))[-4000:]
        return r.returncode, out
    except subprocess.TimeoutExpired as e:
        tail = ((e.stdout or b"") + (e.stderr or b""))
        if isinstance(tail, bytes):
            tail = tail.decode("utf-8", "replace")
        return 124, f"TIMEOUT after {timeout}s\n{tail[-1500:]}"


def write_renderer(story, out_dir, prev_code=None, prev_error=None):
    """Ask the keyless AI to write (or repair) the hyperframe renderer.

    Returns (code, route) - code is None if the AI could not be reached or
    produced no usable code block.
    """
    brief = {
        "title": story.get("title"),
        "logline": story.get("logline"),
        "hook": story.get("hook") or story.get("logline") or "",
        "lesson": story.get("lesson") or "",
        "genre": story.get("genre"),
        "language": story.get("language"),
        "narration": (story.get("narration") or "")[:2200],
        "scenes": [
            {k: s.get(k) for k in ("index", "timeRange", "visual", "aiPrompt", "voiceover", "sfx")}
            for s in story.get("scenes", [])
        ][:12],
    }
    prompt = (
        "Write the hyperframe renderer script for this story. The narration language is "
        f"{story.get('language', 'ar')} - use the matching Edge-TTS voice and typography.\n\n"
        "story.json content:\n" + json.dumps(brief, ensure_ascii=False, indent=2)
    )
    # cache-buster: keyless text APIs serve cached replies for identical prompts,
    # which would replay a previously-failed script forever
    import random
    prompt += f"\n\n[nonce: {time.time():.0f}-{random.randint(1000, 9999)}]"
    if prev_code and prev_error:
        prompt = (
            "Previous attempt's full script is below for reference - REUSE what worked, fix "
            "what failed.\n\n```python\n" + prev_code[:14000] + "\n```\n" + prompt
        ) + REPAIR_SUFFIX.format(error=prev_error[-2200:])
    text, route = keyless_chat(prompt, CODEWRITER_SYSTEM)
    code = extract_code_block(text)
    if code:
        with open(os.path.join(out_dir, "ai_renderer.py"), "w", encoding="utf-8") as f:
            f.write(code + "\n")
    return code, route


def forge_story(story, out_dir, deadline=None, fps="60", attempts=None):
    """Full forge loop for one story. Returns a result dict; raises only if
    even the built-in fallback fails."""
    os.makedirs(out_dir, exist_ok=True)
    payload = {k: v for k, v in story.items() if not k.startswith("_")}
    payload["_story_hash"] = story.get("_hash", "")
    with open(os.path.join(out_dir, "story.json"), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    attempts = attempts or AI_ATTEMPTS
    prev_code, prev_error = None, None
    last_route = "none"
    for i in range(1, attempts + 1):
        if deadline and time.time() > deadline:
            log("deadline reached - no time for another AI attempt")
            break
        log(f"AI code attempt {i}/{attempts} for '{story.get('title', '')[:60]}'")
        try:
            code, route = write_renderer(story, out_dir, prev_code, prev_error)
        except Exception as e:
            log(f"AI unreachable on attempt {i}: {str(e)[:200]}")
            break
        if not code:
            log("AI returned no code block")
            break
        last_route = route
        # syntax check before burning a render slot
        script_path = os.path.join(out_dir, "ai_renderer.py")
        try:
            py_compile.compile(script_path, doraise=True)
        except py_compile.PyCompileError as e:
            prev_code, prev_error = code, f"SYNTAX ERROR:\n{e}"
            log(f"AI code has syntax errors - asking for repair")
            continue
        rc, out_tail = _run_script(script_path, out_dir, RENDER_TIMEOUT)
        # a fully-rendered valid MP4 is a SUCCESS even if the script crashed in
        # a post-step (meta/thumb write) - we fill those in ourselves
        ok, why = validate_output(out_dir)
        if ok:
            log(f"AI-written renderer SUCCEEDED ({route}): {why}")
            _ensure_meta_thumb(out_dir, story, f"ai-hyperframe ({route})")
            _cleanup(out_dir, keep_ai=True)
            return {"mode": "ai", "model": route, "attempts": i, "detail": why}
        if rc == 0:
            prev_error = f"SCRIPT EXITED 0 BUT OUTPUT INVALID: {why}"
        else:
            prev_error = f"SCRIPT EXITED {rc} (no valid output: {why})\n{out_tail[-1600:]}"
        prev_code = code
        log(f"AI renderer failed (attempt {i}): {prev_error[:220]}")
        # wipe partial output so the next attempt starts clean
        for name in ("output.mp4", "thumb.jpg"):
            p = os.path.join(out_dir, name)
            if os.path.exists(p):
                os.remove(p)

    # ---------------- final fallback: the battle-tested built-in renderer ----------------
    log("falling back to the built-in cinematic renderer (generate_video.py)")
    env = dict(os.environ)
    env["STORY_PATH"] = os.path.join(out_dir, "story.json")
    env["OUT_DIR"] = out_dir
    env["FRAME_RATE"] = str(fps or 60)
    try:
        r = subprocess.run(
            [sys.executable, os.path.join(ROOT, "generate_video.py")],
            cwd=ROOT, env=env, capture_output=True, text=True, timeout=RENDER_TIMEOUT,
        )
        tail = ((r.stdout or "") + (r.stderr or ""))[-1500:]
        log(tail)
        ok, why = validate_output(out_dir)
        if r.returncode == 0 and ok:
            _ensure_meta_thumb(out_dir, story, "builtin-cinematic")
            _cleanup(out_dir, keep_ai=True)
            return {"mode": "builtin", "model": "generate_video.py", "attempts": attempts, "detail": why}
        raise RuntimeError(f"built-in renderer failed: rc={r.returncode} {why} :: {tail[-300:]}")
    except subprocess.TimeoutExpired:
        raise RuntimeError("built-in renderer timed out")


def _cleanup(out_dir, keep_ai=False):
    """Keep only artifact deliverables in the video dir."""
    keep = {"output.mp4", "meta.json", "thumb.jpg", "story.json"}
    if keep_ai:
        keep.add("ai_renderer.py")
    for name in os.listdir(out_dir):
        if name in keep:
            continue
        p = os.path.join(out_dir, name)
        shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)


# --------------------------------------------------------------------------
# Standalone smoke test: python scripts/ai_forge.py [story.json] [out_dir]
# --------------------------------------------------------------------------

if __name__ == "__main__":
    story_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "story.json")
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "output")
    with open(story_path, encoding="utf-8") as f:
        st = json.load(f)
    t0 = time.time()
    res = forge_story(st, out_dir)
    print(json.dumps({**res, "seconds": round(time.time() - t0, 1)}, ensure_ascii=False, indent=2))
