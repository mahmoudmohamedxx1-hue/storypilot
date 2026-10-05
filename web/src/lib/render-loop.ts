import { getSettings } from '@/lib/settings'
import { listWorkflowFileRuns, dispatchWorkflow, ghJson } from '@/lib/github'
import { db } from '@/lib/db'
import { syncSheet } from '@/lib/sync'

/**
 * StoryPilot CONTINUOUS RENDER LOOP — the always-on video factory orchestrator.
 *
 * Replaces the old "hourly heartbeat": instead of waiting for an hourly tick,
 * the loop keeps the pipeline generating videos BACK-TO-BACK, 24/7:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  poll every 90s ──► run active? ──► RENDERING (watch)           │
 *   │       │no                                                       │
 *   │       ├── pending stories? (sheet ∩ GitHub render state)        │
 *   │       │        ├── yes ──► DISPATCH immediately (N parallel     │
 *   │       │        │          workers) ──► back to top              │
 *   │       │        └── no  ──► IDLE (watch for new Spark stories)   │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Pending is computed from the SOURCE OF TRUTH the workflow itself uses
 * (state/videos*.json committed to the repo) crossed with the app's sheet
 * story hashes — so the loop never spams no-op dispatches: when the queue
 * drains, it idles; when Gemini Spark adds a story, it kicks in within
 * minutes. Two no-progress runs in a row trigger a 20-minute cooldown.
 *
 * Reliability layers (outermost first):
 *   1. THIS loop — guaranteed while the app runs (primary)
 *   2. GitHub cron  hourly-video.yml  :47 (opportunistic)
 *   3. GitHub cron  ensure-hourly.yml :19 (opportunistic re-dispatcher)
 */

const POLL_MS = 90 * 1000 // check every 90 seconds
const GRACE_MS = 150 * 1000 // after dispatch: wait for the run to appear
const SETTLE_MS = 75 * 1000 // after a run completes: let state files settle
const SYNC_EVERY_MS = 5 * 60 * 1000 // keep sheet story hashes fresh
const COOLDOWN_MS = 20 * 60 * 1000 // pause after repeated no-progress runs
const WORKFLOW_FILE = 'hourly-video.yml'

export type LoopPhase =
  | 'boot' | 'disabled' | 'error' | 'rendering' | 'dispatched'
  | 'settling' | 'cooldown' | 'idle'

export interface LoopState {
  mode: 'continuous'
  enabled: boolean
  phase: LoopPhase
  workers: number
  intervalMs: number
  startedAt: string | null
  lastCheckAt: string | null
  lastCheckResult: string | null
  lastError: string | null
  checkCount: number
  dispatchCount: number
  lastDispatchAt: string | null
  lastDispatchReason: string | null
  activeRunId: string | null
  activeRunStatus: string | null
  lastRunAt: string | null
  lastRunStatus: string | null
  pendingCount: number
  pendingTitles: string[]
  lastSyncAt: string | null
  emptyStreak: number
  cooldownUntil: string | null
}

interface LoopGlobal {
  __storypilot_loop__: {
    state: LoopState
    timer: ReturnType<typeof setInterval> | null
    busy: boolean
    lastDispatchTs: number
    dispatchEvalPending: number | null
    lastSyncTs: number
  }
}

const g = globalThis as unknown as LoopGlobal

function ensureHolder() {
  if (!g.__storypilot_loop__) {
    g.__storypilot_loop__ = {
      state: {
        mode: 'continuous',
        enabled: true,
        phase: 'boot',
        workers: 3,
        intervalMs: POLL_MS,
        startedAt: null,
        lastCheckAt: null,
        lastCheckResult: null,
        lastError: null,
        checkCount: 0,
        dispatchCount: 0,
        lastDispatchAt: null,
        lastDispatchReason: null,
        activeRunId: null,
        activeRunStatus: null,
        lastRunAt: null,
        lastRunStatus: null,
        pendingCount: 0,
        pendingTitles: [],
        lastSyncAt: null,
        emptyStreak: 0,
        cooldownUntil: null,
      },
      timer: null,
      busy: false,
      lastDispatchTs: 0,
      dispatchEvalPending: null,
      lastSyncTs: 0,
    }
  }
  return g.__storypilot_loop__
}

export function getLoopState(): LoopState {
  return { ...ensureHolder().state }
}

