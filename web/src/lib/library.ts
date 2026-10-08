import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import { db } from '@/lib/db'
import { getSettings } from '@/lib/settings'
import { syncSheet } from '@/lib/sync'
import { listWorkflowRuns, listArtifacts, dispatchWorkflow, downloadArtifactZip } from '@/lib/github'

/**
 * The Library engine.
 *  - keeps the sheet sync hot ("always in update")
 *  - merges StoryRecords (to be made) + VideoJobs (made/making) + live GitHub runs/artifacts
 *  - reconciles job statuses against real workflow runs (queued → rendering → done/failed)
 *  - backfills past successful runs as library videos
 *  - extracts a playable MP4 from any artifact zip (cached on disk)
 */

export interface PlatformState {
  platform: 'youtube' | 'tiktok' | 'instagram'
  configured: boolean
  status: 'pending' | 'posted' | 'skipped' | 'failed'
  url?: string
}

export interface LibraryVideo {
  jobId: string
  runId: string | null
  runStatus: string | null
  runConclusion: string | null
  runUrl: string | null
  artifactId: string | null
  artifactEntry: string | null
  sizeBytes: number | null
  durationSec: number | null
  fps: number | null
  hyperframes: boolean
  renderedAt: string | null
  createdAt: string
  platforms: PlatformState[]
  watchable: boolean
}

export interface LibraryItem {
  storyId: string
  tabName: string
  title: string
  logline: string
  genre: string
  duration: string
  language: string
  scenes: number
  words: number
  status: 'new' | 'queued' | 'rendering' | 'done' | 'failed'
  firstSeenAt: string
  lastSeenAt: string
  video: LibraryVideo | null
}

export interface LibraryStats {
  totalStories: number
  toMake: number
  inProgress: number
  done: number
  failed: number
  storageBytes: number
  totalVideos: number
}

/** Catch-up queue progress: is EVERY sheet story becoming a video? */
export interface CatchupInfo {
  total: number
  done: number
  pending: number
  failed: number
  /** rough number of hourly runs still needed at 4 videos/run */
  runsNeeded: number
  active: boolean
}

export interface LibraryPayload {
  ok: boolean
  items: LibraryItem[]
  stats: LibraryStats
  catchup: CatchupInfo | null
  lastSyncAt: string | null
  error?: string
}

type Run = Awaited<ReturnType<typeof listWorkflowRuns>>[number]
type Artifact = Awaited<ReturnType<typeof listArtifacts>>[number]

function platformStates(settings: { youtubeToken: string; tiktokToken: string; instagramToken: string }, job: { platforms: string; runConclusion?: string | null; runStatus?: string | null }): PlatformState[] {
  let saved: Array<{ platform: string; status: string; url?: string }> = []
  try { saved = JSON.parse(job.platforms || '[]') } catch { /* ignore */ }
  const runDone = job.runConclusion === 'success'
  const defs: Array<{ platform: PlatformState['platform']; configured: boolean }> = [
    { platform: 'youtube', configured: !!settings.youtubeToken },
    { platform: 'tiktok', configured: !!settings.tiktokToken },
    { platform: 'instagram', configured: !!settings.instagramToken },
  ]
  return defs.map((d) => {
    const s = saved.find((x) => x.platform === d.platform)
    let status: PlatformState['status'] = 'pending'
    if (s?.status === 'posted') status = 'posted'
    else if (runDone) status = d.configured ? 'posted' : 'skipped'
    else if (job.runConclusion && job.runConclusion !== 'success' && d.configured) status = 'failed'
    return { platform: d.platform, configured: d.configured, status, url: s?.url }
  })
}

/** Reconcile job/story statuses against the real workflow runs. */
async function reconcile(runs: Run[], artifacts: Artifact[]): Promise<void> {
  const runById = new Map(runs.map((r) => [String(r.id), r]))
  const artByRun = new Map<number, Artifact>()
  for (const a of artifacts) {
    const rid = a.workflow_run?.id
    if (rid) artByRun.set(rid, a)
  }
  const jobs = await db.videoJob.findMany({
    where: { status: { in: ['queued', 'rendering'] } },
    take: 30,
  })
  for (const job of jobs) {
    if (!job.runId) continue
    const run = runById.get(job.runId)
    if (!run) continue
    const art = artByRun.get(run.id)
    if (run.status === 'in_progress' || run.status === 'queued') {
      if (job.status !== 'rendering') {
        await db.videoJob.update({ where: { id: job.id }, data: { status: 'rendering' } })
        if (job.storyRecordId) {
          await db.storyRecord.update({ where: { id: job.storyRecordId }, data: { status: 'rendering' } }).catch(() => {})
        }
      }
    } else if (run.status === 'completed') {
      const ok = run.conclusion === 'success'
      await db.videoJob.update({
        where: { id: job.id },
        data: {
          status: ok ? 'done' : 'failed',
          artifactId: art ? String(art.id) : null,
          sizeBytes: art?.size_in_bytes ?? null,
          renderedAt: run.updated_at ? new Date(run.updated_at) : new Date(),
        },
      })
      if (job.storyRecordId) {
        await db.storyRecord.update({ where: { id: job.storyRecordId }, data: { status: ok ? 'done' : 'failed' } }).catch(() => {})
      }
    }
  }
}

