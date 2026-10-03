# StoryPilot — Hourly Cinematic Story Video Pipeline

This repo runs an **hourly automation** on GitHub Actions:

1. **Fetch the story** from the Google Sheet that Gemini Spark updates every hour
   (fallback: generate a fresh story **keyless** with [`freellmpool`](https://github.com/0xzr/freellmpool) — GLM Flash first, auto-failover to live keyless routes).
2. **Render a cinematic vertical 1080×1920 MP4** — keyless AI scene imagery (Pollinations flux)
   with Ken Burns motion + Edge-TTS voiceover + word-synced Arabic captions
   (MoviePy + Pillow + arabic-reshaper + python-bidi, bundled Cairo/Noto/Amiri fonts).
3. **Post** to YouTube, TikTok and Instagram Reels (each platform activates as soon as you add its secrets).

## Files

| File | Purpose |
|---|---|
| `.github/workflows/hourly-video.yml` | The hourly GitHub Actions workflow |
| `scripts/generate_story.py` | Story source: Google Sheet (tolerant parser) → keyless GLM → fallback |
| `generate_video.py` | Cinematic renderer: `story.json` → `output/output.mp4` |
| `fonts/` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| `post_video.py` | Posts to YouTube / TikTok / Instagram |
| `requirements.txt` | Python dependencies |
| `web/` | The full Kimi-style agent app (Next.js) source |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| `YOUTUBE_REFRESH_TOKEN` | YouTube | OAuth playground with `youtube.upload` scope |
| `YOUTUBE_CLIENT_ID` | YouTube | Google Cloud Console → OAuth client |
| `YOUTUBE_CLIENT_SECRET` | YouTube | Google Cloud Console → OAuth client |
| `TIKTOK_ACCESS_TOKEN` | TikTok | TikTok for Developers → Content Posting API |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram | Meta Graph API (IG business account) |
| `INSTAGRAM_USER_ID` | Instagram | Your Instagram Business account id |

### Optional repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Meaning |
|---|---|---|
| `FLP_MODEL` | `glm-4.7-flash` | Story model tried first by freellmpool |
| `SHEET_ID` | the Spark sheet | Google Sheet id with the hourly story |
| `TTS_VOICE_AR` | `ar-EG-ShakirNeural` | Edge-TTS Arabic voice |
| `ENABLE_AI_IMAGES` | `true` | Keyless AI scene imagery (Pollinations) |
| `IMAGE_MODEL` | `flux` | Pollinations image model (`flux` / `turbo`) |
| `YOUTUBE_PRIVACY` | `public` | `public` / `unlisted` / `private` |
| `TIKTOK_PRIVACY` | `SELF_ONLY` | `SELF_ONLY` until your TikTok app is approved |

## Run it now

Actions tab → **Hourly Story Video** → **Run workflow**.
Every finished run leaves the MP4 + thumbnail in the **hourly-video** artifact (14-day retention).

## Story sheet

https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit

The first tab is parsed tolerantly (English or Arabic labels, any column order):
label rows for Title / Logline / Genre / Duration, a scene table whose columns are
detected by keyword (time, visual, prompt, voiceover, sfx — Arabic or English), and an
optional complete-narration section. If parsing finds no scenes, the pipeline falls
back to a keyless AI story so it never breaks.
