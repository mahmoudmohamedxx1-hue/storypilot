// Auto-generated from .github/workflows/factory.yml - do not edit by hand;
// regenerate with scripts/gen-bundle-templates.py
// Scheduled Video Factory workflow: hourly :07 tick -> schedule gate (Africa/Cairo, SCHEDULE_HOURS) -> capped slot render -> Drive flush + platform posting; NO self-chaining, NO continuous loop
export const FACTORY_YAML = `# StoryPilot - SCHEDULED VIDEO FACTORY (videos by the clock, not continuous)
# Deployed by the StoryPilot agent app.
#
# Videos are made at SCHEDULED TIMES ONLY - default 11:00, 12:00, 13:00,
# 15:00, 20:00 Africa/Cairo - configured by the SCHEDULE_HOURS repo
# variable (e.g. "9,11,12,13,15,17,20,22"). Change it any time in GitHub
# Settings -> Secrets and variables -> Actions -> Variables; no code edit
# needed. Between scheduled hours NOTHING is made.
#
# How it works:
#   - this workflow TICKS every hour at :07 (GitHub drops start-of-hour crons)
#   - the first step is the SCHEDULE GATE (scripts/schedule_gate.py):
#       * current hour (Africa/Cairo) not in SCHEDULE_HOURS -> exit in ~20s
#       * the slot already produced its videos this hour (state/
#         schedule_state.json) -> exit (one session per scheduled hour)
#   - when the gate says RUN: render up to MAX_VIDEOS_PER_SLOT videos
#     (default 2) - pending Google Sheet stories first (Spark's live
#     edits), and if the queue is empty + INVENT_WHEN_EMPTY=true the
#     keyless AI invents ONE fresh story so the slot still produces
#   - every finished video is synced to Google Drive (deduped) and posted
#     to the connected platforms
#   - the slot records itself and STOPS. No chaining, no infinite loop,
#     no videos outside the schedule.
#
# Manual/agent runs (reason manual|chat|catchup|force) BYPASS the schedule:
# clicking "Run workflow" in GitHub or asking the app agent always works.
#
# Reliability (a scheduled hour must never be silently skipped):
#   1. the :07 hourly tick + gate dedup (a re-tick can't double-make)
#   2. "Ensure Scheduled Slot" (ensure-factory.yml) re-checks at :37 and
#      dispatches this workflow if a scheduled slot produced nothing
#   3. the StoryPilot app heartbeat does the same check from the app side
#
# STOP everything: create state/FACTORY_STOP in the repo (app: "stop the
# factory") or disable this workflow.
name: Scheduled Video Factory

on:
  workflow_dispatch:
    inputs:
      reason:
        description: "Why this run started (schedule / ensure-slot / app-heartbeat / manual)"
        required: false
        default: "manual"
  schedule:
    - cron: "7 * * * *" # hourly tick - the schedule gate decides (Africa/Cairo)

permissions:
  contents: write # commit render + slot state
  actions: write  # list runs (singleton guard)

concurrency:
  group: scheduled-factory
  cancel-in-progress: false

jobs:
  factory:
    runs-on: ubuntu-latest
    timeout-minutes: 58 # one slot must finish before the next hour's tick
    env:
      # secrets/vars mapped at job level - step-level if: may only read the env context
      YOUTUBE_REFRESH_TOKEN: \${{ secrets.YOUTUBE_REFRESH_TOKEN }}
      YOUTUBE_CLIENT_ID: \${{ secrets.YOUTUBE_CLIENT_ID }}
      YOUTUBE_CLIENT_SECRET: \${{ secrets.YOUTUBE_CLIENT_SECRET }}
      TIKTOK_ACCESS_TOKEN: \${{ secrets.TIKTOK_ACCESS_TOKEN }}
      INSTAGRAM_ACCESS_TOKEN: \${{ secrets.INSTAGRAM_ACCESS_TOKEN }}
      INSTAGRAM_USER_ID: \${{ secrets.INSTAGRAM_USER_ID }}
      YOUTUBE_PRIVACY: \${{ vars.YOUTUBE_PRIVACY || 'public' }}
      TIKTOK_PRIVACY: \${{ vars.TIKTOK_PRIVACY || 'SELF_ONLY' }}
      FRAME_RATE: \${{ vars.FRAME_RATE || '60' }} # hyperframes
      # Google Drive sync (step if: reads these from the job env context)
      DRIVE_WEBAPP_URL: \${{ secrets.DRIVE_WEBAPP_URL }}
      DRIVE_WEBAPP_KEY: \${{ secrets.DRIVE_WEBAPP_KEY }}
      DRIVE_ROOT_FOLDER: \${{ vars.DRIVE_ROOT_FOLDER || 'StoryPilot Videos' }}
      # the video schedule (hours in Africa/Cairo time)
      SCHEDULE_HOURS: \${{ vars.SCHEDULE_HOURS || '11,12,13,15,20' }}
    steps:
      - name: Singleton guard (skip if another factory run is already working)
        id: guard
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }} # gh runs BEFORE checkout - no .git to infer from
        run: |
          OTHER=$(gh run list --workflow factory.yml --limit 50 --json status,databaseId \\
            --jq "[.[] | select((.status == \\"queued\\" or .status == \\"in_progress\\") and .databaseId != \${{ github.run_id }})] | length")
          if [ "$OTHER" -gt 0 ]; then
            echo "::notice::another Scheduled Video Factory run is active - this trigger is a no-op"
            echo "go=skip" >> "$GITHUB_OUTPUT"
          else
            echo "go=run" >> "$GITHUB_OUTPUT"
          fi

      - name: Checkout
        if: steps.guard.outputs.go == 'run'
        uses: actions/checkout@v4

      - name: Schedule gate (is this hour a video slot? - Africa/Cairo)
        id: gate
        if: steps.guard.outputs.go == 'run'
        run: |
          set -euo pipefail
          REASON="\${{ github.event_name == 'workflow_dispatch' && inputs.reason || 'schedule' }}"
          OUT=$(python3 scripts/schedule_gate.py \\
            --hours "$SCHEDULE_HOURS" \\
            --state state/schedule_state.json \\
            --reason "$REASON")
          echo "$OUT"
          GO=$(echo "$OUT" | sed -n 's/^GATE=//p')
          WHY=$(echo "$OUT" | sed -n 's/^REASON=//p')
          echo "go=$GO" >> "$GITHUB_OUTPUT"
          if [ "$GO" != "run" ]; then
            echo "::notice::$WHY"
          fi

      - name: Set up Python
        if: steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run'
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip

      - name: Install system deps (ffmpeg + fonts incl. Arabic)
        if: steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run'
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-noto-core fonts-noto-ui-core || true

      - name: Install Python deps
        if: steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run'
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt

      - name: Run the scheduled factory (slot supervisor)
        if: steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run'
        env:
          GH_TOKEN: \${{ github.token }} # state git-push
          SHEET_ID: \${{ vars.SHEET_ID || '1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4' }}
          FLP_MODEL: \${{ vars.FLP_MODEL || 'auto' }}
          TTS_VOICE_AR: \${{ vars.TTS_VOICE_AR || 'ar-EG-ShakirNeural' }}
          ENABLE_AI_IMAGES: \${{ vars.ENABLE_AI_IMAGES || 'true' }}
          IMAGE_MODEL: \${{ vars.IMAGE_MODEL || 'flux' }}
          # scheduled-slot mode: capped videos per slot, one invented story max,
          # no chaining - the run ends when the slot is done
          SCHEDULED_SLOT: "true"
          MAX_VIDEOS_PER_SLOT: \${{ vars.MAX_VIDEOS_PER_SLOT || '2' }}
          INVENT_WHEN_EMPTY: \${{ vars.INVENT_WHEN_EMPTY || 'true' }}
          FACTORY_BUDGET_MIN: \${{ vars.FACTORY_BUDGET_MIN || '45' }}
          AI_ATTEMPTS: \${{ vars.AI_ATTEMPTS || '3' }}
          DRIVE_SYNC_INTERVAL: \${{ vars.DRIVE_SYNC_INTERVAL || '3600' }}
        run: python scripts/factory.py

      - name: Upload factory videos
        if: always() && steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run'
        uses: actions/upload-artifact@v4
        with:
          name: factory-videos
          path: |
            videos/*/output.mp4
            videos/*/meta.json
            videos/*/thumb.jpg
            videos/*/story.json
            videos/*/ai_renderer.py
            state/factory_status.json
            state/schedule_state.json
            batch_summary.json
          retention-days: 14
          if-no-files-found: warn

      - name: Sync new videos to Google Drive (slot flush)
        if: always() && steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run' && env.DRIVE_WEBAPP_URL != ''
        run: |
          # factory.py syncs after every video; this final pass is a
          # belt-and-suspenders flush in case the supervisor exited early
          python scripts/drive_sync.py || echo "::warning::drive sync flush failed (will retry next slot)"

      - name: Post to YouTube
        if: always() && steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run' && env.YOUTUBE_REFRESH_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in videos/*/; do
            echo "[youtube] posting $d"
            VIDEO_PATH="$d/output.mp4" META_PATH="$d/meta.json" python post_video.py --youtube \\
              || echo "::warning::failed to post $d to YouTube"
          done

      - name: Post to TikTok
        if: always() && steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run' && env.TIKTOK_ACCESS_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in videos/*/; do
            echo "[tiktok] posting $d"
            VIDEO_PATH="$d/output.mp4" META_PATH="$d/meta.json" python post_video.py --tiktok \\
              || echo "::warning::failed to post $d to TikTok"
          done

      - name: Post to Instagram Reels
        if: always() && steps.guard.outputs.go == 'run' && steps.gate.outputs.go == 'run' && env.INSTAGRAM_ACCESS_TOKEN != ''
        run: |
          set -uo pipefail
          shopt -s nullglob
          for d in videos/*/; do
            echo "[instagram] posting $d"
            VIDEO_PATH="$d/output.mp4" META_PATH="$d/meta.json" python post_video.py --instagram \\
              || echo "::warning::failed to post $d to Instagram"
          done
`
