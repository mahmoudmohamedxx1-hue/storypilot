#!/usr/bin/env python3
"""Splice the scheduled-mode setup markdown into workflow-yaml.ts
and drop the retired buildEnsureHourlyYaml function."""
import re

PATH = "/home/z/my-project/src/lib/bundle/workflow-yaml.ts"

NEW_MD = """# StoryPilot — Scheduled Video Factory (videos by the clock)

This repo makes videos **on a schedule** — default **11:00, 12:00, 13:00, 15:00, 20:00
Africa/Cairo** — and **never continuously**:

1. **Scheduled Video Factory (\\`.github/workflows/factory.yml\\`)** — ticks hourly at :07.
   The **schedule gate** (\\`scripts/schedule_gate.py\\`) checks whether the current hour
   (Africa/Cairo) is in the \\`SCHEDULE_HOURS\\` variable; outside the schedule the run exits
   in ~20 seconds having made **nothing**. A scheduled slot renders up to
   \\`MAX_VIDEOS_PER_SLOT\\` videos (default 2) and **stops** — no chaining, no infinite loop.
2. **The KEYLESS AI WRITES THE HYPERFRAME CODE** — for every story, \\`scripts/ai_forge.py\\`
   asks a keyless AI (freellmpool pool first: \\`auto\\`, gpt-oss-120b, Qwen3-Coder… then the
   Pollinations text API — no API keys anywhere) to write a COMPLETE Python renderer for that
   specific story: 1080×1920 @ 60fps hyperframes, Edge-TTS narration (ar-EG-ShakirNeural),
   shaped Arabic RTL text, keyless AI scene imagery, ken-burns motion, ffmpeg-pipe streaming.
   The forge sandbox-runs the AI-written script, validates the MP4 with ffprobe, and feeds any
   error back to the AI for a **self-repair** round (3 attempts). The battle-tested built-in
   renderer is the final fallback, so **a video ALWAYS comes out**. Whichever model actually
   wrote the code is recorded in \\`meta.json\\`.
3. **Slot stories** — every sheet tab is re-synced (Spark edits are picked up, hash-tracked in
   \\`state/videos.json\\` so nothing is re-rendered). At a scheduled slot, pending sheet stories
   render first; if the queue is empty and \\`INVENT_WHEN_EMPTY=true\\` (default), the keyless AI
   invents **ONE** fresh story (rotating Arabic finance topics, no repeats) so the slot still
   produces a video. Set \\`INVENT_WHEN_EMPTY=false\\` to render only what the sheet holds.
4. **Publish everywhere** — every finished video posts to YouTube, TikTok and Instagram Reels
   (each platform activates as soon as its secrets exist).
5. **Google Drive sync** — every finished video is uploaded right after it renders (deduped in
   \\`state/drive_sync.json\\`) plus a flush at the end of each slot. One-time 3-minute setup via
   your own Apps Script web app — see **Google Drive backup** below.

\\`hourly-video.yml\\` is the **manual/on-demand** renderer (the app's Library **Make video**
button and manual batch catch-up) — it has **no cron**.

## Changing the schedule (not just static)

- **Repo variable** \\`SCHEDULE_HOURS\\` — Settings → Secrets and variables → Actions →
  Variables → e.g. \\`9,11,12,13,15,17,20,22\\`. Takes effect on the next hourly tick, no
  commit needed.
- **Or in the app**: Settings → Video schedule → Save → **Deploy files** (Pipeline view) —
  the app pushes the files AND the \\`SCHEDULE_HOURS\\` variable together.
- Manual runs ("Run workflow" in GitHub, the app's Run now button, or asking the agent)
  **bypass the schedule** — explicit human intent always makes videos immediately.

## Reliability layers (a scheduled hour is never silently skipped)

| Layer | What it does |
|---|---|
| \\`:07\\` hourly tick | factory.yml cron — the gate decides; slot dedup means a re-tick can never double-make |
| ensure-factory.yml | \\`:37\\` every hour — same gate logic: re-dispatches the factory if a scheduled slot produced nothing |
| App heartbeat | while the StoryPilot app runs: revives a skipped slot, ONLY inside scheduled hours |
| Singleton guard + concurrency group | never two factories at once; queued noise auto-collapses |

## Files

| File | Purpose |
|---|---|
| \\`.github/workflows/factory.yml\\` | **THE scheduled factory** — hourly tick + schedule gate + capped slot |
| \\`.github/workflows/ensure-factory.yml\\` | Slot watcher — heals a skipped scheduled hour at :37 |
| \\`scripts/schedule_gate.py\\` | The schedule gate: hour check (Africa/Cairo) + slot dedup + manual bypass |
| \\`scripts/factory.py\\` | Slot supervisor: sync → forge (up to the cap) → record slot → stop |
| \\`scripts/ai_forge.py\\` | **Keyless AI code-writer**: AI writes the hyperframe renderer per story, sandbox-run + self-repair + fallback |
| \\`scripts/drive_sync.py\\` | Google Drive upload of every finished video (deduped, never blocks rendering) |
| \\`scripts/drive_webapp.js\\` | The Apps Script you paste into script.google.com (one-time Drive setup) |
| \\`.github/workflows/hourly-video.yml\\` | Manual/on-demand renders (single story / batch catch-up, 3 parallel workers) |
| \\`scripts/render_pending.py\\` | Batch queue used by hourly-video (same parser/state as the factory) |
| \\`scripts/generate_story.py\\` | Single-story source: Google Sheet (tolerant parser) → keyless AI → fallback |
| \\`generate_video.py\\` | Built-in cinematic renderer (the guaranteed fallback): \\`story.json\\` → 1080×1920 60fps MP4 |
| \\`state/videos*.json\\` | Render state committed by the bot — which stories already have videos (the factory reads the UNION of videos.json + every shard file) |
| \\`state/schedule_state.json\\` | Slot ledger — one record per scheduled hour (the gate's dedup) |
| \\`state/factory_status.json\\` | Live factory status (phase, slot, queue depth, Drive sync) — read by the app |
| \\`state/drive_sync.json\\` | Drive sync dedup state — which video folders were already uploaded |
| \\`fonts/\\` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| \\`post_video.py\\` | Posts to YouTube / TikTok / Instagram |
| \\`requirements.txt\\` | Python dependencies (all free / keyless) |
| \\`web/\\` | The full Kimi-style agent app (Next.js) source |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| \\`YOUTUBE_REFRESH_TOKEN\\` | YouTube | OAuth playground with \\`youtube.upload\\` scope |
| \\`YOUTUBE_CLIENT_ID\\` | YouTube | Google Cloud Console → OAuth client |
| \\`YOUTUBE_CLIENT_SECRET\\` | YouTube | Google Cloud Console → OAuth client |
| \\`TIKTOK_ACCESS_TOKEN\\` | TikTok | TikTok for Developers → Content Posting API |
| \\`INSTAGRAM_ACCESS_TOKEN\\` | Instagram | Meta Graph API (IG business account) |
| \\`INSTAGRAM_USER_ID\\` | Instagram | Your Instagram Business account id |
| \\`DRIVE_WEBAPP_URL\\` | Google Drive | The \\`/exec\\` URL of your Apps Script web app (see below) |
| \\`DRIVE_WEBAPP_KEY\\` | Google Drive | Optional shared secret you set as \\`KEY\\` in the Apps Script |

### Google Drive backup (one-time, ~3 minutes, no OAuth keys)

Every finished video lands in **StoryPilot Videos / <date> <title> [<id>]/** in your Drive,
right after it renders. Setup:

1. Open [script.google.com](https://script.google.com) (the account that owns the Spark sheet) → **New project**.
2. Delete everything in \\`Code.gs\\` and paste the contents of \\`scripts/drive_webapp.js\\` from this repo.
3. *(Optional)* set \\`KEY\\` in the script to a long random string — you will reuse it as the \\`DRIVE_WEBAPP_KEY\\` secret.
4. **Deploy → New deployment → Web app**: *Execute as*: **Me**, *Who has access*: **Anyone** → Deploy → authorize the Drive scope → copy the **/exec URL**.
5. Put that URL in the \\`DRIVE_WEBAPP_URL\\` secret (repo settings, or paste it in the app's **Platforms → Google Drive** card and hit *Save & push secrets*).

Done — each video bundle (\\`output.mp4\\`, \\`meta.json\\`, \\`story.json\\`,
\\`thumb.jpg\\`, \\`ai_renderer.py\\`) is uploaded as soon as it renders, with a flush at
the end of every slot. Failed uploads retry on the next tick and never block video production.

### Optional repository variables

| Variable | Default | Meaning |
|---|---|---|
| \\`SCHEDULE_HOURS\\` | \\`11,12,13,15,20\\` | Hours (Africa/Cairo) when videos are made — the schedule |
| \\`MAX_VIDEOS_PER_SLOT\\` | \\`2\\` | Videos per scheduled slot |
| \\`INVENT_WHEN_EMPTY\\` | \\`true\\` | Keyless AI invents ONE story when the queue is empty |
| \\`FLP_MODEL\\` | \\`auto\\` | Keyless model tried first for code/story writing (freellmpool) |
| \\`AI_ATTEMPTS\\` | \\`3\\` | Self-repair rounds when the AI-written renderer fails |
| \\`FACTORY_BUDGET_MIN\\` | \\`45\\` | Minutes per slot run |
| \\`SHEET_ID\\` | the Spark sheet | Google Sheet id with the stories |
| \\`TTS_VOICE_AR\\` | \\`ar-EG-ShakirNeural\\` | Edge-TTS Arabic voice |
| \\`ENABLE_AI_IMAGES\\` | \\`true\\` | Keyless AI scene imagery (Pollinations) |
| \\`IMAGE_MODEL\\` | \\`flux\\` | Pollinations image model (\\`flux\\` / \\`turbo\\`) |
| \\`FRAME_RATE\\` | \\`60\\` | Hyperframes — 60fps silky motion (set \\`24\\` for the old rate) |
| \\`DRIVE_ROOT_FOLDER\\` | \\`StoryPilot Videos\\` | Drive folder name for the video backup |
| \\`DRIVE_SYNC_INTERVAL\\` | \\`3600\\` | Seconds between Drive sync passes |
| \\`YOUTUBE_PRIVACY\\` | \\`public\\` | \\`public\\` / \\`unlisted\\` / \\`private\\` |
| \\`TIKTOK_PRIVACY\\` | \\`SELF_ONLY\\` | \\`SELF_ONLY\\` until your TikTok app is approved |

## Run it now

Actions tab → **Scheduled Video Factory** → **Run workflow** — this one run bypasses the
schedule and renders a slot immediately. Otherwise just wait: the next videos arrive at the
next scheduled hour. **Stop everything:** create the file \\`state/FACTORY_STOP\\` (or ask the
app: "stop the factory") or disable the workflow.

Every run leaves its rendered MP4s (one folder per video: \\`output.mp4\\`, \\`meta.json\\`,
\\`thumb.jpg\\`, \\`story.json\\` and \\`ai_renderer.py\\` — the code the AI wrote) in the
**factory-videos** artifact (14-day retention), and commits the render state + live factory
status back to this repo."""

with open(PATH, encoding="utf-8") as f:
    src = f.read()

# 1. replace the markdown body between the opening backtick after buildSetupMd's return
#    and the "## Story sheet" section (which we keep)
#    UNIQUE marker: the em-dash title exists only inside buildSetupMd
start_marker = "  return `# StoryPilot — Continuous Video Factory (infinite loop)"
end_marker = "\n## Story sheet"
i = src.index(start_marker)
j = src.index(end_marker, i)
src = src[:i] + "  return `" + NEW_MD + src[j:]

# 2. drop the retired buildEnsureHourlyYaml function entirely
m = re.search(r"\nexport function buildEnsureHourlyYaml\(\): string \{.*?\n\}\n", src, re.S)
if m:
    src = src[:m.start()] + "\n" + src[m.end():]
    print("buildEnsureHourlyYaml removed")
else:
    print("WARNING: buildEnsureHourlyYaml not found")

with open(PATH, "w", encoding="utf-8") as f:
    f.write(src)
print("workflow-yaml.ts updated:", len(src), "chars")