/** Past successful runs (with artifacts) that have no library entry yet → create one per video. */
async function backfill(runs: Run[], artifacts: Artifact[], limit = 6): Promise<number> {
  const settings = await getSettings()
  let created = 0
  const existing = new Set(
    (await db.videoJob.findMany({ select: { runId: true, artifactId: true, artifactEntry: true }, take: 400 }))
      .map((j) => `${j.runId || ''}|${j.artifactId || ''}|${j.artifactEntry || ''}`),
  )
  const artByRun = new Map<number, Artifact[]>()
  for (const a of artifacts) {
    const rid = a.workflow_run?.id
    if (rid) {
      if (!artByRun.has(rid)) artByRun.set(rid, [])
      artByRun.get(rid)!.push(a)
    }
  }
  for (const run of runs) {
    if (created >= limit) break
    if (run.status !== 'completed') continue
    // NOTE: even a FAILED run can carry rendered videos (e.g. a later step like the
    // state commit failed while the artifact upload succeeded) - import them.
    const runArts = artByRun.get(run.id) || []
    if (!runArts.length) continue
    for (const art of runArts) {
      if (created >= limit) break
      // a batch artifact can contain MANY videos (one per rendered story)
      const videos = await listArtifactVideos(art.id)
      for (const v of videos) {
        if (created >= limit) break
        const key = `${run.id}|${art.id}|${v.mp4Entry}`
        if (existing.has(key)) continue
        const title = v.meta?.title || `Hourly video · ${new Date(run.created_at).toLocaleDateString()}`
        const storyHash = (v.meta?.story_hash as string) || ''
        const fps = typeof v.meta?.fps === 'number' ? (v.meta.fps as number) : null
        const durationSec = typeof v.meta?.duration_sec === 'number' ? (v.meta.duration_sec as number) : null
        // match the video to a story record: exact content hash first, then normalized title
        let story = storyHash
          ? await db.storyRecord.findFirst({ where: { contentHash: storyHash } })
          : null
        if (!story) {
          const norm = title.toLowerCase().replace(/\s+/g, ' ').trim()
          story = await db.storyRecord.findFirst({ where: { title: title } }) || null
          if (story && story.title.toLowerCase().replace(/\s+/g, ' ').trim() !== norm) story = null
        }
        await db.videoJob.create({
          data: {
            title: story ? story.title : `Hourly video · ${title}`,
            storyTitle: story ? story.title : title,
            status: 'done',
            source: 'backfill',
            language: (v.meta?.language as string) || (story?.language ?? 'en'),
            runId: String(run.id),
            artifactId: String(art.id),
            artifactEntry: v.mp4Entry,
            sizeBytes: Math.round(v.mp4SizeBytes ?? art.size_in_bytes / Math.max(1, videos.length)),
            durationSec,
            fps,
            storyRecordId: story?.id || null,
            tabName: story?.tabName || null,
            renderedAt: new Date(run.updated_at || run.created_at),
            platforms: JSON.stringify(platformStates(settings, { platforms: '[]', runConclusion: run.conclusion })),
          },
        })
        if (story) {
          await db.storyRecord.update({ where: { id: story.id }, data: { status: 'done' } }).catch(() => {})
        }
        existing.add(key)
        created++
      }
    }
  }
  return created
}

/** One video inside an artifact zip (legacy zips: files at root; batch zips: one dir per video). */
interface ArtifactVideo {
  mp4Entry: string
  mp4SizeBytes: number | null
  metaEntry: string
  meta: Record<string, unknown> | null
}

