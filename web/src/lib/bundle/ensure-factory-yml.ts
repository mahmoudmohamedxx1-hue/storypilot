// Auto-generated from .github/workflows/ensure-factory.yml - do not edit by hand;
// regenerate with scripts/gen-bundle-templates.py
// Factory watcher: re-dispatches the Continuous Video Factory when the chain breaks and no run is queued (*/20 best-effort cron)
export const ENSURE_FACTORY_YAML = `# StoryPilot - Self-healing watcher for the Continuous Video Factory
# GitHub cron is best-effort and heavily throttled on some accounts (ticks get
# silently dropped). This watcher checks the FACTORY (factory.yml): if no
# factory run is queued/in_progress and the last one finished more than 25
# minutes ago, it re-dispatches the factory so video generation never silently
# stops. The factory chains itself run-after-run; this file only patches holes
# (chain failure + app heartbeat both being down).
name: Ensure Continuous Factory

on:
  schedule:
    - cron: "*/20 * * * *" # opportunistic heartbeat (best-effort on this account)
  workflow_dispatch: {}

permissions:
  actions: write

concurrency:
  group: ensure-factory
  cancel-in-progress: false

jobs:
  ensure:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Re-dispatch the factory if it looks dead
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
        run: |
          set -euo pipefail

          LATEST=$(gh run list --workflow factory.yml --limit 1 --json status,createdAt --jq '.[0] // empty')
          echo "Latest factory run: \${LATEST:-none}"

          if [ -z "$LATEST" ]; then
            echo "::notice::No factory run found - dispatching the factory now."
            gh workflow run factory.yml -f reason=ensure-first
            exit 0
          fi

          STATUS=$(echo "$LATEST" | jq -r .status)
          CREATED=$(echo "$LATEST" | jq -r .createdAt)
          AGE_MIN=$(( ($(date +%s) - $(date -d "$CREATED" +%s)) / 60 ))
          echo "status=\${STATUS} created=\${CREATED} age=\${AGE_MIN}m"

          # Never interrupt a run that is queued or in progress
          if [ "$STATUS" = "queued" ] || [ "$STATUS" = "in_progress" ]; then
            echo "The factory is alive - nothing to do."
            exit 0
          fi

          if [ "$AGE_MIN" -gt 25 ]; then
            echo "::notice::Last factory run is \${AGE_MIN}m old (> 25m) - the chain broke, re-dispatching."
            gh workflow run factory.yml -f reason=ensure-revive
          else
            echo "Last factory run is fresh (\${AGE_MIN}m old) - nothing to do."
          fi
`
