#!/usr/bin/env python3
"""StoryPilot - Cinematic Renderer v2 (100% keyless).

v1 rendered static gradient text cards. v2 is a real storytelling engine:

  * Keyless AI scene imagery  - Pollinations (flux), cached, graceful fallback
  * Cinematic motion          - ffmpeg zoompan (Ken Burns) on every scene
  * Word-synced captions      - edge-tts WordBoundary events -> caption pills
  * Real Arabic typography    - bundled Cairo / Noto Sans Arabic / Amiri fonts
  * Filmic look               - vignette + scrims + color grade, title/end cards

Free stack, no API keys: Edge-TTS + Pollinations + MoviePy + Pillow
  + arabic-reshaper + python-bidi  ->  1080x1920 (9:16) 24fps H.264/AAC MP4.

Reads  : story.json   (written by scripts/generate_story.py)
Writes : output/output.mp4, output/meta.json, output/thumb.jpg
"""
import asyncio
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import time
import urllib.parse

import requests

import arabic_reshaper
from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

try:  # MoviePy 2.x
    from moviepy import AudioFileClip, ImageClip, CompositeVideoClip, VideoFileClip, concatenate_videoclips, vfx
except ImportError:  # MoviePy 1.x
    from moviepy.editor import AudioFileClip, ImageClip, CompositeVideoClip, VideoFileClip, concatenate_videoclips, vfx  # noqa

import numpy as np

W, H, FPS = 1080, 1920, 24
KB_W, KB_H = int(W * 1.18), int(H * 1.18)   # oversized source for Ken Burns headroom
OUT_DIR = os.environ.get("OUT_DIR", "output")
STORY_PATH = os.environ.get("STORY_PATH", "story.json")
FONT_DIR = os.environ.get("FONT_DIR", "fonts")
IMG_DIR = os.path.join(OUT_DIR, "images")
VOICE_AR = os.environ.get("TTS_VOICE_AR", "ar-EG-ShakirNeural")
VOICE_EN = os.environ.get("TTS_VOICE_EN", "en-US-ChristopherNeural")
RATE = os.environ.get("TTS_RATE", "-4%")
ENABLE_AI_IMAGES = os.environ.get("ENABLE_AI_IMAGES", "true").lower() in ("1", "true", "yes")
IMAGE_MODEL = os.environ.get("IMAGE_MODEL", "flux")
IMAGE_TIMEOUT = int(os.environ.get("IMAGE_TIMEOUT", "150"))
TITLE_DUR = float(os.environ.get("TITLE_DUR", "3.0"))
END_DUR = float(os.environ.get("END_DUR", "3.2"))
POST_PAD = 0.55          # breathing room after each voiceover
CAPTION_BOTTOM = 1460    # visual bottom edge of caption pills (above TikTok UI)
MAX_SCENES = 12
MAX_CAPTION_WORDS = 4

PALETTES = [
    ((11, 16, 38), (44, 62, 122), (143, 183, 255), (236, 99, 118)),   # midnight blue
    ((26, 11, 46), (91, 44, 131), (224, 179, 255), (255, 168, 112)),  # violet dusk
    ((9, 22, 16), (31, 92, 61), (159, 227, 191), (255, 199, 95)),     # emerald night
    ((30, 13, 8), (122, 59, 30), (255, 201, 163), (120, 200, 255)),   # amber ember
    ((10, 15, 26), (58, 80, 107), (188, 212, 230), (255, 138, 138)),  # steel dusk
    ((36, 6, 20), (122, 20, 60), (255, 170, 197), (120, 255, 214)),   # rose noir
]

FONT_STACKS = {
    "title": {
        "ar": [("Cairo-VF.ttf", 800, ["notosansarabic-bold", "notonaskharabic-bold"])],
        "en": [("Montserrat-VF.ttf", 800, ["dejavusans-bold", "notosans-bold"])],
    },
    "caption": {
        "ar": [("NotoSansArabic-VF.ttf", 700, ["notosansarabic-bold", "notonaskharabic-bold"])],
        "en": [("Montserrat-VF.ttf", 700, ["dejavusans-bold"])],
    },
    "quote": {
        "ar": [("Amiri-Bold.ttf", None, ["notonaskharabic", "notosansarabic-regular"])],
        "en": [("Montserrat-VF.ttf", 500, ["dejavusans", "notosans-regular"])],
    },
    "meta": {
        "ar": [("Cairo-VF.ttf", 640, ["notosansarabic-regular"])],
        "en": [("Montserrat-VF.ttf", 640, ["dejavusans", "notosans-regular"])],
    },
}

