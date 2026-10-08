import { getSettings } from '@/lib/settings'
import { listWorkflowFileRuns, dispatchWorkflow, getFileSha } from '@/lib/github'

/**
 * App-side heartbeat for the CONTINUOUS VIDEO FACTORY.
 *
 * Videos are made CONTINUOUSLY - the factory chains itself run-after-run on
 * GitHub Actions (~5h per run) and the total video count just keeps
 * climbing. While the StoryPilot app is running it checks every 10 minutes
 * that the loop is actually alive and revives it when it looks dead:
 *   - a factory run is queued/in_progress -> alive, nothing to do
 *   - state/FACTORY_STOP exists in the repo -> the user stopped it; never revive
 *   - the latest run finished < 25 min ago  -> probably mid-chain-gap; wait
 *   - otherwise (chain broke)              -> dispatch (reason=app-heartbeat)
 *
 * force=true (the manual "make a video now" button) always dispatches.
 * The workflow's own singleton guard makes a double dispatch harmless.
 */

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000 // check every 10 minutes
const STALE_AFTER_MIN = 25 // a finished run younger than this may still be chaining
const WORKFLOW_FILE = 'factory.yml'

export interface HeartbeatState {
  enabled: boolean
  intervalMs: number
  staleAfterMin: number
  stopped: boolean
  startedAt: string | null
  lastCheckAt: string | null
  lastCheckResult: string | null
  lastRunAt: string | null
  lastRunStatus: string | null
  lastDispatchAt: string | null
  lastDispatchReason: string | null
  lastError: string | null
  checkCount: number
  dispatchCount: number
}

interface HeartbeatGlobal {
  __storypilot_heartbeat__: {
    state: HeartbeatState
    timer: ReturnType<typeof setInterval> | null
    busy: boolean
  }
}

const g = globalThis as unknown as HeartbeatGlobal

function ensureHolder() {
  if (!g.__storypilot_heartbeat__) {
    g.__storypilot_heartbeat__ = {
      state: {
        enabled: true,
        intervalMs: HEARTBEAT_INTERVAL_MS,
        staleAfterMin: STALE_AFTER_MIN,
        stopped: false,
        startedAt: null,
        lastCheckAt: null,
        lastCheckResult: null,
        lastRunAt: null,
        lastRunStatus: null,
        lastDispatchAt: null,
        lastDispatchReason: null,
        lastError: null,
        checkCount: 0,
        dispatchCount: 0,
      },
      timer: null,
      busy: false,
    }
  }
  return g.__storypilot_heartbeat__
}

export function getHeartbeatState(): HeartbeatState {
  return { ...ensureHolder().state }
}

/** One heartbeat pass. Returns a human-readable result. */
export async function heartbeatCheckOnce(force = false): Promise<string> {
  const holder = ensureHolder()
  if (holder.busy) return 'check already in progress — skipped'
  holder.busy = true
  try {
    const s = await getSettings()
    if (!s.githubToken) {
      holder.state.lastError = 'no GitHub token configured'
      holder.state.lastCheckAt = new Date().toISOString()
      return 'no GitHub token configured'
    }
    if (!s.githubRepo) {
      holder.state.lastError = 'no GitHub repo configured'
      holder.state.lastCheckAt = new Date().toISOString()
      return 'no GitHub repo configured'
    }

    // honor the STOP flag - never revive a factory the user stopped
    const stopSha = await getFileSha(s.githubRepo, 'state/FACTORY_STOP').catch(() => undefined)
    holder.state.stopped = !!stopSha
    if (stopSha && !force) {
      holder.state.checkCount++
      holder.state.lastCheckAt = new Date().toISOString()
      holder.state.lastError = null
      holder.state.lastCheckResult = 'factory is STOPPED (state/FACTORY_STOP in the repo) - remove the file or use control_factory {"action":"start"} to resume'
      return holder.state.lastCheckResult
    }

    const runs = await listWorkflowFileRuns(s.githubRepo, WORKFLOW_FILE, 5)
    holder.state.checkCount++
    holder.state.lastCheckAt = new Date().toISOString()
    holder.state.lastError = null

    const latest = runs[0]
    if (latest) {
      holder.state.lastRunAt = latest.created_at
      holder.state.lastRunStatus = `${latest.status}/${latest.conclusion ?? '…'} (${latest.event})`
    }

    if (latest && (latest.status === 'queued' || latest.status === 'in_progress')) {
      holder.state.lastCheckResult = `run #${latest.id} ${latest.status} — the loop is alive`
      return holder.state.lastCheckResult
    }

    // a run that finished recently may simply be mid chain-gap (the successor
    // takes a minute to queue) - only heal when it looks genuinely dead
    if (!force && latest) {
      const ageMin = (Date.now() - new Date(latest.created_at).getTime()) / 60000
      if (Number.isFinite(ageMin) && ageMin < STALE_AFTER_MIN) {
        holder.state.lastCheckResult = `last run #${latest.id} finished ${Math.round(ageMin)}m ago (fresh) — waiting`
        return holder.state.lastCheckResult
      }
    }

    const reason = force
      ? 'manual "make a video now"'
      : `no active factory run for ${STALE_AFTER_MIN}+ min — reviving the continuous loop`
    await dispatchWorkflow(s.githubRepo, WORKFLOW_FILE, 'main', {
      reason: force ? 'force' : 'app-heartbeat',
    })
    holder.state.dispatchCount++
    holder.state.lastDispatchAt = new Date().toISOString()
    holder.state.lastDispatchReason = reason
    holder.state.lastCheckResult = `dispatched Continuous Video Factory (${reason})`
    return holder.state.lastCheckResult
  } catch (e) {
    holder.state.lastError = (e as Error).message
    holder.state.lastCheckResult = `error: ${(e as Error).message}`
    return holder.state.lastCheckResult
  } finally {
    holder.busy = false
  }
}

/** Start the periodic heartbeat (idempotent, HMR-safe). */
export function startHeartbeat() {
  const holder = ensureHolder()
  if (holder.timer) return // already running
  holder.state.enabled = true
  holder.state.startedAt = new Date().toISOString()
  // first check shortly after boot (lets the server settle first)
  setTimeout(() => void heartbeatCheckOnce(), 30_000)
  holder.timer = setInterval(() => void heartbeatCheckOnce(), HEARTBEAT_INTERVAL_MS)
  if (typeof holder.timer.unref === 'function') holder.timer.unref()
  console.log(`[heartbeat] started — keeping the continuous factory alive (check every ${HEARTBEAT_INTERVAL_MS / 60000} min)`)
}
