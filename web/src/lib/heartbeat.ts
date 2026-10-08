import { getSettings } from '@/lib/settings'
import { listWorkflowFileRuns, dispatchWorkflow } from '@/lib/github'
import { isScheduledHour, runSlotKey, cairoSlotKey, formatScheduleHours } from '@/lib/schedule'

/**
 * App-side heartbeat for the SCHEDULED VIDEO FACTORY.
 *
 * Videos are made only at scheduled hours (SCHEDULE_HOURS, Africa/Cairo -
 * default 11:00, 12:00, 13:00, 15:00, 20:00). While the StoryPilot app is
 * running it checks every 10 minutes and, ONLY inside a scheduled hour,
 * revives the factory when the slot looks skipped:
 *   - a factory run is queued/in_progress        -> nothing to do
 *   - the latest run started in THIS Cairo hour  -> slot already handled
 *   - otherwise                                  -> dispatch (reason=app-heartbeat)
 *
 * Outside the scheduled hours the heartbeat NEVER dispatches - that is the
 * whole point of the schedule. force=true (the manual "make a video now"
 * button) bypasses it, and the workflow's own schedule gate
 * (scripts/schedule_gate.py) double-checks everything on the runner side
 * (including slot dedup in state/schedule_state.json), so a double
 * dispatch can't make double videos.
 */

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000 // check every 10 minutes
const WORKFLOW_FILE = 'factory.yml'

export interface HeartbeatState {
  enabled: boolean
  intervalMs: number
  staleAfterMin: number
  scheduleHours: string
  inScheduledHour: boolean
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
        staleAfterMin: 0,
        scheduleHours: '',
        inScheduledHour: false,
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

    const hoursLabel = formatScheduleHours(s.scheduleHours)
    const scheduledNow = isScheduledHour(s.scheduleHours)
    holder.state.scheduleHours = hoursLabel
    holder.state.inScheduledHour = scheduledNow

    if (!force && !scheduledNow) {
      holder.state.checkCount++
      holder.state.lastCheckAt = new Date().toISOString()
      holder.state.lastError = null
      holder.state.lastCheckResult = `idle — outside the schedule (${hoursLabel} Africa/Cairo); no videos outside scheduled hours`
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
      holder.state.lastCheckResult = `run #${latest.id} ${latest.status} — waiting`
      return holder.state.lastCheckResult
    }

    // a run that STARTED in this Cairo hour means the slot was already
    // handled (it either completed or crashed - the :37 ensure-slot watcher
    // is the healer for crashed slots; don't double-make from the app)
    if (!force && latest && runSlotKey(latest.created_at) === cairoSlotKey()) {
      holder.state.lastCheckResult = `slot already handled — run #${latest.id} started this hour (${latest.conclusion ?? latest.status})`
      return holder.state.lastCheckResult
    }

    const reason = force
      ? 'manual "make a video now" (schedule bypassed)'
      : `scheduled hour ${cairoSlotKey().slice(-2)}:00 with no factory run this hour — reviving the slot`
    await dispatchWorkflow(s.githubRepo, WORKFLOW_FILE, 'main', {
      reason: force ? 'force' : 'app-heartbeat',
    })
    holder.state.dispatchCount++
    holder.state.lastDispatchAt = new Date().toISOString()
    holder.state.lastDispatchReason = reason
    holder.state.lastCheckResult = `dispatched Scheduled Video Factory (${reason})`
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
  console.log(`[heartbeat] started — guarding the video schedule every ${HEARTBEAT_INTERVAL_MS / 60000} min`)
}
