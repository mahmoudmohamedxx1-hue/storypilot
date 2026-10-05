export function buildWorkflowYaml(opts: { sheetId: string; flpModel: string; voice: string }): string {
  return `# StoryPilot - Hourly Story -> MP4 -> YouTube/TikTok/Instagram
# Deployed by the StoryPilot agent app. Runs every hour on GitHub Actions.
#
# CONTINUOUS FACTORY (default): every run fans out to N PARALLEL WORKERS
# (GitHub Actions matrix). Each worker renders ITS OWN shard of the pending
# sheet stories (tracked in state/videos*.json, committed back to this repo)
# until EVERY story in the sheet has a video. The StoryPilot app's continuous
# render loop dispatches this workflow back-to-back — not just hourly — so
# videos are generated continuously while stories are pending. Edited stories
# change their content-hash and re-queue automatically. Hyperframes = 60fps.
# Keyless AI: freellmpool polishes voiceovers + writes platform metadata.
name: Hourly Story Video

on:
  schedule:
    # Off-peak minute: GitHub Actions drops/delays start-of-hour crons under load
    # (see docs: "High load times include the start of every hour").
    - cron: "47 * * * *" # every hour at :47 (UTC) — backup layer; the app loop is primary
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
          FLP_MODEL: \${{ vars.FLP_MODEL || '${opts.flpModel}' }}
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
          FLP_MODEL: \${{ vars.FLP_MODEL || '${opts.flpModel}' }}
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
            [ -f "\$d/output.mp4" ] || continue
            echo "[youtube] posting \$d"
            VIDEO_PATH="\$d/output.mp4" META_PATH="\$d/meta.json" python post_video.py --youtube \\
              && posted=\$((posted+1)) \\
              || echo "::warning::failed to post \$d to YouTube"
          done
          echo "posted \$posted videos to YouTube"

      - name: Post to TikTok
        if: env.TIKTOK_ACCESS_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in dist/*/ dist/*/*/ videos/*/; do
            [ -f "\$d/output.mp4" ] || continue
            echo "[tiktok] posting \$d"
            VIDEO_PATH="\$d/output.mp4" META_PATH="\$d/meta.json" python post_video.py --tiktok \\
              || echo "::warning::failed to post \$d to TikTok"
          done

      - name: Post to Instagram Reels
        if: env.INSTAGRAM_ACCESS_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in dist/*/ dist/*/*/ videos/*/; do
            [ -f "\$d/output.mp4" ] || continue
            echo "[instagram] posting \$d"
            VIDEO_PATH="\$d/output.mp4" META_PATH="\$d/meta.json" python post_video.py --instagram \\
              || echo "::warning::failed to post \$d to Instagram"
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
  return `# StoryPilot — Continuous Story Video Factory

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

Single-story renders are still available: dispatch the workflow with \`use_ai_story\`
or a \`story_json\` payload (the app's **Make video** button uses this).

## Files

| File | Purpose |
|---|---|
| \`.github/workflows/hourly-video.yml\` | The render workflow — parallel worker matrix + publish job |
| \`.github/workflows/ensure-hourly.yml\` | Backup watcher — re-dispatches when the last run goes stale |
| \`scripts/render_pending.py\` | Batch queue: shards the pending stories across workers and renders them |
| \`scripts/generate_story.py\` | Single-story source: Google Sheet (tolerant parser) → keyless GLM → fallback |
| \`generate_video.py\` | Cinematic renderer: \`story.json\` → 1080×1920 60fps MP4 |
| \`state/videos*.json\` | Render state committed by the bot — which stories already have videos |
| \`fonts/\` | Bundled Arabic fonts (Cairo, Noto Sans Arabic, Amiri, Montserrat) |
| \`post_video.py\` | Posts to YouTube / TikTok / Instagram |
| \`requirements.txt\` | Python dependencies |
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

### Optional repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Meaning |
|---|---|---|
| \`FLP_MODEL\` | \`glm-4.7-flash\` | freellmpool model tried first for story generation & polish |
| \`LLM7_MODEL\` | \`GLM-5.3-Flash\` | Keyless direct fallback for polish/story-gen (llm7.io, no API key) |
| \`SHEET_ID\` | the Spark sheet | Google Sheet id with the hourly story |
| \`TTS_VOICE_AR\` | \`ar-EG-ShakirNeural\` | Edge-TTS Arabic voice |
| \`ENABLE_AI_IMAGES\` | \`true\` | Keyless AI scene imagery (Pollinations) |
| \`IMAGE_MODEL\` | \`flux\` | Pollinations image model (\`flux\` / \`turbo\`) |
| \`FRAME_RATE\` | \`60\` | Hyperframes — 60fps silky motion (set \`24\` for the old rate) |
| \`AI_ENHANCE\` | \`true\` | Keyless AI polish of voiceovers + platform metadata before render |
| \`BUDGET_MIN\` | \`36\` | Minutes each worker spends rendering per run |
| \`MAX_VIDEOS\` | \`4\` | Max videos rendered **per worker** per run |
| \`WORKERS_JSON\` | \`["0","1","2"]\` | Parallel workers for cron-triggered runs (app dispatches override) |
| \`YOUTUBE_PRIVACY\` | \`public\` | \`public\` / \`unlisted\` / \`private\` |
| \`TIKTOK_PRIVACY\` | \`SELF_ONLY\` | \`SELF_ONLY\` until your TikTok app is approved |

## Run it now

Actions tab → **Hourly Story Video** → **Run workflow**.
Every run leaves its rendered MP4s (one folder per video: \`output.mp4\`, \`meta.json\`,
\`thumb.jpg\`, \`story.json\`) in per-worker **hourly-video-w\*** artifacts (14-day
retention), commits the render state, and the app's continuous loop (or the next
hourly cron) automatically continues any remaining queue.

## Story sheet

${opts.sheetUrl}

Every non-code tab is parsed tolerantly (English or Arabic labels, any column
order): label rows for Title / Logline / Genre / Duration, scene tables whose
columns are detected by keyword, and optional complete-narration sections. If
parsing finds no scenes, the pipeline falls back to a keyless AI story so it
never breaks.
`
}

