// Auto-generated from .github/workflows/ensure-factory.yml - do not edit by hand;
// regenerate with scripts/gen-bundle-templates.py
// Ensure Scheduled Slot watcher: at :37 every hour, same gate logic - re-dispatches the factory ONLY when the current scheduled hour produced nothing (heals dropped :07 ticks; no action outside the schedule)
export const ENSURE_FACTORY_YAML = `# StoryPilot - Ensure Scheduled Slot (self-healing for the schedule)
# GitHub cron is best-effort and ticks get silently dropped on some
# accounts. The Scheduled Video Factory (factory.yml) ticks hourly at :07
# and its schedule gate decides whether the current hour (Africa/Cairo) is
# a video slot (SCHEDULE_HOURS, default 11,12,13,15,20). If that :07 tick
# was dropped, this watcher re-checks at :37 - SAME gate logic - and
# re-dispatches the factory so a scheduled hour is never silently skipped.
# Outside the scheduled hours (and for slots that already ran) it exits
# immediately: no videos are ever made outside the schedule.
name: Ensure Scheduled Slot

on:
  schedule:
    - cron: "37 * * * *" # re-check 30 min after the :07 factory tick
  workflow_dispatch: {}

permissions:
  actions: write # dispatch the factory + list runs
  contents: read # checkout the gate script + slot state

concurrency:
  group: ensure-scheduled-slot
  cancel-in-progress: false

jobs:
  ensure:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Checkout (schedule gate + slot state)
        uses: actions/checkout@v4

      - name: Re-dispatch the factory if this scheduled hour produced nothing
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
          SCHEDULE_HOURS: \${{ vars.SCHEDULE_HOURS || '11,12,13,15,20' }}
        run: |
          set -euo pipefail

          OUT=$(python3 scripts/schedule_gate.py \\
            --hours "$SCHEDULE_HOURS" \\
            --state state/schedule_state.json \\
            --reason ensure-slot)
          echo "$OUT"
          GO=$(echo "$OUT" | sed -n 's/^GATE=//p')
          WHY=$(echo "$OUT" | sed -n 's/^REASON=//p')

          if [ "$GO" != "run" ]; then
            echo "::notice::$WHY"
            exit 0
          fi

          # a factory run already queued/working right now -> nothing to heal
          ACTIVE=$(gh run list --workflow factory.yml --limit 20 --json status \\
            --jq "[.[] | select(.status == \\"queued\\" or .status == \\"in_progress\\")] | length")
          if [ "$ACTIVE" -gt 0 ]; then
            echo "a Scheduled Video Factory run is already active - nothing to heal"
            exit 0
          fi

          echo "::notice::scheduled slot looks skipped ($WHY) - dispatching the factory now"
          gh workflow run factory.yml -f reason=ensure-slot
`
