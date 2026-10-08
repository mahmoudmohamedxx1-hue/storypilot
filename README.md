# StoryPilot 🎬

**Scheduled AI video factory** — turns every story in a Google Sheet (updated by
the Gemini Spark automation) into **cinematic vertical videos (1080×1920, 60fps
hyperframes)** and publishes them to YouTube, TikTok and Instagram — **on a
schedule, never continuously**. 100% **keyless / free** stack on GitHub Actions.

**Videos are made BY THE CLOCK**: default schedule **11:00, 12:00, 13:00, 15:00,
20:00 Africa/Cairo** (repo variable `SCHEDULE_HOURS` — change it any time, e.g.
`9,11,12,13,15,17,20,22`). At each scheduled hour the factory renders up to
`MAX_VIDEOS_PER_SLOT` videos (default 2): pending sheet stories first, and if the
queue is empty the keyless AI **invents ONE fresh story** so the slot still
produces. Between scheduled hours **nothing is rendered** — no chaining, no
infinite loop, no videos at 3 AM. Finished videos are synced to
**Google Drive** right after they render (deduped).

```
Google Sheet (Gemini Spark)  ←──── synced at every slot
        │
        ▼  .github/workflows/factory.yml  ── hourly :07 tick
┌──────────────────────────────────────────────────────────────┐
│ 0. SCHEDULE GATE (scripts/schedule_gate.py): is this hour in │
│      SCHEDULE_HOURS (Africa/Cairo)? no ──► exit, make NOTHING│
│ 1. Scheduled slot ──► render up to MAX_VIDEOS_PER_SLOT:      │
│      sheet stories first; queue empty ──► the keyless AI     │
│      INVENTS one new 10-scene story and forges it            │
│      (the AI WRITES the renderer code per story: freellmpool │
│      → llm7/Pollinations, self-repair loop, built-in         │
│      cinematic renderer as guaranteed fallback)              │
│ 2. Every finished video:                                     │
│      • artifact upload (mp4 + meta + thumb + story + code)   │
│      • render state committed to the repo (survives runs)    │
│      • Google Drive sync (right after render, hash-deduped)  │
│      • optional YouTube / TikTok / Instagram publishing      │
│ 3. Slot done ──► record it in state/schedule_state.json      │
│      (one video session per scheduled hour, never two)       │
│      ──► STOP. Next videos at the next scheduled hour.       │
└──────────────────────────────────────────────────────────────┘
        ▲ healers: ensure-factory.yml :37 · app heartbeat (scheduled hours only)
```

Manual/on-demand runs (GitHub's *Run workflow*, the app's *Run now*, or asking the
agent) **bypass the schedule** — explicit human intent always makes videos
immediately. `hourly-video.yml` (parallel worker matrix, **no cron**) stays
available for catch-up batches and single library renders.

