# StoryPilot — Continuous Story Video Factory

This repo renders **every story in the Google Sheet into a video**, continuously:

1. **Continuous factory**: the StoryPilot app's render loop dispatches this workflow
   **back-to-back** whenever pending stories exist (not just hourly). Each run fans
   out to **N parallel workers** (GitHub Actions matrix) — every worker renders its
   own shard of the queue, so throughput multiplies. Hourly crons (:47 render, :19
   watcher) act as backup layers when the app is offline.
2. **Keyless AI everywhere**: [freellmpool](https://github.com/0xzr/freellmpool)
   polishes each story's voiceovers (tighter pacing, stronger hooks) and writes the
   platform title/description/hashtags before rendering — no API keys needed, with
   automatic model failover. The app itself uses the z.ai SDK (GLM-5.3-Flash) for
   chat and on-demand story polish.
3. **Cinematic vertical 1080×1920 MP4s** at **60fps hyperframes** — keyless AI scene
   imagery (Pollinations flux) with Ken Burns motion + Edge-TTS voiceover +
   word-synced Arabic captions (MoviePy + Pillow + arabic-reshaper + python-bidi,
   bundled Cairo/Noto/Amiri fonts).
4. **Post** every rendered video to YouTube, TikTok and Instagram Reels (each
   platform activates as soon as you add its secrets).

Single-story renders are still available: dispatch the workflow with `use_ai_story`
or a `story_json` payload (the app's **Make video** button uses this).

## Files

| File | Purpose |
|---|---|
| `.github/workflows/hourly-video.yml` | The render workflow — parallel worker matrix + publish job |
| `.github/workflows/ensure-hourly.yml` | Backup watcher — re-dispatches when the last run goes stale |
| `scripts/render_pending.py` | Batch queue: shards the pending stories across workers and renders them |
| `scripts/generate_story.py` | Single-story source: Google Sheet (tolerant parser) → keyless GLM → fallback |
| `generate_video.py` | Cinematic renderer: `story.json` → 1080×1920 60fps MP4 |
| `state/videos*.json` | Render state committed by the bot — which stories already have videos |
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
| `FLP_MODEL` | `glm-4.7-flash` | freellmpool model tried first for story generation & polish |
| `SHEET_ID` | the Spark sheet | Google Sheet id with the hourly story |
| `TTS_VOICE_AR` | `ar-EG-ShakirNeural` | Edge-TTS Arabic voice |
| `ENABLE_AI_IMAGES` | `true` | Keyless AI scene imagery (Pollinations) |
| `IMAGE_MODEL` | `flux` | Pollinations image model (`flux` / `turbo`) |
| `FRAME_RATE` | `60` | Hyperframes — 60fps silky motion (set `24` for the old rate) |
| `AI_ENHANCE` | `true` | Keyless AI polish of voiceovers + platform metadata before render |
| `BUDGET_MIN` | `36` | Minutes each worker spends rendering per run |
| `MAX_VIDEOS` | `4` | Max videos rendered **per worker** per run |
| `WORKERS_JSON` | `["0","1","2"]` | Parallel workers for cron-triggered runs (app dispatches override) |
| `YOUTUBE_PRIVACY` | `public` | `public` / `unlisted` / `private` |
| `TIKTOK_PRIVACY` | `SELF_ONLY` | `SELF_ONLY` until your TikTok app is approved |

## Run it now

Actions tab → **Hourly Story Video** → **Run workflow**.
Every run leaves its rendered MP4s (one folder per video: `output.mp4`, `meta.json`,
`thumb.jpg`, `story.json`) in per-worker **hourly-video-w*** artifacts (14-day
retention), commits the render state, and the app's continuous loop (or the next
hourly cron) automatically continues any remaining queue.

## Story sheet

https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit

Every non-code tab is parsed tolerantly (English or Arabic labels, any column
order): label rows for Title / Logline / Genre / Duration, scene tables whose
columns are detected by keyword, and optional complete-narration sections. If
parsing finds no scenes, the pipeline falls back to a keyless AI story so it
never breaks.
