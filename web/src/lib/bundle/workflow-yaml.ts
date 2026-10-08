export function buildWorkflowYaml(opts: { sheetId: string; flpModel: string; voice: string }): string {
  return `# StoryPilot - On-demand Story -> MP4 -> YouTube/TikTok/Instagram (MANUAL ONLY)
# Deployed by the StoryPilot agent app.
#
# NO SCHEDULE: videos are made on the SCHEDULE (factory.yml + SCHEDULE_HOURS,
# default 11:00, 12:00, 13:00, 15:00, 20:00 Africa/Cairo). This workflow is
# the manual catch-up tool: run it from the StoryPilot app (Library "Make
# video" button) or GitHub's "Run workflow" button when you want a batch
# RIGHT NOW (e.g. after adding many stories to the Spark sheet).
# Every run fans out to N PARALLEL WORKERS (GitHub Actions matrix). Each
# worker renders ITS OWN shard of the pending sheet stories (tracked in
# state/videos*.json, committed back to this repo). Edited stories change
# their content-hash and re-queue automatically. Hyperframes = 60fps.
# Keyless AI: freellmpool polishes voiceovers + writes platform metadata.
name: On-demand Story Video

on:
  workflow_dispatch:
    inputs:
      workers_json:
        description: "Parallel workers as JSON array, e.g. [\\"0\\",\\"1\\",\\"2\\"]"
        type: string
        default: ""
      batch:
        description: "Render ALL pending sheet stories (catch-up queue)"
        type: boolean
        default: true
      max_videos:
        description: "Max videos per WORKER (time budget still applies)"
        type: number
        default: 4
      use_ai_story:
        description: "Generate a fresh story with keyless GLM (ignore the Sheet)"
        type: boolean
        default: false
      topic:
        description: "Topic for the AI story (optional)"
        default: ""
      story_json:
        description: "Full story JSON from the StoryPilot library (skips sheet parsing)"
        default: ""
        type: string

permissions:
  contents: write # commit render state (state/videos*.json) after each run

concurrency:
  group: hourly-video
  cancel-in-progress: false

jobs:
  render:
    runs-on: ubuntu-latest
    timeout-minutes: 50
    strategy:
      fail-fast: false
      matrix:
        # N parallel workers, each owning an interleaved shard of the pending queue.
        # Dispatched by the app with workers_json; crons fall back to 3 workers.
        worker: \${{ fromJSON(inputs.workers_json || vars.WORKERS_JSON || '["0","1","2"]') }}
    env:
      # secrets/vars mapped at job level — step-level if: may only read the env context
      FRAME_RATE: \${{ vars.FRAME_RATE || '60' }} # hyperframes
      AI_ENHANCE: \${{ vars.AI_ENHANCE || 'true' }} # keyless AI polish pass
      LLM7_MODEL: \${{ vars.LLM7_MODEL || 'GLM-5.3-Flash' }} # keyless direct fallback (llm7.io)
      RENDER_MODE: batch
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip

      - name: Install system deps (ffmpeg + fonts incl. Arabic)
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core fonts-noto-ui-core || true

      - name: Install Python deps
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt

      - name: Select render mode
        run: |
          if [ "\${{ github.event_name }}" = "workflow_dispatch" ]; then
            if [ -n "\${{ inputs.story_json }}" ] || [ "\${{ inputs.use_ai_story }}" = "true" ] || [ "\${{ inputs.batch }}" = "false" ]; then
              echo "RENDER_MODE=single" >> "$GITHUB_ENV"
              echo "mode: single (one explicit story)"
            else
              echo "RENDER_MODE=batch" >> "$GITHUB_ENV"
              echo "mode: batch (catch-up queue, worker \${{ matrix.worker }})"
            fi
          else
            echo "RENDER_MODE=batch" >> "$GITHUB_ENV"
            echo "mode: batch (catch-up queue, worker \${{ matrix.worker }})"
          fi

      # ---------------- single mode: one explicit story (library dispatch / AI story) ----------------
      - name: Prepare story (Google Sheet by Gemini Spark + keyless GLM fallback)
        if: matrix.worker == '0' && env.RENDER_MODE == 'single'
        env:
          SHEET_ID: \${{ vars.SHEET_ID || '${opts.sheetId}' }}
          FLP_MODEL: \${{ vars.FLP_MODEL || 'glm-4.7-flash' }}
          LLM7_MODEL: \${{ vars.LLM7_MODEL || 'GLM-5.3-Flash' }}
          USE_AI_STORY: \${{ github.event_name == 'workflow_dispatch' && inputs.use_ai_story || 'false' }}
          STORY_TOPIC: \${{ github.event_name == 'workflow_dispatch' && inputs.topic || '' }}
          STORY_JSON: \${{ github.event_name == 'workflow_dispatch' && inputs.story_json || '' }}
        run: python scripts/generate_story.py

      - name: Render cinematic MP4 (keyless AI images + Edge-TTS + MoviePy, 1080x1920)
        if: matrix.worker == '0' && env.RENDER_MODE == 'single'
        env:
          TTS_VOICE_AR: \${{ vars.TTS_VOICE_AR || '${opts.voice}' }}
          ENABLE_AI_IMAGES: \${{ vars.ENABLE_AI_IMAGES || 'true' }}
          IMAGE_MODEL: \${{ vars.IMAGE_MODEL || 'flux' }}
        run: python generate_video.py

      - name: Upload video artifact
        if: matrix.worker == '0' && env.RENDER_MODE == 'single'
        uses: actions/upload-artifact@v4
        with:
          name: hourly-video
          path: |
            output/output.mp4
            output/meta.json
            output/thumb.jpg
          retention-days: 14
          if-no-files-found: error

      # ---------------- batch mode: every worker renders ITS shard of the pending queue ----------------
      - name: Render pending stories (worker shard, keyless AI polish, hyperframes)
        if: env.RENDER_MODE == 'batch'
        env:
          SHEET_ID: \${{ vars.SHEET_ID || '${opts.sheetId}' }}
          FLP_MODEL: \${{ vars.FLP_MODEL || 'glm-4.7-flash' }}
          LLM7_MODEL: \${{ vars.LLM7_MODEL || 'GLM-5.3-Flash' }}
          TTS_VOICE_AR: \${{ vars.TTS_VOICE_AR || '${opts.voice}' }}
          ENABLE_AI_IMAGES: \${{ vars.ENABLE_AI_IMAGES || 'true' }}
          IMAGE_MODEL: \${{ vars.IMAGE_MODEL || 'flux' }}
          BUDGET_MIN: \${{ vars.BUDGET_MIN || '36' }}
          MAX_VIDEOS: \${{ inputs.max_videos || vars.MAX_VIDEOS || '4' }}
          SHARD_INDEX: \${{ matrix.worker }}
          NUM_SHARDS: \${{ strategy.job-total }}
        run: python scripts/render_pending.py

      - name: Upload batch video artifacts
        if: always() && env.RENDER_MODE == 'batch'
        uses: actions/upload-artifact@v4
        with:
          name: hourly-video-w\${{ matrix.worker }}
          path: |
            videos/*/output.mp4
            videos/*/meta.json
            videos/*/thumb.jpg
            videos/*/story.json
          retention-days: 14
          if-no-files-found: warn

      - name: Commit render state
        if: always() && env.RENDER_MODE == 'batch'
        run: |
          shopt -s nullglob
          files=(state/videos*.json)
          if [ \${#files[@]} -eq 0 ]; then echo "no state files - nothing to commit"; exit 0; fi
          git config user.name "storypilot-bot"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add state/videos*.json
          if git diff --cached --quiet; then
            echo "render state unchanged"
            exit 0
          fi
          git commit -m "chore: render state update (worker \${{ matrix.worker }}) [skip ci]"
          # the repo may have moved on since checkout (deploys / sibling workers) - rebase and retry
          for i in 1 2 3 4; do
            if git pull --rebase origin main && git push; then
              echo "render state committed"
              exit 0
            fi
            echo "push attempt $i rejected - rebasing and retrying..."
            git rebase --abort 2>/dev/null || true
            sleep 5
          done
          # never fail the run for the state file: videos are already in the artifact,
          # and the worst case is one duplicate re-render on the next run
          echo "::warning::could not push render state - next run may re-render these stories (harmless)"

  # ---------------- publish: post EVERY rendered video to the platforms ----------------
  publish:
    needs: render
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      YOUTUBE_REFRESH_TOKEN: \${{ secrets.YOUTUBE_REFRESH_TOKEN }}
      YOUTUBE_CLIENT_ID: \${{ secrets.YOUTUBE_CLIENT_ID }}
      YOUTUBE_CLIENT_SECRET: \${{ secrets.YOUTUBE_CLIENT_SECRET }}
      TIKTOK_ACCESS_TOKEN: \${{ secrets.TIKTOK_ACCESS_TOKEN }}
      INSTAGRAM_ACCESS_TOKEN: \${{ secrets.INSTAGRAM_ACCESS_TOKEN }}
      INSTAGRAM_USER_ID: \${{ secrets.INSTAGRAM_USER_ID }}
      YOUTUBE_PRIVACY: \${{ vars.YOUTUBE_PRIVACY || 'public' }}
      TIKTOK_PRIVACY: \${{ vars.TIKTOK_PRIVACY || 'SELF_ONLY' }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"

      - name: Install Python deps
        run: pip install requests

      - name: Download all rendered videos (every worker artifact)
        uses: actions/download-artifact@v4
        with:
          pattern: hourly-video*
          path: dist
          merge-multiple: false

      - name: Post to YouTube
        if: env.YOUTUBE_REFRESH_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          posted=0
          for d in dist/*/ dist/*/*/ videos/*/; do
            [ -f "$d/output.mp4" ] || continue
            echo "[youtube] posting $d"
            VIDEO_PATH="$d/output.mp4" META_PATH="$d/meta.json" python post_video.py --youtube \\
              && posted=$((posted+1)) \\
              || echo "::warning::failed to post $d to YouTube"
          done
          echo "posted $posted videos to YouTube"

      - name: Post to TikTok
        if: env.TIKTOK_ACCESS_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in dist/*/ dist/*/*/ videos/*/; do
            [ -f "$d/output.mp4" ] || continue
            echo "[tiktok] posting $d"
            VIDEO_PATH="$d/output.mp4" META_PATH="$d/meta.json" python post_video.py --tiktok \\
              || echo "::warning::failed to post $d to TikTok"
          done

      - name: Post to Instagram Reels
        if: env.INSTAGRAM_ACCESS_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in dist/*/ dist/*/*/ videos/*/; do
            [ -f "$d/output.mp4" ] || continue
            echo "[instagram] posting $d"
            VIDEO_PATH="$d/output.mp4" META_PATH="$d/meta.json" python post_video.py --instagram \\
              || echo "::warning::failed to post $d to Instagram"
          done
`
}