The app itself chats and polishes stories with **GLM-5.3-Flash via the z.ai SDK**; the
pipeline's AI (story fallback + polish) is **keyless via
[freellmpool](https://github.com/0xzr/freellmpool)**.

## Repo layout

| Path | What it is |
|---|---|
| `.github/workflows/factory.yml` | **THE scheduled factory** — hourly :07 tick + schedule gate + capped slot, then stops |
| `.github/workflows/ensure-factory.yml` | Ensure Scheduled Slot — at :37 heals a scheduled hour whose tick was dropped |
| `.github/workflows/hourly-video.yml` | Parallel worker matrix — manual/on-demand catch-up batches + single renders (no cron) |
| `scripts/schedule_gate.py` | The schedule gate — hour check (Africa/Cairo), slot dedup, manual/agent bypass |
| `scripts/factory.py` | Slot supervisor — sheet sync → forge (capped) → record slot → stop |
| `scripts/ai_forge.py` | Keyless AI code-writer — writes the per-story renderer, self-repairs, validates |
| `scripts/drive_sync.py` + `scripts/drive_webapp.js` | Google Drive sync via your own Apps Script web app |
| `generate_video.py` | Built-in cinematic renderer — `story.json` → `output/output.mp4` |
| `scripts/render_pending.py` | The catch-up queue: shards pending stories across workers, keyless AI polish |
| `scripts/generate_story.py` | Story source: Sheet → keyless freellmpool GLM → fallback |
| `post_video.py` | YouTube / TikTok / Instagram publishers |
| `fonts/` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| `web/` | **The full Kimi-style agent app** (Next.js + Prisma) — chat, Library of generated videos, n8n-style live pipeline view |

## Quickstart

1. **Nothing to start** — the factory ticks hourly and makes videos at the
   scheduled hours automatically. For an immediate run: Actions tab →
   *Scheduled Video Factory* → *Run workflow* (bypasses the schedule once).
   The finished run leaves `output.mp4`, `thumb.jpg` and `meta.json` in the
   `factory-videos` artifact (14-day retention).
2. **Publish to platforms** — add the optional secrets listed in
   [STORYPILOT.md](STORYPILOT.md). Each platform activates as soon as its secrets exist.
3. **Run the web app** —
   ```bash
   cd web
   bun install          # or npm install
   cp .env.example .env # set GITHUB_TOKEN / GITHUB_REPO
   bunx prisma db push
   bun run dev          # Kimi-style UI: chat + Library + live pipeline
   ```

### On schedule, never skipped (self-healing)

Videos are made only at the scheduled hours — and a scheduled hour is never
silently skipped:

| Layer | What | When |
|---|---|---|
| 1. **`factory.yml` :07 tick (primary)** | cron tick → schedule gate → capped slot render | every hour (gate decides) |
| 2. `.github/workflows/ensure-factory.yml` | same gate logic — re-dispatches when a scheduled hour produced nothing | every hour at **:37** |
| 3. StoryPilot app heartbeat | revives a skipped slot, ONLY inside scheduled hours | every 10 min (while the app runs) |
| 4. Slot dedup | `state/schedule_state.json` — one video session per scheduled hour, re-ticks can never double-make | always |

Change the schedule: repo **variable** `SCHEDULE_HOURS` (Settings → Secrets and
variables → Actions → Variables) — e.g. `9,11,13,17,20,22`. No commit needed;
effective on the next hourly tick.

Stop the factory: create `state/FACTORY_STOP` (the app's chat: *"stop the factory"*)
or disable the workflow. Resume: delete the file / re-enable.

### Google Drive sync

Every finished video (`output.mp4`, `meta.json`, `story.json`, `thumb.jpg`,
`ai_renderer.py`) is uploaded to Google Drive via **your own** Apps Script web app —
free, no API keys. One-time setup (~3 min):

1. Open [script.google.com](https://script.google.com) → New project
2. Paste the contents of `scripts/drive_webapp.js`
3. Deploy → New deployment → **Web app** → execute as **me**, access **anyone**
4. Copy the `/exec` URL → repo **Secret** `DRIVE_WEBAPP_URL` (optional `DRIVE_WEBAPP_KEY`)

Sync runs right after every render (throttled by `DRIVE_SYNC_INTERVAL`,
hash-deduped in `state/drive_sync.json`), plus a flush at the end of each slot.
Until the secret is set, the step skips gracefully — rendering never waits on Drive.

Each dispatched hourly-video run fans out to **3 parallel workers** by default (override
with the `workers_json` input or the `WORKERS_JSON` repo variable) — each worker renders
its own shard of the pending queue. Every worker commits its own
`state/videos.shard*.json`, so progress is never lost and workers never collide. The
factory reads the **union** of all state files, so both engines share one done-set.

## Story sheet format (tolerant)

EVERY tab of the
[sheet](https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit)
is parsed **tolerantly** — English or Arabic labels, any column order, multiple stories
per tab:

- Label rows: `Story Title / العنوان`, `Logline`, `Genre`, `Duration`
- A scene table whose columns are detected by keyword
  (`time / duration`, `visual / وصف`, `prompt / برومبت`, `voiceover / التعليق الصوتي`, `sfx`)
- An optional complete-narration section

If no scenes are found (e.g. right after the Spark automation changes), the pipeline
generates a fresh story **keyless** via [freellmpool](https://github.com/0xzr/freellmpool)
(GLM Flash first, auto-failover to live keyless routes) — it never breaks.

## Keyless stack

| Piece | Service | Key needed |
|---|---|---|
| Voiceover | Microsoft Edge TTS (`ar-EG-ShakirNeural`) | none |
| Scene imagery | Pollinations (`flux`) | none |
| Fallback story writer | freellmpool (GLM Flash tier) | none |
| Video | MoviePy + Pillow + ffmpeg | none |
| Automation | GitHub Actions | included |

## Security notes

- Platform tokens live **only** in GitHub Secrets — never in code.
- Rotate any token that was ever pasted in a chat or document.

## The web app (`web/`)

A Kimi-style agent console for the pipeline:

- **Chat** — GLM-5.3-Flash via the z.ai SDK, with tools: fetch stories, sync sheet, make
  videos, trigger workflows, deploy, list repos
- **Library** — every generated video with player, status chips and one-click re-render
- **Pipeline** — n8n-style node canvas with **live** per-step states from GitHub Actions
- **Platforms / Workflows / Settings** — manage tokens, the workflow bundle, the video
  schedule and defaults

See `web/src` for the source; it is a standard Next.js (App Router) + Prisma app.