SYSTEM_FONT_DIRS = [
    "/usr/share/fonts", "/usr/local/share/fonts",
    os.path.expanduser("~/.fonts"), "/Library/Fonts", "C:/Windows/Fonts",
]

_font_cache = {}
_ffmpeg_exe = None


def ffmpeg_exe():
    global _ffmpeg_exe
    if _ffmpeg_exe is None:
        _ffmpeg_exe = shutil.which("ffmpeg") or ""
        if not _ffmpeg_exe:
            try:
                import imageio_ffmpeg
                _ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                _ffmpeg_exe = "ffmpeg"
    return _ffmpeg_exe


def is_ar(text):
    return any("\u0600" <= c <= "\u06FF" for c in str(text))


def shape(text):
    text = str(text)
    if is_ar(text):
        try:
            return get_display(arabic_reshaper.reshape(text))
        except Exception:
            return text
    return text


def arabic_digits(n, lang):
    s = str(n)
    if lang == "ar":
        return s.translate(str.maketrans("0123456789", "\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669"))
    return s


# ---------------------------------------------------------------- fonts ----

def _bundled_path(name):
    here = os.path.dirname(os.path.abspath(__file__))
    for d in [FONT_DIR, os.path.join(here, "fonts"), os.path.join(os.getcwd(), "fonts")]:
        if not d:
            continue
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
        if os.path.isdir(d):
            low = name.lower()
            for f in os.listdir(d):
                if f.lower() == low:
                    return os.path.join(d, f)
    return None


def _system_font(keys):
    for key in keys:
        for root in SYSTEM_FONT_DIRS:
            if not os.path.isdir(root):
                continue
            for dirpath, _, files in os.walk(root):
                for f in files:
                    if f.lower().endswith((".ttf", ".otf")) and key in os.path.join(dirpath, f).lower():
                        return os.path.join(dirpath, f)
    return None


def _apply_weight(font, weight):
    if not weight:
        return font
    try:
        axes = font.get_variation_axes()
        vals = []
        for ax in axes:
            nm = ax.get("name", b"") if isinstance(ax, dict) else getattr(ax, "name", b"")
            nm = nm.decode("utf-8", "ignore") if isinstance(nm, bytes) else str(nm)
            if nm.lower().startswith("weight"):
                vals.append(max(ax["minimum"], min(ax["maximum"], weight)))
            else:
                vals.append(ax["default"])
        if vals:
            font.set_variation_by_axes(vals)
    except Exception:
        pass
    return font


def get_font(kind, size, lang="ar"):
    key = (kind, size, lang)
    if key in _font_cache:
        return _font_cache[key]
    stack = FONT_STACKS.get(kind, FONT_STACKS["meta"]).get(lang == "ar" and "ar" or "en")
    font = None
    for entry in stack:
        name, weight = entry[0], entry[1]
        syskeys = entry[2] if len(entry) > 2 else []
        path = _bundled_path(name) or (syskeys and _system_font(syskeys)) or None
        if path:
            font = _apply_weight(ImageFont.truetype(path, size), weight)
            break
    if font is None:
        font = ImageFont.load_default()
    _font_cache[key] = font
    return font


def wrap(text, font, max_w, max_lines=4):
    words = str(text).split()
    lines, cur = [], ""
    for wd in words:
        trial = (cur + " " + wd).strip()
        if font.getlength(shape(trial)) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines[:max_lines]