/** Back-compat mapping for the old heartbeat payload consumers. */
export function getHeartbeatState() {
  const s = ensureHolder().state
  return {
    enabled: s.enabled,
    intervalMs: s.intervalMs,
    staleAfterMin: 60,
    startedAt: s.startedAt,
    lastCheckAt: s.lastCheckAt,
    lastCheckResult: s.lastCheckResult,
    lastRunAt: s.lastRunAt,
    lastRunStatus: s.lastRunStatus,
    lastDispatchAt: s.lastDispatchAt,
    lastDispatchReason: s.lastDispatchReason,
    lastError: s.lastError,
    checkCount: s.checkCount,
    dispatchCount: s.dispatchCount,
  }
}

/* -------------------- pending = sheet stories minus rendered -------------------- */

/** Rendered / permanently-failed story hashes from the repo state files (source of truth). */
async function fetchStateHashes(repo: string): Promise<Set<string> | null> {
  const out = new Set<string>()
  try {
    const entries = await ghJson<Array<{ name: string; download_url: string }>>(`/repos/${repo}/contents/state`)
    for (const e of entries || []) {
      if (!/^videos(\.shard\d+)?\.json$/.test(e.name || '') || !e.download_url) continue
      const res = await fetch(`${e.download_url}?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) continue
      const data = (await res.json()) as {
        rendered?: Record<string, unknown>
        failed?: Record<string, { tries?: number }>
      }
      for (const h of Object.keys(data.rendered || {})) out.add(h)
      for (const [h, f] of Object.entries(data.failed || {})) {
        if (Number(f?.tries ?? 0) >= 2) out.add(h) // parked after retries → not pending
      }
    }
    return out
  } catch {
    return null // signal "state unavailable" → caller falls back to DB statuses
  }
}

async function computePending(): Promise<{ count: number; titles: string[]; reliable: boolean }> {
  const settings = await getSettings()
  const stories = await db.storyRecord.findMany({
    where: { status: { not: 'gone' } },
    select: { contentHash: true, title: true, status: true },
    take: 200,
  })
  const stateHashes = await fetchStateHashes(settings.githubRepo)
  if (!stateHashes) {
    // fallback: DB-only view (statuses are reconciled from real runs)
    const pending = stories.filter((s) => s.status === 'new' || s.status === 'failed')
    return { count: pending.length, titles: pending.slice(0, 3).map((s) => s.title), reliable: false }
  }
  const pending = stories.filter((s) => !stateHashes.has(s.contentHash))
  return { count: pending.length, titles: pending.slice(0, 3).map((s) => s.title), reliable: true }
}

/* --------------------------------- the loop ---------------------------------- */

/** One continuous-loop pass. Returns a human-readable result. */
export async function loopCheckOnce(force = false): Promise<string> {
  const holder = ensureHolder()
  if (holder.busy) return 'check already in progress — skipped'
  holder.busy = true
  const st = holder.state
  try {
    const settings = await getSettings()
    if (!settings.githubToken || !settings.githubRepo) {
      st.phase = 'error'
      st.lastError = 'no GitHub token/repo configured'
      st.lastCheckAt = new Date().toISOString()
      return st.lastError
    }
    st.workers = settings.workers
    if (!settings.continuousMode && !force) {
      st.phase = 'disabled'
      st.enabled = false
      st.lastCheckAt = new Date().toISOString()
      st.lastCheckResult = 'continuous mode disabled in Settings — hourly crons still run'
      return st.lastCheckResult
    }
    st.enabled = true
    st.lastError = null
    st.checkCount++
    st.lastCheckAt = new Date().toISOString()

    // keep sheet story hashes fresh even with no browser open
    const now = Date.now()
    if (now - holder.lastSyncTs > SYNC_EVERY_MS) {
      const syncRes = await syncSheet().catch(() => null)
      holder.lastSyncTs = now
      st.lastSyncAt = syncRes?.finishedAt || new Date().toISOString()
    }

    const runs = await listWorkflowFileRuns(settings.githubRepo, WORKFLOW_FILE, 6)
    const latest = runs[0]
    if (latest) {
      st.lastRunAt = latest.created_at
      st.lastRunStatus = `${latest.status}/${latest.conclusion ?? '…'} (${latest.event})`
    }

    const active = runs.find((r) => r.status === 'queued' || r.status === 'in_progress')
    if (active) {
      st.phase = 'rendering'
      st.activeRunId = String(active.id)
      st.activeRunStatus = active.status
      st.lastCheckResult = `rendering — run #${active.id} ${active.status}`
      return st.lastCheckResult
    }
    st.activeRunId = null
    st.activeRunStatus = null

    // evaluate the previously dispatched cycle: did the queue actually shrink?
    if (holder.dispatchEvalPending !== null && latest) {
      const dispatchedRun = runs.find(
        (r) => new Date(r.created_at).getTime() >= holder.lastDispatchTs - 5000,
      )
      if (dispatchedRun && dispatchedRun.status === 'completed') {
        st.pendingCount = -1 // recomputed below
        const { count } = await computePending()
        const noProgress = count >= holder.dispatchEvalPending
        st.emptyStreak = noProgress ? st.emptyStreak + 1 : 0
        holder.dispatchEvalPending = null
      }
    }

    if (st.cooldownUntil && new Date(st.cooldownUntil).getTime() > now) {
      st.phase = 'cooldown'
      st.lastCheckResult = `cooldown — back-to-back no-progress runs, resuming ${new Date(st.cooldownUntil).toLocaleTimeString()}`
      return st.lastCheckResult
    }
    if (st.emptyStreak >= 2) {
      st.cooldownUntil = new Date(now + COOLDOWN_MS).toISOString()
      st.emptyStreak = 0
      st.phase = 'cooldown'
      st.lastCheckResult = 'cooldown 20 min — recent runs made no progress'
      return st.lastCheckResult
    }

    // dispatched but the run has not appeared in the API yet
    if (
      holder.lastDispatchTs &&
      now - holder.lastDispatchTs < GRACE_MS &&
      (!latest || new Date(latest.created_at).getTime() < holder.lastDispatchTs - 5000)
    ) {
      st.phase = 'dispatched'
      st.lastCheckResult = 'dispatched — waiting for the run to appear'
      return st.lastCheckResult
    }

    // a run completed seconds ago — let its state-file commit settle before re-dispatching
    if (latest && latest.status === 'completed') {
      const doneAt = new Date(latest.updated_at || latest.created_at).getTime()
      if (now - doneAt < SETTLE_MS) {
        st.phase = 'settling'
        st.lastCheckResult = 'run just finished — settling state before next dispatch'
        return st.lastCheckResult
      }
    }

    const pending = await computePending()
    st.pendingCount = pending.count
    st.pendingTitles = pending.titles

    if (pending.count === 0) {
      st.phase = 'idle'
      st.lastCheckResult = `idle — every sheet story has a video (${st.dispatchCount} dispatches so far), watching for new stories`
      return st.lastCheckResult
    }

    if (!force && !pending.reliable) {
      // GitHub state unreadable — be conservative, don't spam
      st.phase = 'cooldown'
      st.lastCheckResult = `render state unavailable — ${pending.count} stories pending by app DB, waiting for next check`
      return st.lastCheckResult
    }

    const workers = Math.max(1, Math.min(6, settings.workers || 3))
    const reason = `${pending.count} pending — continuous dispatch (${workers} parallel workers)`
    await dispatchWorkflow(settings.githubRepo, WORKFLOW_FILE, 'main', {
      workers_json: JSON.stringify(Array.from({ length: workers }, (_, i) => String(i))),
    })
    st.dispatchCount++
    st.lastDispatchAt = new Date().toISOString()
    st.lastDispatchReason = reason
    st.phase = 'dispatched'
    st.lastCheckResult = `dispatched Hourly Story Video — ${reason}`
    holder.lastDispatchTs = Date.now()
    holder.dispatchEvalPending = pending.count
    return st.lastCheckResult
  } catch (e) {
    st.phase = 'error'
    st.lastError = (e as Error).message
    st.lastCheckResult = `error: ${(e as Error).message}`
    return st.lastCheckResult
  } finally {
    holder.busy = false
  }
}

/** Start the continuous loop (idempotent, HMR-safe). */
export function startRenderLoop() {
  const holder = ensureHolder()
  if (holder.timer) return
  holder.state.startedAt = new Date().toISOString()
  setTimeout(() => void loopCheckOnce(), 20_000)
  holder.timer = setInterval(() => void loopCheckOnce(), POLL_MS)
  if (typeof holder.timer.unref === 'function') holder.timer.unref()
  console.log(`[render-loop] started — continuous factory, polling ${WORKFLOW_FILE} every ${POLL_MS / 1000}s`)
}

/* ------------------------- backwards-compat aliases --------------------------- */

export const heartbeatCheckOnce = loopCheckOnce
export const startHeartbeat = startRenderLoop
