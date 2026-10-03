import { db } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { listTabs, parseTabStories, parseCsv, fetchTabCsv, isCodeTab, storyHash, Story } from '@/lib/sheet'

/**
 * Always-sync engine.
 * Keeps StoryRecords in perfect sync with the live Google Sheet:
 *  - discovers every tab (keyless)
 *  - parses every story (all formats)
 *  - content-hash change detection → new/changed stories become "new" (to be made)
 *  - stories that disappear & were never made are marked "gone"
 *  - every sync writes a SyncLog row
 */

const MIN_SYNC_INTERVAL_MS = 25_000
const STALE_GONE_MS = 2 * 60 * 60 * 1000 // absent for 2h + never made → gone

let inFlight: Promise<SyncResult> | null = null
let lastFinished: SyncResult | null = null
let lastStartedAt = 0

export interface SyncTabSummary {
  gid: string
  name: string
  stories: number
  language: string
  isCode: boolean
}

export interface SyncResult {
  ok: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  tabsFound: number
  tabs: SyncTabSummary[]
  storiesSeen: number
  storiesNew: number
  storiesChanged: number
  storiesGone: number
  skipped: boolean
  error?: string
}

async function doSync(): Promise<SyncResult> {
  const startedAt = new Date()
  const base: SyncResult = {
    ok: false, startedAt: startedAt.toISOString(), finishedAt: '', durationMs: 0,
    tabsFound: 0, tabs: [], storiesSeen: 0, storiesNew: 0, storiesChanged: 0, storiesGone: 0,
    skipped: false,
  }
  const settings = await getSettings()
  const seenIds: string[] = []
  try {
    const tabs = await listTabs(settings.sheetId)
    base.tabsFound = tabs.length
    for (const tab of tabs) {
      if (isCodeTab(tab.name)) {
        base.tabs.push({ gid: tab.gid, name: tab.name, stories: 0, language: '', isCode: true })
        continue
      }
      let stories: Story[] = []
      try {
        const csv = await fetchTabCsv(settings.sheetId, tab.gid)
        stories = parseTabStories(parseCsv(csv), tab.name)
      } catch {
        base.tabs.push({ gid: tab.gid, name: tab.name, stories: 0, language: '', isCode: false })
        continue
      }
      const lang = stories[0]?.language || ''
      base.tabs.push({ gid: tab.gid, name: tab.name, stories: stories.length, language: lang, isCode: false })

      for (const st of stories) {
        const hash = storyHash(st)
        const existing = await db.storyRecord.findFirst({
          where: { tabGid: tab.gid, contentHash: hash },
        })
        if (existing) {
          // unchanged story — refresh metadata + lastSeen
          await db.storyRecord.update({
            where: { id: existing.id },
            data: {
              lastSeenAt: new Date(),
              tabName: tab.name,
              title: st.title,
              logline: st.logline,
              genre: st.genre,
              duration: st.duration,
              language: st.language,
              scenes: st.scenes.length,
              words: st.totalWords,
            },
          })
          seenIds.push(existing.id)
          base.storiesSeen++
        } else {
          // brand-new story (or changed content on this tab)
          const rec = await db.storyRecord.create({
            data: {
              tabGid: tab.gid,
              tabName: tab.name,
              title: st.title,
              logline: st.logline,
              genre: st.genre,
              duration: st.duration,
              language: st.language,
              scenes: st.scenes.length,
              words: st.totalWords,
              contentHash: hash,
              storyJson: JSON.stringify(st),
              status: 'new',
            },
          })
          seenIds.push(rec.id)
          base.storiesNew++
        }
      }
    }

    const cutoff = new Date(Date.now() - STALE_GONE_MS)
    // stories replaced in this round: previously "new", recently seen, but absent from the sheet now
    base.storiesChanged = await db.storyRecord.count({
      where: {
        status: 'new',
        id: { notIn: seenIds.length ? seenIds : ['__none__'] },
        lastSeenAt: { gte: cutoff },
      },
    })

    // stories absent from the sheet & never made → gone (hourly rewrites clean themselves up)
    const gone = await db.storyRecord.updateMany({
      where: {
        id: { notIn: seenIds.length ? seenIds : ['__none__'] },
        status: 'new',
        lastSeenAt: { lt: cutoff },
      },
      data: { status: 'gone' },
    })
    base.storiesGone = gone.count

    base.ok = true
    base.finishedAt = new Date().toISOString()
    base.durationMs = Date.now() - startedAt.getTime()
    await db.syncLog.create({
      data: {
        startedAt,
        finishedAt: new Date(base.finishedAt),
        durationMs: base.durationMs,
        ok: true,
        tabsFound: base.tabsFound,
        storiesNew: base.storiesNew,
        storiesSeen: base.storiesSeen,
      },
    })
    return base
  } catch (e) {
    base.ok = false
    base.error = (e as Error).message
    base.finishedAt = new Date().toISOString()
    base.durationMs = Date.now() - startedAt.getTime()
    await db.syncLog.create({
      data: {
        startedAt,
        finishedAt: new Date(base.finishedAt),
        durationMs: base.durationMs,
        ok: false,
        tabsFound: base.tabsFound,
        storiesNew: base.storiesNew,
        storiesSeen: base.storiesSeen,
        error: base.error,
      },
    }).catch(() => {})
    return base
  }
}

