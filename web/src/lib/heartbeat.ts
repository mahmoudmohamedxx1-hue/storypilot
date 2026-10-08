import { getSettings } from '@/lib/settings'
import { listWorkflowFileRuns, dispatchWorkflow } from '@/lib/github'

/**
 * App-side heartbeat for the CONTINUOUS VIDEO FACTORY.
 *
 * The factory (factory.yml) is designed to never stop: each ~5h run chains
 * the next one, backed by an every-15-min cron + the ensure-factory watcher.
 * But GitHub schedules are heavily throttled on this account and a chain
 * dispatch can fail, so while the StoryPilot app is running it checks every
 * 10 minutes and re-dispatches the factory whenever no factory run is
 * queued/in_progress and the last one is older than 25 minutes.
 *
 * Safe against overlap: it skips when a run is queued/in_progress, the
 * workflow's concurrency group keeps exactly one pending run, and the job's
 * own singleton guard no-ops any accidental double dispatch.
 */

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000 // check every 10 minutes
const STALE_AFTER_MS = 25 * 60 * 1000 // revive if no factory run started in 25 min
const WORKFLOW_FILE = 'factory.yml'

export interface HeartbeatState {
  enabled: boolean
  intervalMs: number
  staleAfterMin: number
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
        staleAfterMin: Math.round(STALE_AFTER_MS / 60000),
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
      holder.state.lastCheckResult = `run #${latest.id} ${latest.status} — waiting`
      return holder.state.lastCheckResult
    }

    const ageMs = latest ? Date.now() - new Date(latest.created_at).getTime() : Infinity
    const ageMin = latest ? Math.round(ageMs / 60000) : -1

    if (!force && latest && ageMs < STALE_AFTER_MS) {
      holder.state.lastCheckResult = `healthy — last run ${ageMin}m old`
      return holder.state.lastCheckResult
    }

    const reason = latest
      ? `last factory run ${ageMin}m old (> ${Math.round(STALE_AFTER_MS / 60000)}m) — the chain broke`
      : 'no factory run found'
    await dispatchWorkflow(s.githubRepo, WORKFLOW_FILE, 'main', { reason: 'app-heartbeat' })
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
  console.log(`[heartbeat] started — checking ${WORKFLOW_FILE} every ${HEARTBEAT_INTERVAL_MS / 60000} min`)
}