export function buildEnsureHourlyYaml(): string {
  return `# StoryPilot - Self-healing hourly scheduler (backup layer)
# GitHub cron is best-effort and heavily throttled on some accounts (ticks get
# silently dropped). This watcher runs at a DIFFERENT minute than the main
# render cron; if the last "Hourly Story Video" run is stale (> 60 min) or
# missing, it re-dispatches the workflow so an hourly video is never silently
# skipped. The StoryPilot app's continuous render loop is the PRIMARY layer.
name: Ensure Hourly Video

on:
  schedule:
    - cron: "19 * * * *" # offset from the main :47 render cron
  workflow_dispatch: {}

permissions:
  actions: write

concurrency:
  group: ensure-hourly
  cancel-in-progress: false

jobs:
  ensure:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Re-dispatch Hourly Story Video if the last run is stale or missing
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
        run: |
          set -euo pipefail

          LATEST=$(gh run list --workflow hourly-video.yml --limit 1 --json status,createdAt --jq '.[0] // empty')
          echo "Latest hourly-video run: \${LATEST:-none}"

          if [ -z "$LATEST" ]; then
            echo "::notice::No previous run found - dispatching Hourly Story Video now."
            gh workflow run hourly-video.yml
            exit 0
          fi

          STATUS=$(echo "$LATEST" | jq -r .status)
          CREATED=$(echo "$LATEST" | jq -r .createdAt)
          AGE_MIN=$(( ($(date +%s) - $(date -d "$CREATED" +%s)) / 60 ))
          echo "status=\${STATUS} created=\${CREATED} age=\${AGE_MIN}m"

          # Never interrupt a run that is queued or in progress
          if [ "$STATUS" = "queued" ] || [ "$STATUS" = "in_progress" ]; then
            echo "A run is already queued/in progress - nothing to do."
            exit 0
          fi

          if [ "$AGE_MIN" -gt 60 ]; then
            echo "::notice::Last run is \${AGE_MIN}m old (> 60m) - hourly tick was missed, re-dispatching."
            gh workflow run hourly-video.yml
          else
            echo "Last run is fresh (\${AGE_MIN}m old) - nothing to do."
          fi
`
}