/**
 * Runs a sync, but never more than once every MIN_SYNC_INTERVAL_MS.
 * Concurrent callers share the in-flight promise (single flight).
 */
export async function syncSheet(force = false): Promise<SyncResult> {
  if (inFlight) return inFlight
  const since = Date.now() - lastStartedAt
  if (!force && lastFinished && since < MIN_SYNC_INTERVAL_MS) {
    return { ...lastFinished, skipped: true }
  }
  lastStartedAt = Date.now()
  inFlight = doSync()
  try {
    const res = await inFlight
    lastFinished = res
    return res
  } finally {
    inFlight = null
  }
}

export interface SyncState {
  lastSync: SyncResult | null
  lastSyncAt: string | null
  autoSyncSeconds: number
  counts: {
    total: number
    new: number
    queued: number
    rendering: number
    done: number
    failed: number
    gone: number
  }
  tabs: Array<{ gid: string; name: string }>
}

/** Lightweight state used by the sidebar heartbeat + library view. */
export async function getSyncState(): Promise<SyncState> {
  const [lastLog] = await db.syncLog.findMany({ orderBy: { startedAt: 'desc' }, take: 1 })
  const grouped = await db.storyRecord.groupBy({ by: ['status'], _count: { _all: true } })
  const counts: SyncState['counts'] = { total: 0, new: 0, queued: 0, rendering: 0, done: 0, failed: 0, gone: 0 }
  for (const g of grouped) {
    const n = g._count._all ?? 0
    counts.total += n
    if (g.status === 'new') counts.new = n
    else if (g.status === 'queued') counts.queued = n
    else if (g.status === 'rendering') counts.rendering = n
    else if (g.status === 'done') counts.done = n
    else if (g.status === 'failed') counts.failed = n
    else if (g.status === 'gone') counts.gone = n
  }
  const settings = await getSettings()
  let tabs: Array<{ gid: string; name: string }> = []
  try {
    tabs = (await listTabs(settings.sheetId)).map((t) => ({ gid: t.gid, name: t.name }))
  } catch { /* sheet unreachable — heartbeat still works */ }
  return {
    lastSync: lastLog
      ? {
          ok: lastLog.ok, startedAt: lastLog.startedAt.toISOString(), finishedAt: lastLog.finishedAt.toISOString(),
          durationMs: lastLog.durationMs, tabsFound: lastLog.tabsFound, tabs: [], storiesSeen: lastLog.storiesSeen,
          storiesNew: lastLog.storiesNew, storiesChanged: 0, storiesGone: 0, skipped: false,
          error: lastLog.error || undefined,
        }
      : null,
    lastSyncAt: lastLog ? lastLog.startedAt.toISOString() : null,
    autoSyncSeconds: 60,
    counts,
    tabs,
  }
}