export const REQUIREMENTS_TXT = `# StoryPilot hourly pipeline - all free / keyless
edge-tts>=6.1.0
moviepy>=2.0.0
pillow>=10.0.0
numpy>=1.24.0
arabic-reshaper>=3.0.0
python-bidi>=0.4.2
requests>=2.31.0
freellmpool>=0.13.0
`

export function buildSetupMd(opts: { repo: string; sheetUrl: string }): string {
  return `# StoryPilot — Scheduled Video Factory (videos by the clock)

This repo makes videos **on a schedule** — default **11:00, 12:00, 13:00, 15:00, 20:00
Africa/Cairo** — and **never continuously**:

1. **Scheduled Video Factory (\`.github/workflows/factory.yml\`)** — ticks hourly at :07.
   The **schedule gate** (\`scripts/schedule_gate.py\`) checks whether the current hour
   (Africa/Cairo) is in the \`SCHEDULE_HOURS\` variable; outside the schedule the run exits
   in ~20 seconds having made **nothing**. A scheduled slot renders up to
   \`MAX_VIDEOS_PER_SLOT\` videos (default 2) and **stops** — no chaining, no infinite loop.
2. **The KEYLESS AI WRITES THE HYPERFRAME CODE** — for every story, \`scripts/ai_forge.py\`
   asks a keyless AI (freellmpool pool first: \`auto\`, gpt-oss-120b, Qwen3-Coder… then the
   Pollinations text API — no API keys anywhere) to write a COMPLETE Python renderer for that
   specific story: 1080×1920 @ 60fps hyperframes, Edge-TTS narration (ar-EG-ShakirNeural),
   shaped Arabic RTL text, keyless AI scene imagery, ken-burns motion, ffmpeg-pipe streaming.
   The forge sandbox-runs the AI-written script, validates the MP4 with ffprobe, and feeds any
   error back to the AI for a **self-repair** round (3 attempts). The battle-tested built-in
   renderer is the final fallback, so **a video ALWAYS comes out**. Whichever model actually
   wrote the code is recorded in \`meta.json\`.
3. **Slot stories** — every sheet tab is re-synced (Spark edits are picked up, hash-tracked in
   \`state/videos.json\` so nothing is re-rendered). At a scheduled slot, pending sheet stories
   render first; if the queue is empty and \`INVENT_WHEN_EMPTY=true\` (default), the keyless AI
   invents **ONE** fresh story (rotating Arabic finance topics, no repeats) so the slot still
   produces a video. Set \`INVENT_WHEN_EMPTY=false\` to render only what the sheet holds.
4. **Publish everywhere** — every finished video posts to YouTube, TikTok and Instagram Reels
   (each platform activates as soon as its secrets exist).
5. **Google Drive sync** — every finished video is uploaded right after it renders (deduped in
   \`state/drive_sync.json\`) plus a flush at the end of each slot. One-time 3-minute setup via
   your own Apps Script web app — see **Google Drive backup** below.

\`hourly-video.yml\` is the **manual/on-demand** renderer (the app's Library **Make video**
button and manual batch catch-up) — it has **no cron**.

## Changing the schedule (not just static)

- **Repo variable** \`SCHEDULE_HOURS\` — Settings → Secrets and variables → Actions →
  Variables → e.g. \`9,11,12,13,15,17,20,22\`. Takes effect on the next hourly tick, no
  commit needed.
- **Or in the app**: Settings → Video schedule → Save → **Deploy files** (Pipeline view) —
  the app pushes the files AND the \`SCHEDULE_HOURS\` variable together.
- Manual runs ("Run workflow" in GitHub, the app's Run now button, or asking the agent)
  **bypass the schedule** — explicit human intent always makes videos immediately.

## Reliability layers (a scheduled hour is never silently skipped)

| Layer | What it does |
|---|---|
| \`:07\` hourly tick | factory.yml cron — the gate decides; slot dedup means a re-tick can never double-make |
| ensure-factory.yml | \`:37\` every hour — same gate logic: re-dispatches the factory if a scheduled slot produced nothing |
| App heartbeat | while the StoryPilot app runs: revives a skipped slot, ONLY inside scheduled hours |
| Singleton guard + concurrency group | never two factories at once; queued noise auto-collapses |

## Files

| File | Purpose |
|---|---|
| \`.github/workflows/factory.yml\` | **THE scheduled factory** — hourly tick + schedule gate + capped slot |
| \`.github/workflows/ensure-factory.yml\` | Slot watcher — heals a skipped scheduled hour at :37 |
| \`scripts/schedule_gate.py\` | The schedule gate: hour check (Africa/Cairo) + slot dedup + manual bypass |
| \`scripts/factory.py\` | Slot supervisor: sync → forge (up to the cap) → record slot → stop |
| \`scripts/ai_forge.py\` | **Keyless AI code-writer**: AI writes the hyperframe renderer per story, sandbox-run + self-repair + fallback |
| \`scripts/drive_sync.py\` | Google Drive upload of every finished video (deduped, never blocks rendering) |
| \`scripts/drive_webapp.js\` | The Apps Script you paste into script.google.com (one-time Drive setup) |
| \`.github/workflows/hourly-video.yml\` | Manual/on-demand renders (single story / batch catch-up, 3 parallel workers) |
| \`scripts/render_pending.py\` | Batch queue used by hourly-video (same parser/state as the factory) |
| \`scripts/generate_story.py\` | Single-story source: Google Sheet (tolerant parser) → keyless AI → fallback |
| \`generate_video.py\` | Built-in cinematic renderer (the guaranteed fallback): \`story.json\` → 1080×1920 60fps MP4 |
| \`state/videos*.json\` | Render state committed by the bot — which stories already have videos (the factory reads the UNION of videos.json + every shard file) |
| \`state/schedule_state.json\` | Slot ledger — one record per scheduled hour (the gate's dedup) |
| \`state/factory_status.json\` | Live factory status (phase, slot, queue depth, Drive sync) — read by the app |
| \`state/drive_sync.json\` | Drive sync dedup state — which video folders were already uploaded |
| \`fonts/\` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| \`post_video.py\` | Posts to YouTube / TikTok / Instagram |
| \`requirements.txt\` | Python dependencies (all free / keyless) |
| \`web/\` | The full Kimi-style agent app (Next.js) source |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| \`YOUTUBE_REFRESH_TOKEN\` | YouTube | OAuth playground with \`youtube.upload\` scope |
| \`YOUTUBE_CLIENT_ID\` | YouTube | Google Cloud Console → OAuth client |
| \`YOUTUBE_CLIENT_SECRET\` | YouTube | Google Cloud Console → OAuth client |
| \`TIKTOK_ACCESS_TOKEN\` | TikTok | TikTok for Developers → Content Posting API |
| \`INSTAGRAM_ACCESS_TOKEN\` | Instagram | Meta Graph API (IG business account) |
| \`INSTAGRAM_USER_ID\` | Instagram | Your Instagram Business account id |
| \`DRIVE_WEBAPP_URL\` | Google Drive | The \`/exec\` URL of your Apps Script web app (see below) |
| \`DRIVE_WEBAPP_KEY\` | Google Drive | Optional shared secret you set as \`KEY\` in the Apps Script |

### Google Drive backup (one-time, ~3 minutes, no OAuth keys)

Every finished video lands in **StoryPilot Videos / <date> <title> [<id>]/** in your Drive,
right after it renders. Setup:

1. Open [script.google.com](https://script.google.com) (the account that owns the Spark sheet) → **New project**.
2. Delete everything in \`Code.gs\` and paste the contents of \`scripts/drive_webapp.js\` from this repo.
3. *(Optional)* set \`KEY\` in the script to a long random string — you will reuse it as the \`DRIVE_WEBAPP_KEY\` secret.
4. **Deploy → New deployment → Web app**: *Execute as*: **Me**, *Who has access*: **Anyone** → Deploy → authorize the Drive scope → copy the **/exec URL**.
5. Put that URL in the \`DRIVE_WEBAPP_URL\` secret (repo settings, or paste it in the app's **Platforms → Google Drive** card and hit *Save & push secrets*).

Done — each video bundle (\`output.mp4\`, \`meta.json\`, \`story.json\`,
\`thumb.jpg\`, \`ai_renderer.py\`) is uploaded as soon as it renders, with a flush at
the end of every slot. Failed uploads retry on the next tick and never block video production.

### Optional repository variables

| Variable | Default | Meaning |
|---|---|---|
| \`SCHEDULE_HOURS\` | \`11,12,13,15,20\` | Hours (Africa/Cairo) when videos are made — the schedule |
| \`MAX_VIDEOS_PER_SLOT\` | \`2\` | Videos per scheduled slot |
| \`INVENT_WHEN_EMPTY\` | \`true\` | Keyless AI invents ONE story when the queue is empty |
| \`FLP_MODEL\` | \`auto\` | Keyless model tried first for code/story writing (freellmpool) |
| \`AI_ATTEMPTS\` | \`3\` | Self-repair rounds when the AI-written renderer fails |
| \`FACTORY_BUDGET_MIN\` | \`45\` | Minutes per slot run |
| \`SHEET_ID\` | the Spark sheet | Google Sheet id with the stories |
| \`TTS_VOICE_AR\` | \`ar-EG-ShakirNeural\` | Edge-TTS Arabic voice |
| \`ENABLE_AI_IMAGES\` | \`true\` | Keyless AI scene imagery (Pollinations) |
| \`IMAGE_MODEL\` | \`flux\` | Pollinations image model (\`flux\` / \`turbo\`) |
| \`FRAME_RATE\` | \`60\` | Hyperframes — 60fps silky motion (set \`24\` for the old rate) |
| \`DRIVE_ROOT_FOLDER\` | \`StoryPilot Videos\` | Drive folder name for the video backup |
| \`DRIVE_SYNC_INTERVAL\` | \`3600\` | Seconds between Drive sync passes |
| \`YOUTUBE_PRIVACY\` | \`public\` | \`public\` / \`unlisted\` / \`private\` |
| \`TIKTOK_PRIVACY\` | \`SELF_ONLY\` | \`SELF_ONLY\` until your TikTok app is approved |

## Run it now

Actions tab → **Scheduled Video Factory** → **Run workflow** — this one run bypasses the
schedule and renders a slot immediately. Otherwise just wait: the next videos arrive at the
next scheduled hour. **Stop everything:** create the file \`state/FACTORY_STOP\` (or ask the
app: "stop the factory") or disable the workflow.

Every run leaves its rendered MP4s (one folder per video: \`output.mp4\`, \`meta.json\`,
\`thumb.jpg\`, \`story.json\` and \`ai_renderer.py\` — the code the AI wrote) in the
**factory-videos** artifact (14-day retention), and commits the render state + live factory
status back to this repo.
## Story sheet


${opts.sheetUrl}

EVERY non-code tab is parsed tolerantly (English or Arabic labels, any column order):
label rows for Title / Logline / Genre / Duration, a scene table whose columns are
detected by keyword (time, visual, prompt, voiceover, sfx — Arabic or English), and an
optional complete-narration section. If parsing finds no scenes, the pipeline falls
back to a keyless AI story so it never breaks.
`
}