def lerp3(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ------------------------------------------------- fallback gradient bg ----

def make_bg(palette, seed, w=W, h=H):
    dark, mid, light, accent = palette
    strip = Image.new("RGB", (1, h))
    for y in range(h):
        strip.putpixel((0, y), lerp3(dark, mid, (y / h) ** 1.25))
    img = strip.resize((w, h)).convert("RGBA")
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    rng = random.Random(seed)
    for _ in range(3):
        x, y = rng.randint(-100, w + 100), rng.randint(-100, h + 100)
        r = rng.randint(int(w * 0.3), int(w * 0.65))
        color = [light, accent, mid][rng.randint(0, 2)]
        d.ellipse([x - r, y - r, x + r, y + r], fill=color + (rng.randint(20, 42),))
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    return Image.alpha_composite(img, glow).convert("RGB")


# ------------------------------------------------------------- imagery ----

STYLE_SUFFIX = ", cinematic lighting, dramatic atmosphere, shot on 35mm film, subtle film grain, natural skin texture, ultra detailed, vertical 9:16 composition, no text, no watermark"


def image_prompt_for(scene):
    p = (scene.get("aiPrompt") or "").strip()
    if not p:
        p = (scene.get("visual") or "").strip()
    if not p:
        p = (scene.get("voiceover") or "").strip()
    return (p[:400] + STYLE_SUFFIX) if p else ("abstract atmospheric story illustration" + STYLE_SUFFIX)


def fetch_scene_image(prompt, seed, path):
    if os.path.isfile(path) and os.path.getsize(path) > 25000:
        return True
    q = urllib.parse.quote(prompt, safe="")
    url = f"https://image.pollinations.ai/prompt/{q}?width=1080&height=1920&nologo=true&model={IMAGE_MODEL}&seed={seed}"
    for attempt in range(3):
        try:
            r = requests.get(url, timeout=IMAGE_TIMEOUT, headers={"User-Agent": "StoryPilot/2.0"})
            ct = r.headers.get("content-type", "")
            if r.status_code == 200 and ct.startswith("image") and len(r.content) > 25000:
                with open(path, "wb") as f:
                    f.write(r.content)
                return True
            print(f"[img] attempt {attempt + 1}: HTTP {r.status_code} ct={ct} len={len(r.content)}", flush=True)
        except Exception as e:
            print(f"[img] attempt {attempt + 1}: {e}", flush=True)
        time.sleep(15)
    return False


def apply_look(img):
    """Color grade + vignette + top/bottom scrims on an RGB image (KB sized)."""
    img = ImageEnhance.Color(img).enhance(1.09)
    img = ImageEnhance.Contrast(img).enhance(1.05)
    w, h = img.size
    ov = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for y in range(h):
        a = 0
        if y < 420:
            a = int(150 * (1 - y / 420.0))
        elif y > h - 620:
            a = int(165 * ((y - (h - 620)) / 620.0))
        if a:
            d.line([(0, y), (w, y)], fill=(0, 0, 0, a))
    vin = Image.new("L", (w, h), 0)
    ImageDraw.Draw(vin).ellipse([-w * 0.35, -h * 0.18, w * 1.35, h * 1.18], fill=255)
    vin = vin.filter(ImageFilter.GaussianBlur(220))
    black = Image.new("RGBA", (w, h), (0, 0, 0, 95))
    ov = Image.composite(ov, Image.alpha_composite(ov, black), vin)
    return Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")


def kb_source(img):
    """Oversize + grade an image (or gradient) for the Ken Burns pan."""
    big = img.resize((KB_W, KB_H), Image.LANCZOS)
    return apply_look(big)


# ----------------------------------------------------------------- tts ----

def tts_scene(text, lang, tag):
    mp3 = os.path.join(OUT_DIR, f"voice_{tag}.mp3")
    voice = VOICE_AR if lang == "ar" else VOICE_EN
    words = []

    async def _run():
        import edge_tts
        com = edge_tts.Communicate(text, voice, rate=RATE)
        with open(mp3, "wb") as f:
            async for ch in com.stream():
                if ch["type"] == "audio":
                    f.write(ch["data"])
                elif ch["type"] == "WordBoundary":
                    t0 = ch["offset"] / 1e7
                    words.append({"w": ch["text"], "s": t0, "e": t0 + ch["duration"] / 1e7})

    try:
        asyncio.run(_run())
        if os.path.getsize(mp3) > 1000:
            return mp3, words
    except Exception as e:
        print(f"[tts] {tag} failed -> silence fallback: {e}", flush=True)
    return None, []


PUNCT = ".,!?:;\u060c\u061b\u061f..."  # latin + arabic punctuation


def chunk_words(words):
    chunks, cur = [], []
    for wd in words:
        cur.append(wd)
        if len(cur) >= MAX_CAPTION_WORDS or any(ch in PUNCT for ch in wd["w"]):
            chunks.append(cur)
            cur = []
    if cur:
        chunks.append(cur)
    out = []
    for i, c in enumerate(chunks):
        s = max(0.0, c[0]["s"] - 0.06)
        e = c[-1]["e"] + 0.12
        if i + 1 < len(chunks):
            e = min(e, chunks[i + 1][0]["s"] - 0.02)
        out.append({"text": " ".join(x["w"] for x in c), "s": s, "e": max(e, s + 0.45)})
    return out


def estimate_chunks(text, dur):
    words = str(text).split()
    if not words:
        return []
    n = max(1, (len(words) + MAX_CAPTION_WORDS - 1) // MAX_CAPTION_WORDS)
    per = dur / n
    out = []
    for i in range(n):
        part = words[i * MAX_CAPTION_WORDS:(i + 1) * MAX_CAPTION_WORDS]
        out.append({"text": " ".join(part), "s": i * per + 0.05, "e": (i + 1) * per - 0.02})
    return out


# ------------------------------------------------------------- captions ----

def render_caption_png(text, lang, path):
    size = 64
    lines = None
    while True:
        font = get_font("caption", size, lang)
        lines = wrap(text, font, W - 240, max_lines=2)
        if all(font.getlength(shape(l)) <= W - 240 for l in lines) or size <= 42:
            break
        size -= 6
    pad_x, pad_y, line_h = 40, 24, int(size * 1.5)
    tw = max(font.getlength(shape(l)) for l in lines)
    pill_w = int(tw) + pad_x * 2
    pill_h = line_h * len(lines) + pad_y * 2
    canvas = Image.new("RGBA", (pill_w + 48, pill_h + 48), (0, 0, 0, 0))
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([24 + 5, 24 + 9, 24 + pill_w + 5, 24 + pill_h + 9], radius=40, fill=(0, 0, 0, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(13))
    canvas = Image.alpha_composite(canvas, sh)
    d = ImageDraw.Draw(canvas)
    d.rounded_rectangle([24, 24, 24 + pill_w, 24 + pill_h], radius=pill_h // 2 if len(lines) == 1 else 40, fill=(12, 14, 22, 210))
    y = 24 + pad_y + 2
    for l in lines:
        lw = font.getlength(shape(l))
        d.text((24 + (pill_w - lw) / 2, y), shape(l), font=font, fill=(255, 255, 255, 255))
        y += line_h
    canvas.save(path)
    return path, canvas.size[1]


def png_clip(path):
    """RGBA PNG -> ImageClip carrying its alpha as a mask (MoviePy 1.x & 2.x)."""
    arr = np.array(Image.open(path).convert("RGBA"))
    clip = None
    try:
        clip = ImageClip(arr)
        if getattr(clip, "mask", None) is None:
            raise ValueError("no auto mask")
    except Exception:
        clip = ImageClip(arr[:, :, :3])
        mask = ImageClip(arr[:, :, 3].astype(np.float32) / 255.0, is_mask=True)
        try:
            clip = clip.with_mask(mask)
        except Exception:
            try:
                clip.mask = mask
            except Exception:
                pass
    return clip


# ---------------------------------------------------------------- cards ----

def _shadow_text(d, xy, text, font, fill, shadow=(0, 0, 0, 170), off=(3, 5)):
    d.text((xy[0] + off[0], xy[1] + off[1]), text, font=font, fill=shadow)
    d.text(xy, text, font=font, fill=fill)


def render_title_card(story, lang, palette, base_img):
    dark, mid, light, accent = palette
    if base_img is not None:
        bg = base_img.resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(22))
        bg = ImageEnhance.Brightness(bg).enhance(0.52)
    else:
        bg = make_bg(palette, int(hashlib.sha256(story.get("title", "s").encode()).hexdigest()[:8], 16))
    img = bg.convert("RGBA")
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dg = ImageDraw.Draw(grad)
    for y in range(H):
        a = int(120 * (y / H))
        dg.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    img = Image.alpha_composite(img, grad)
    d = ImageDraw.Draw(img, "RGBA")

    eyebrow = "\u0633\u062a\u0648\u0631\u064a \u0628\u0627\u064a\u0644\u0648\u062a \u00b7 \u0642\u0635\u0635 \u0627\u0644\u064a\u0648\u0645" if lang == "ar" else "STORYPILOT  \u00b7  STORY OF THE DAY"
    _shadow_text(d, (96, 285), shape(eyebrow), get_font("meta", 44, lang), light + (215,), off=(2, 3))

    title = story.get("title", "")
    tl = len(title)
    tsize = 132 if tl <= 24 else (108 if tl <= 52 else 88)
    tfont = get_font("title", tsize, lang)
    y = 400
    for line in wrap(title, tfont, W - 200, max_lines=4):
        _shadow_text(d, (96, y), shape(line), tfont, (255, 255, 255, 255))
        y += tfont.size + 24

    y += 34
    d.rounded_rectangle([96, y, 96 + 170, y + 10], radius=5, fill=accent + (255,))

    logline = (story.get("logline") or "").strip()
    if logline:
        y += 76
        lfont = get_font("quote", 54, lang)
        for line in wrap(logline, lfont, W - 220, max_lines=5):
            _shadow_text(d, (96, y), shape(line), lfont, light + (240,))
            y += lfont.size + 18

    cx, cy = 96, H - 330
    for label in [x for x in (story.get("genre", ""), story.get("duration", "")) if x]:
        f = get_font("meta", 40, "en" if not is_ar(label) else "ar")
        tw = f.getlength(shape(label))
        d.rounded_rectangle([cx, cy, cx + tw + 52, cy + 86], radius=43, fill=(255, 255, 255, 30))
        d.text((cx + 26, cy + (86 - f.size * 1.3) / 2), shape(label), font=f, fill=light + (225,))
        cx += int(tw) + 70

    tail = "\u062a\u0648\u0644\u064a\u062f \u0622\u0644\u064a \u0643\u0644 \u0633\u0627\u0639\u0629 \u00b7 Edge-TTS + MoviePy" if lang == "ar" else "rendered hourly  \u00b7  keyless AI pipeline"
    d.text((96, H - 200), shape(tail), font=get_font("meta", 32, lang), fill=light + (140,))
    return img.convert("RGB")


def render_end_card(story, lang, palette, base_img):
    dark, mid, light, accent = palette
    if base_img is not None:
        bg = base_img.resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(26))
        bg = ImageEnhance.Brightness(bg).enhance(0.42)
    else:
        bg = make_bg(palette, 99, )
    img = bg.convert("RGBA")
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dg = ImageDraw.Draw(grad)
    for y in range(H):
        dg.line([(0, y), (W, y)], fill=(0, 0, 0, 60))
    img = Image.alpha_composite(img, grad)
    d = ImageDraw.Draw(img, "RGBA")

    big = "\u0634\u0643\u0631\u0627\u064b \u0644\u0645\u0634\u0627\u0647\u062f\u062a\u0643\u0645" if lang == "ar" else "Thanks for watching"
    bfont = get_font("title", 116, lang)
    lines = wrap(big, bfont, W - 200, max_lines=2)
    y = int(H * 0.38)
    for line in lines:
        lw = bfont.getlength(shape(line))
        _shadow_text(d, ((W - lw) / 2, y), shape(line), bfont, (255, 255, 255, 255), off=(3, 6))
        y += bfont.size + 26

    y += 60
    sub = "\u062a\u0627\u0628\u0639\u0648\u0646\u0627 \u0644\u0645\u0632\u064a\u062f \u0645\u0646 \u0627\u0644\u0642\u0635\u0635" if lang == "ar" else "Follow for more stories"
    sfont = get_font("quote", 56, lang)
    for line in wrap(sub, sfont, W - 260, max_lines=2):
        lw = sfont.getlength(shape(line))
        d.text(((W - lw) / 2, y), shape(line), font=sfont, fill=light + (235,))
        y += sfont.size + 20

    d.rounded_rectangle([W / 2 - 85, y + 90, W / 2 + 85, y + 100], radius=5, fill=accent + (255,))
    brand = "STORYPILOT"
    d.text((W / 2 - get_font("meta", 30, "en").getlength(brand) / 2, y + 130), brand, font=get_font("meta", 30, "en"), fill=light + (150,))
    return img.convert("RGB")


# -------------------------------------------------------------- zoompan ----

def zoompan(src_png, out_mp4, dur, preset):
    frames = max(int(round(dur * FPS)), 2)
    if preset == 1:      # zoom out
        z = f"1.10-0.10*on/{frames}"
        x, y = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    elif preset == 2:    # zoom in, drift down
        z = f"1+0.12*on/{frames}"
        x = "iw/2-(iw/zoom/2)"
        y = f"(ih-ih/zoom)*(0.18+0.44*on/{frames})"
    elif preset == 3:    # zoom in, drift sideways
        z = f"1+0.12*on/{frames}"
        x = f"(iw-iw/zoom)*(0.16+0.5*on/{frames})"
        y = "ih/2-(ih/zoom/2)"
    elif preset == 4:    # gentle card zoom
        z = f"1+0.045*on/{frames}"
        x, y = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    else:                # zoom in, centered
        z = f"1+0.10*on/{frames}"
        x, y = "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"
    vf = f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={FPS}"
    cmd = [ffmpeg_exe(), "-y", "-loglevel", "error", "-loop", "1", "-i", src_png,
           "-vf", vf, "-frames:v", str(frames), "-pix_fmt", "yuv420p", "-an", out_mp4]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"zoompan failed: {r.stderr[-400:]}")
    return out_mp4


# ----------------------------------------------------------------- main ----

def detect_language(story):
    lang = (story.get("language") or "").lower()
    if lang.startswith("ar"):
        return "ar"
    if lang.startswith("en"):
        return "en"
    text = " ".join([story.get("title", ""), story.get("narration", "")] +
                    [s.get("voiceover", "") for s in story.get("scenes", [])])
    return "ar" if len(re.findall(r"[\u0600-\u06FF]", text)) >= len(re.findall(r"[A-Za-z]", text)) else "en"


def normalize_scenes(story):
    scenes = [s for s in story.get("scenes", []) if isinstance(s, dict)]
    if not scenes:
        narration = (story.get("narration") or "").strip()
        if narration:
            parts = [p.strip() for p in re.split(r"(?<=[.!?\u061f\u060c])\s+", narration) if p.strip()]
            scenes = [{"voiceover": p, "visual": p, "aiPrompt": p} for p in parts]
        else:
            scenes = []
    return scenes[:MAX_SCENES]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(IMG_DIR, exist_ok=True)
    with open(STORY_PATH, encoding="utf-8") as f:
        story = json.load(f)

    lang = detect_language(story)
    scenes = normalize_scenes(story)
    if not scenes:
        raise SystemExit("story has no scenes and no narration - nothing to render")

    title = story.get("title") or "Hourly Story"
    seed = int(hashlib.sha256(title.encode()).hexdigest()[:8], 16)
    palette = PALETTES[seed % len(PALETTES)]
    print(f"[render] '{title}' | {len(scenes)} scenes | lang={lang} | images={'on' if ENABLE_AI_IMAGES else 'off'}", flush=True)

    # 1) TTS for every scene (fast, sequential)
    tts = []
    for i, sc in enumerate(scenes, start=1):
        vo = (sc.get("voiceover") or sc.get("visual") or "").strip()
        if vo:
            mp3, words = tts_scene(vo, lang, f"s{i}")
            print(f"[tts] scene {i}: {'ok ' + str(len(words)) + ' words' if mp3 else 'silence fallback'}", flush=True)
        else:
            mp3, words = None, []
        tts.append((mp3, words, vo))

    # 2) keyless AI images in parallel (staggered, with cache + fallback)
    img_paths = [None] * len(scenes)
    if ENABLE_AI_IMAGES:
        import concurrent.futures as cf

        def _fetch(i):
            p = os.path.join(IMG_DIR, f"scene_{i + 1:02d}.jpg")
            time.sleep(3.0 * i)
            ok = fetch_scene_image(image_prompt_for(scenes[i]), (seed + i * 977) % 999983, p)
            return i, p if ok else None

        with cf.ThreadPoolExecutor(max_workers=2) as ex:
            for i, p in ex.map(_fetch, range(len(scenes))):
                img_paths[i] = p
                print(f"[img] scene {i + 1}: {'AI image ok' if p else 'fallback gradient'}", flush=True)

    def load_img(p):
        return Image.open(p).convert("RGB") if p else None

    first_img, last_img = load_img(img_paths[0]), load_img(img_paths[-1])

    # 3) title card
    title_img = render_title_card(story, lang, palette, first_img)
    title_img.save(os.path.join(OUT_DIR, "thumb.jpg"), quality=88)
    tp = os.path.join(OUT_DIR, "kb_title.png")
    kb_source(title_img).save(tp)
    clips = [VideoFileClip(zoompan(tp, os.path.join(OUT_DIR, "seg_title.mp4"), TITLE_DUR, 4)).with_duration(TITLE_DUR).with_effects([vfx.FadeIn(0.35), vfx.FadeOut(0.35)])]

    # 4) scene clips with captions + Ken Burns
    for i, sc in enumerate(scenes, start=1):
        mp3, words, vo = tts[i - 1]
        if mp3:
            audio = AudioFileClip(mp3)
            adur = float(audio.duration)
            dur = adur + POST_PAD
        else:
            audio = None
            adur = max(3.0, len((vo or "scene").split()) / 2.5)
            dur = adur + POST_PAD

        src = os.path.join(OUT_DIR, f"kb_scene_{i:02d}.png")
        img = load_img(img_paths[i - 1])
        kb_source(img if img is not None else make_bg(palette, seed + i)).save(src)
        seg = os.path.join(OUT_DIR, f"seg_{i:02d}.mp4")
        zoompan(src, seg, dur, (seed + i) % 4)
        base = VideoFileClip(seg).with_duration(dur)
        if audio is not None:
            base = base.with_audio(audio)

        overlays = [base]
        chunks = chunk_words(words) if words else (estimate_chunks(vo, adur) if vo else [])
        for j, ch in enumerate(chunks):
            cap_png = os.path.join(OUT_DIR, f"cap_{i:02d}_{j:02d}.png")
            _, ch_h = render_caption_png(ch["text"], lang, cap_png)
            c = png_clip(cap_png).with_start(ch["s"]).with_duration(max(0.3, ch["e"] - ch["s"]))
            overlays.append(c.with_position(("center", CAPTION_BOTTOM - ch_h + 24)))

        scene_clip = CompositeVideoClip(overlays, size=(W, H)).with_duration(dur)
        scene_clip = scene_clip.with_effects([vfx.FadeIn(0.22), vfx.FadeOut(0.22)])
        clips.append(scene_clip)
        print(f"[kb] scene {i}: {dur:.1f}s, {len(chunks)} captions", flush=True)

    # 5) end card
    end_img = render_end_card(story, lang, palette, last_img)
    ep = os.path.join(OUT_DIR, "kb_end.png")
    kb_source(end_img).save(ep)
    clips.append(VideoFileClip(zoompan(ep, os.path.join(OUT_DIR, "seg_end.mp4"), END_DUR, 4)).with_duration(END_DUR).with_effects([vfx.FadeIn(0.35), vfx.FadeOut(0.6)]))

    # 6) final encode
    final = concatenate_videoclips(clips, method="compose")
    out_path = os.path.join(OUT_DIR, "output.mp4")
    total = float(final.duration)
    print(f"[render] writing {out_path} ({total:.1f}s, {W}x{H}@{FPS})", flush=True)
    final.write_videofile(
        out_path, fps=FPS, codec="libx264", audio_codec="aac", audio_bitrate="192k",
        preset="medium", threads=os.cpu_count() or 2,
        ffmpeg_params=["-pix_fmt", "yuv420p", "-crf", "21", "-movflags", "+faststart"],
    )

    ai_used = sum(1 for p in img_paths if p)
    genre = str(story.get("genre", "")).strip()
    base_tags = [genre] if genre and is_ar(genre) else [w for w in (genre + " short story ai storytelling vertical video").split() if len(w) > 2]
    tags_raw = [w for w in base_tags if w]
    meta = {
        "title": title,
        "description": (story.get("logline", "") or title) + "\n\nCinematic vertical video generated automatically by the StoryPilot pipeline - keyless AI imagery + Edge-TTS voiceover + word-synced captions.",
        "tags": list(dict.fromkeys(tags_raw))[:12],
        "language": lang,
        "duration_sec": round(total, 1),
        "scenes": len(scenes),
        "renderer": "cinematic-v2",
        "ai_images": f"{ai_used}/{len(scenes)} (pollinations {IMAGE_MODEL}, keyless)",
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("[render] done -> output/output.mp4 + meta.json + thumb.jpg", flush=True)


if __name__ == "__main__":
    main()