async function listArtifactVideos(artifactId: number): Promise<ArtifactVideo[]> {
  const zip = await loadArtifactZip(artifactId)
  const metaEntries = Object.values(zip.files)
    .filter((f) => !f.dir && /(^|\/)meta\.json$/.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  const out: ArtifactVideo[] = []
  for (const m of metaEntries) {
    const dir = m.name.includes('/') ? m.name.slice(0, m.name.lastIndexOf('/')) : ''
    const mp4Name = dir ? `${dir}/output.mp4` : 'output.mp4'
    const mp4 = zip.file(mp4Name) || Object.values(zip.files).find((f) => !f.dir && f.name.endsWith('.mp4'))
    if (!mp4) continue
    let meta: Record<string, unknown> | null = null
    try { meta = JSON.parse(await m.async('string')) as Record<string, unknown> } catch { /* keep null */ }
    out.push({ mp4Entry: mp4.name, mp4SizeBytes: null, metaEntry: m.name, meta })
  }
  return out
}

/** Attach a runId to just-dispatched jobs (dispatch API returns 204 with no id). */
async function linkPendingRuns(runs: Run[]): Promise<void> {
  const jobs = await db.videoJob.findMany({ where: { runId: null, status: 'queued' }, take: 10 })
  const linked = new Set(
    (await db.videoJob.findMany({ select: { runId: true }, take: 200 })).map((j) => j.runId).filter(Boolean)
  )
  const dispatched = runs.filter((r) => r.event === 'workflow_dispatch').sort((a, b) => b.created_at.localeCompare(a.created_at))
  for (const job of jobs) {
    const jobTime = new Date(job.createdAt).getTime()
    const match = dispatched.find(
      (r) => !linked.has(String(r.id)) && Math.abs(new Date(r.created_at).getTime() - jobTime) < 5 * 60 * 1000
    )
    if (match) {
      await db.videoJob.update({ where: { id: job.id }, data: { runId: String(match.id) } })
      linked.add(String(match.id))
    }
  }
}

export async function buildLibrary(): Promise<LibraryPayload> {
  const settings = await getSettings()
  // keep the sheet sync hot — respects the server-side rate limit
  const syncRes = await syncSheet().catch(() => null)

  let runs: Run[] = []
  let artifacts: Artifact[] = []
  let ghError: string | undefined
  if (settings.githubToken) {
    try {
      [runs, artifacts] = await Promise.all([
        listWorkflowRuns(settings.githubRepo, 15),
        listArtifacts(settings.githubRepo),
      ])
      await linkPendingRuns(runs)
      await backfill(runs, artifacts)
      await reconcile(runs, artifacts)
    } catch (e) {
      ghError = (e as Error).message
    }
  }

  const stories = await db.storyRecord.findMany({
    where: { status: { not: 'gone' } },
    orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
    take: 120,
    include: { videoJobs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })

  const runById = new Map(runs.map((r) => [String(r.id), r]))
  const artById = new Map(artifacts.map((a) => [a.id, a]))
  const artByRun = new Map<number, Artifact>()
  for (const a of artifacts) {
    const rid = a.workflow_run?.id
    if (rid) artByRun.set(rid, a)
  }

  const items: LibraryItem[] = []
  const stats: LibraryStats = { totalStories: 0, toMake: 0, inProgress: 0, done: 0, failed: 0, storageBytes: 0, totalVideos: 0 }
  // catch-up counts unique SHEET stories (standalone backfilled job cards are not part of the queue)
  let storyItems = 0
  let storyDone = 0

  const seenJobIds = new Set<string>()

  const enrichVideo = (job: typeof stories[0]['videoJobs'][0]): LibraryVideo | null => {
    const run = job.runId ? runById.get(job.runId) : undefined
    const art = (job.artifactId && artById.get(Number(job.artifactId))) || (run ? artByRun.get(run.id) : undefined)
    const runStatus = run?.status ?? null
    const runConclusion = run?.conclusion ?? null
    return {
      jobId: job.id,
      runId: job.runId,
      runStatus,
      runConclusion,
      runUrl: run?.html_url ?? null,
      artifactId: art ? String(art.id) : job.artifactId ?? null,
      artifactEntry: job.artifactEntry ?? null,
      sizeBytes: art?.size_in_bytes ?? job.sizeBytes ?? null,
      durationSec: job.durationSec ?? null,
      fps: job.fps ?? null,
      hyperframes: (job.fps ?? 0) >= 48,
      renderedAt: job.renderedAt ? job.renderedAt.toISOString() : null,
      createdAt: job.createdAt.toISOString(),
      platforms: platformStates(settings, { platforms: job.platforms, runConclusion, runStatus }),
      watchable: !!(art?.id ?? job.artifactId),
    }
  }

  const pushItem = (item: LibraryItem) => {
    items.push(item)
    stats.totalStories++
    if (!item.storyId.startsWith('job-')) {
      storyItems++
      if (item.status === 'done') storyDone++
    }
    if (item.status === 'new') stats.toMake++
    else if (item.status === 'queued' || item.status === 'rendering') stats.inProgress++
    else if (item.status === 'done') stats.done++
    else if (item.status === 'failed') stats.failed++
    if (item.video) {
      stats.totalVideos++
      if (item.video.sizeBytes) stats.storageBytes += item.video.sizeBytes
    }
  }

  for (const st of stories) {
    const job = st.videoJobs[0]
    if (job) seenJobIds.add(job.id)
    const video = job ? enrichVideo(job) : null
    let status: LibraryItem['status']
    if (st.status === 'done' || st.status === 'failed' || st.status === 'rendering' || st.status === 'queued') {
      status = st.status
    } else if (video?.runStatus === 'in_progress') status = 'rendering'
    else status = 'new'
    pushItem({
      storyId: st.id,
      tabName: st.tabName,
      title: st.title,
      logline: st.logline,
      genre: st.genre,
      duration: st.duration,
      language: st.language,
      scenes: st.scenes,
      words: st.words,
      status,
      firstSeenAt: st.firstSeenAt.toISOString(),
      lastSeenAt: st.lastSeenAt.toISOString(),
      video,
    })
  }

  // standalone jobs (backfilled past runs / chat-created jobs) — not tied to a story record
  const standaloneJobs = await db.videoJob.findMany({
    where: { storyRecordId: null, id: { notIn: [...seenJobIds] } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })
  for (const job of standaloneJobs) {
    const video = enrichVideo(job)
    const status: LibraryItem['status'] =
      job.status === 'done' || job.status === 'posted' ? 'done'
      : job.status === 'failed' ? 'failed'
      : 'queued'
    pushItem({
      storyId: `job-${job.id}`,
      tabName: job.tabName || 'GitHub Actions',
      title: job.storyTitle || job.title,
      logline: 'Rendered by the hourly workflow before the library sync existed.',
      genre: '',
      duration: video?.durationSec ? `${Math.round(video.durationSec)} seconds` : '',
      language: job.language || 'en',
      scenes: 0,
      words: 0,
      status,
      firstSeenAt: job.createdAt.toISOString(),
      lastSeenAt: job.updatedAt.toISOString(),
      video,
    })
  }

  // order: in-progress first, then to-make, then done/failed, then the rest by recency
  const order: Record<string, number> = { rendering: 0, queued: 1, new: 2, failed: 3, done: 4 }
  items.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.lastSeenAt.localeCompare(a.lastSeenAt))

  const lastLog = await db.syncLog.findFirst({ orderBy: { startedAt: 'desc' } })

  // catch-up progress: is EVERY sheet story becoming a video?
  const catchup: CatchupInfo = {
    total: storyItems,
    done: storyDone,
    pending: Math.max(0, storyItems - storyDone),
    failed: stats.failed,
    /** rough number of hourly runs still needed at ~2.5 videos/run */
    runsNeeded: Math.ceil(Math.max(0, storyItems - storyDone) / 2.5),
    active: storyItems - storyDone === 0 || stats.inProgress > 0,
  }

  return {
    ok: true,
    items,
    stats,
    catchup,
    lastSyncAt: syncRes?.finishedAt || lastLog?.startedAt.toISOString() || null,
    error: ghError,
  }
}

/* --------------------------- make a video now ------------------------------ */

export interface RenderResult {
  ok: boolean
  jobId?: string
  message: string
}

export async function renderStoryById(storyId: string): Promise<RenderResult> {
  const settings = await getSettings()
  const story = await db.storyRecord.findUnique({ where: { id: storyId } })
  if (!story) return { ok: false, message: 'Story not found' }
  if (!settings.githubToken) return { ok: false, message: 'GitHub not connected — add a token in Settings' }

  const active = await db.videoJob.findFirst({
    where: { storyRecordId: storyId, status: { in: ['queued', 'rendering'] } },
  })
  if (active) return { ok: false, message: 'This story already has a render in progress' }

  // dispatch with the full story JSON so ANY tab (any format) can be rendered
  await dispatchWorkflow(settings.githubRepo, 'hourly-video.yml', 'main', {
    story_json: JSON.stringify(JSON.parse(story.storyJson || '{}')),
  })
  const job = await db.videoJob.create({
    data: {
      title: `Hourly video · ${story.title}`,
      storyTitle: story.title,
      status: 'queued',
      source: 'sheet',
      language: story.language,
      storyRecordId: story.id,
      tabName: story.tabName,
    },
  })
  await db.storyRecord.update({ where: { id: story.id }, data: { status: 'queued' } }).catch(() => {})
  return { ok: true, jobId: job.id, message: `Dispatched render for "${story.title}"` }
}

/** Dispatches the BATCH catch-up run: the workflow renders every pending sheet story. */
export async function renderAllPending(): Promise<RenderResult> {
  const settings = await getSettings()
  if (!settings.githubToken) return { ok: false, message: 'GitHub not connected — add a token in Settings' }

  const inProgress = await db.videoJob.count({ where: { status: { in: ['queued', 'rendering'] } } })
  const runs = await listWorkflowRuns(settings.githubRepo, 5).catch(() => [] as Run[])
  const activeRun = runs.find((r) => r.status === 'in_progress' || r.status === 'queued')
  if (activeRun) {
    return { ok: false, message: `A render run is already in progress (#${activeRun.id}) — it will keep draining the queue.` }
  }
  if (inProgress > 0 && !activeRun) {
    // stale local jobs with no live run — still safe to dispatch a fresh batch
    await db.videoJob.updateMany({ where: { status: { in: ['queued', 'rendering'] } }, data: { status: 'failed', log: 'superseded by a batch catch-up run' } }).catch(() => {})
  }

  const pending = await db.storyRecord.count({ where: { status: 'new' } })
  await dispatchWorkflow(settings.githubRepo, 'factory.yml', 'main', { reason: 'catchup' })
  return {
    ok: true,
    message: `Continuous Video Factory dispatched — ${pending} pending ${pending === 1 ? 'story' : 'stories'} will render back-to-back (keyless-AI-written hyperframe code), and the factory keeps chaining itself so generation never stops.`,
  }
}

/* ------------------------- playable MP4 from artifacts --------------------- */

const CACHE_DIR = path.join(process.cwd(), '.cache', 'videos')

async function loadArtifactZip(artifactId: number | string): Promise<JSZip> {
  await mkdir(CACHE_DIR, { recursive: true })
  const zipPath = path.join(CACHE_DIR, `${artifactId}.zip`)
  let buf: Buffer
  try {
    buf = await readFile(zipPath)
  } catch {
    const settings = await getSettings()
    const ab = await downloadArtifactZip(settings.githubRepo, artifactId)
    buf = Buffer.from(ab)
    await writeFile(zipPath, buf).catch(() => {})
  }
  const zip = await JSZip.loadAsync(buf)
  return zip
}

/** Returns a cached MP4 buffer for the artifact, extracting the requested entry once.
 *  `entry` selects one video inside a multi-video batch artifact (falls back to the first MP4). */
export async function getArtifactMp4(artifactId: number | string, entry?: string | null): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true })
  const entryKey = entry ? entry.replace(/[^a-zA-Z0-9_-]/g, '_') : 'root'
  const mp4Path = path.join(CACHE_DIR, `${artifactId}-${entryKey}.mp4`)
  try {
    return await readFile(mp4Path)
  } catch { /* not cached yet */ }
  const zip = await loadArtifactZip(artifactId)
  const file =
    (entry && zip.file(entry)) ||
    zip.file('output/output.mp4') ||
    Object.values(zip.files).find((f) => !f.dir && f.name.endsWith('.mp4'))
  if (!file) throw new Error('No MP4 inside the artifact')
  const buf = await file.async('nodebuffer')
  await writeFile(mp4Path, buf).catch(() => {})
  return buf
}

/** Finds the artifact for a library job (by artifact id or its run). */
export async function findArtifactForJob(jobId: string): Promise<{ artifactId: string; entry: string | null } | null> {
  const job = await db.videoJob.findUnique({ where: { id: jobId } })
  if (!job) return null
  if (job.artifactId) return { artifactId: job.artifactId, entry: job.artifactEntry }
  if (job.runId) {
    const settings = await getSettings()
    const artifacts = await listArtifacts(settings.githubRepo).catch(() => [])
    const art = artifacts.find((a) => a.workflow_run?.id === Number(job.runId))
    if (art) {
      await db.videoJob.update({ where: { id: job.id }, data: { artifactId: String(art.id), sizeBytes: art.size_in_bytes } })
      return { artifactId: String(art.id), entry: job.artifactEntry }
    }
  }
  return null
}
