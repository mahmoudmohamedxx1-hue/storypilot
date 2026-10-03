'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ViewShell, Badge } from '@/components/agent/view-shell'
import { useApp } from '@/components/agent/store'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  RefreshCw, Loader2, Film, Clapperboard, Play, Youtube, Trash2,
  ExternalLink, Languages, Clock, Sparkles, HardDrive, CheckCircle2,
  XCircle, Video, Ghost, CircleDashed, Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface PlatformState { platform: string; configured: boolean; status: string; url?: string }
interface LibraryVideo {
  jobId: string; runId: string | null; runStatus: string | null; runConclusion: string | null
  runUrl: string | null; artifactId: number | null; sizeBytes: number | null
  durationSec: number | null; renderedAt: string | null; createdAt: string
  platforms: PlatformState[]; watchable: boolean
}
interface LibraryItem {
  storyId: string; tabName: string; title: string; logline: string; genre: string
  duration: string; language: string; scenes: number; words: number
  status: 'new' | 'queued' | 'rendering' | 'done' | 'failed'
  firstSeenAt: string; lastSeenAt: string; video: LibraryVideo | null
}
interface LibraryStats {
  totalStories: number; toMake: number; inProgress: number; done: number
  failed: number; storageBytes: number; totalVideos: number
}
interface LibraryData {
  ok: boolean; items: LibraryItem[]; stats: LibraryStats; lastSyncAt: string | null; error?: string
}

type Filter = 'all' | 'tomake' | 'progress' | 'done' | 'failed'

const HUES = [212, 262, 340, 160, 24, 200, 290, 130]
function hueFor(id: string): number {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997
  return HUES[h % HUES.length]
}

function fmtBytes(b: number | null): string {
  if (!b) return '—'
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b > 1e3) return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}

function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function StatusChip({ status }: { status: LibraryItem['status'] }) {
  if (status === 'rendering')
    return <Badge tone="amber"><Loader2 size={10} className="animate-spin" /> rendering</Badge>
  if (status === 'queued')
    return <Badge tone="amber"><Clock size={10} /> queued</Badge>
  if (status === 'done')
    return <Badge tone="green"><CheckCircle2 size={10} /> in library</Badge>
  if (status === 'failed')
    return <Badge tone="red"><XCircle size={10} /> failed</Badge>
  return <Badge tone="blue"><Sparkles size={10} /> to make</Badge>
}

function PlatformDots({ video }: { video: LibraryVideo }) {
  const icons: Record<string, React.ElementType> = { youtube: Youtube, tiktok: Video, instagram: Play }
  const names: Record<string, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' }
  return (
    <div className="flex items-center gap-1.5" aria-label="Platform publishing state">
      {video.platforms.map((p) => {
        const Icon = icons[p.platform]
        const tone = p.status === 'posted' ? 'text-[#0e9f6e] bg-[#E9F9F0] border-[#C9EFDD]'
          : p.status === 'failed' ? 'text-[#d13438] bg-[#FDECEC] border-[#F8D4D4]'
          : p.status === 'skipped' ? 'text-[#b3b8c2] bg-[#F5F7FA] border-[#E5E7EB]'
          : 'text-[#b45309] bg-[#FFF6E5] border-[#FBE5B6]'
        const label = p.status === 'posted' ? `${names[p.platform]}: posted` : p.status === 'skipped' ? `${names[p.platform]}: not configured` : `${names[p.platform]}: ${p.status}`
        return (
          <span key={p.platform} title={label} aria-label={label}
            className={cn('inline-flex items-center justify-center w-6 h-6 rounded-md border', tone)}>
            <Icon size={12} />
          </span>
        )
      })}
    </div>
  )
}

function VideoCard({ item, onWatch, onRender, busyId }: {
  item: LibraryItem
  onWatch: (item: LibraryItem) => void
  onRender: (item: LibraryItem) => void
  busyId: string | null
}) {
  const hue = hueFor(item.storyId)
  const busy = busyId === item.storyId
  const isNew = item.status === 'new'

  return (
    <article className="group rounded-2xl border border-[#E5E7EB] bg-white overflow-hidden hover:border-[#315CEA]/40 hover:shadow-[0_4px_20px_rgba(22,40,120,0.07)] transition-all">
      {/* 9:16 thumb */}
      <div className="relative bg-[#F9FAFB] flex items-center justify-center py-4"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 70% 96%), hsl(${(hue + 40) % 360} 60% 92%))` }}>
        <div className="relative w-24 sm:w-28 aspect-[9/16] rounded-lg shadow-md overflow-hidden flex flex-col"
          style={{ background: `linear-gradient(165deg, hsl(${hue} 62% 38%), hsl(${(hue + 45) % 360} 70% 22%))` }}>
          {/* title lines */}
          <div className="flex-1 p-2 flex flex-col gap-1.5 justify-end">
            <div className="h-1.5 rounded-full bg-white/60 w-4/5" />
            <div className="h-1.5 rounded-full bg-white/35 w-3/5" />
            <div className="h-1.5 rounded-full bg-white/20 w-2/3" />
          </div>
          <div className="bg-black/25 backdrop-blur-sm px-2 py-1.5">
            <p className="text-[8px] font-bold text-white/95 leading-tight line-clamp-2" dir="auto">{item.title}</p>
          </div>
        </div>

        <div className="absolute top-2.5 left-2.5"><StatusChip status={item.status} /></div>
        <span className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 bg-white/90 backdrop-blur border border-[#E5E7EB] rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[#4a4f58]">
          <Clock size={10} /> {item.duration.replace(/\s*\([^)]*\)/, '') || '60s'}
        </span>
        {item.language === 'ar' && (
          <span className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 bg-white/90 backdrop-blur border border-[#E5E7EB] rounded-full px-2 py-0.5 text-[10.5px] font-medium text-[#4a4f58]">
            <Languages size={10} /> العربية
          </span>
        )}

        {item.video?.watchable && (
          <button
            onClick={() => onWatch(item)}
            aria-label={`Watch ${item.title}`}
            className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/10 transition-colors"
          >
            <span className="w-12 h-12 rounded-full bg-white shadow-lg flex items-center justify-center text-[#315CEA] scale-90 group-hover:scale-100 transition-transform">
              <Play size={20} className="ml-0.5" fill="currentColor" />
            </span>
          </button>
        )}
      </div>

      {/* body */}
      <div className="p-4">
        <h3 className="text-[14px] font-semibold text-[#1a1c20] leading-snug line-clamp-2 min-h-[2.5rem]" dir="auto" title={item.title}>
          {item.title}
        </h3>
        <p className="mt-1.5 text-[11.5px] text-[#9aa0ab] flex items-center gap-1.5 flex-wrap">
          <Layers size={11} /> {item.scenes} scenes
          <span className="text-[#d5d9e0]">·</span>
          {item.words} words
          <span className="text-[#d5d9e0]">·</span>
          <span className="truncate max-w-[120px]" title={item.tabName}>{item.tabName}</span>
        </p>

        {item.video ? (
          <div className="mt-3 flex items-center justify-between gap-2">
            <PlatformDots video={item.video} />
            <div className="flex items-center gap-1">
              {item.video.runUrl && (
                <a href={item.video.runUrl} target="_blank" rel="noreferrer" title="Open the GitHub Actions run"
                  className="p-1.5 rounded-md text-[#9aa0ab] hover:text-[#315CEA] hover:bg-[#F0F4FF] transition-colors">
                  <ExternalLink size={14} />
                </a>
              )}
              {item.video.watchable && (
                <button onClick={() => onWatch(item)} title="Watch the video"
                  className="p-1.5 rounded-md text-[#9aa0ab] hover:text-[#315CEA] hover:bg-[#F0F4FF] transition-colors"
                  aria-label="Watch video">
                  <Play size={14} />
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] text-[#b3b8c2] flex items-center gap-1">
              <Film size={11} /> waiting to be made
            </span>
            {isNew && (
              <Button size="sm" disabled={busy} onClick={() => onRender(item)}
                className="h-7 gap-1.5 text-[12px] bg-[#315CEA] hover:bg-[#2a50d4] px-3">
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Clapperboard size={12} />}
                Make video
              </Button>
            )}
          </div>
        )}

        {item.video?.renderedAt && (
          <p className="mt-2 text-[10.5px] text-[#b3b8c2] flex items-center gap-1">
            <HardDrive size={10} /> {fmtBytes(item.video.sizeBytes)} · rendered {timeAgo(item.video.renderedAt)}
          </p>
        )}
      </div>
    </article>
  )
}

export function LibraryView() {
  const syncVersion = useApp((s) => s.syncVersion)
  const [data, setData] = useState<LibraryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [watching, setWatching] = useState<LibraryItem | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/library')
      const j = await res.json()
      setData(j)
    } catch {
      setData((d) => d)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, syncVersion])

  // keep the library live while the view is open
  useEffect(() => {
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, [load])

  const syncNow = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      const j = await res.json()
      if (j.ok) {
        const r = j.result
        toast.success('Sheet synced', {
          description: `${r.tabsFound} tabs · ${r.storiesNew} new · ${r.storiesChanged} changed${r.storiesNew > 0 || r.storiesChanged > 0 ? '' : ' · up to date'}`,
        })
        await load()
      } else toast.error(j.result?.error || j.error || 'Sync failed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const render = async (item: LibraryItem) => {
    setBusyId(item.storyId)
    try {
      const res = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'render', storyId: item.storyId }),
      })
      const j = await res.json()
      if (j.ok) {
        toast.success('Render dispatched 🎬', { description: j.message + ' — watch it live in the Pipeline view.' })
        setTimeout(load, 2500)
      } else toast.error(j.message || 'Failed to dispatch')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const items = useMemo(() => {
    const list = data?.items || []
    switch (filter) {
      case 'tomake': return list.filter((i) => i.status === 'new')
      case 'progress': return list.filter((i) => i.status === 'queued' || i.status === 'rendering')
      case 'done': return list.filter((i) => i.status === 'done')
      case 'failed': return list.filter((i) => i.status === 'failed')
      default: return list
    }
  }, [data, filter])

  const stats = data?.stats

  return (
    <ViewShell
      title="Library"
      subtitle="Every video from the Google Sheet — to make, rendering, or done. Always in sync."
      actions={
        <>
          <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing} className="gap-1.5">
            <RefreshCw size={13} className={cn(syncing && 'animate-spin')} /> Sync now
          </Button>
          <a href="https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit" target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm" className="gap-1.5">Open Sheet</Button>
          </a>
        </>
      }
    >
      {loading && !data ? (
        <div className="flex items-center justify-center py-24 text-[#9aa0ab] gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Syncing the sheet & building your library…
        </div>
      ) : !data?.ok && !data?.items?.length ? (
        <div className="rounded-2xl border border-[#E5E7EB] p-10 text-center">
          <Ghost size={34} className="mx-auto text-[#9aa0ab]" />
          <h3 className="mt-4 font-semibold text-[#1a1c20]">Library is empty</h3>
          <p className="mt-1.5 text-sm text-[#6b7280] max-w-sm mx-auto leading-relaxed">
            {data?.error || 'Hit “Sync now” to pull every story from the Google Sheet.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'TO MAKE', value: stats?.toMake ?? 0, sub: 'stories waiting in the sheet', icon: Sparkles, tone: 'text-[#315CEA]' },
              { label: 'IN PROGRESS', value: stats?.inProgress ?? 0, sub: 'queued or rendering now', icon: Clapperboard, tone: 'text-[#b45309]' },
              { label: 'DONE', value: stats?.done ?? 0, sub: 'videos in the library', icon: CheckCircle2, tone: 'text-[#0e9f6e]' },
              { label: 'STORAGE', value: fmtBytes(stats?.storageBytes ?? 0), sub: `${stats?.totalVideos ?? 0} rendered MP4s`, icon: HardDrive, tone: 'text-[#6b7280]' },
            ].map((s) => (
              <div key={s.label} className="rounded-2xl border border-[#E5E7EB] p-4">
                <div className="flex items-center gap-2 text-[#8a8f99] text-[12px] font-medium"><s.icon size={13} /> {s.label}</div>
                <p className={cn('mt-2 font-semibold text-[19px] text-[#1a1c20]', s.tone)}>{s.value}</p>
                <p className="text-[12px] text-[#9aa0ab] mt-1">{s.sub}</p>
              </div>
            ))}
          </div>

          {/* filters */}
          <div className="flex items-center gap-2 flex-wrap" role="tablist" aria-label="Filter library">
            {([
              ['all', `All (${stats?.totalStories ?? 0})`],
              ['tomake', `To make (${stats?.toMake ?? 0})`],
              ['progress', `Rendering (${stats?.inProgress ?? 0})`],
              ['done', `Done (${stats?.done ?? 0})`],
              ['failed', `Failed (${stats?.failed ?? 0})`],
            ] as Array<[Filter, string]>).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-[12.5px] font-medium border transition-colors',
                  filter === key
                    ? 'bg-[#315CEA] text-white border-[#315CEA]'
                    : 'bg-white text-[#6b7280] border-[#E5E7EB] hover:border-[#315CEA]/50 hover:text-[#315CEA]'
                )}>
                {label}
              </button>
            ))}
            {data?.lastSyncAt && (
              <span className="ml-auto text-[11px] text-[#b3b8c2] flex items-center gap-1">
                <CircleDashed size={10} /> synced {timeAgo(data.lastSyncAt)}
              </span>
            )}
          </div>

          {/* grid */}
          {items.length ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {items.map((item) => (
                <VideoCard key={item.storyId} item={item} onWatch={setWatching} onRender={render} busyId={busyId} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[#E5E7EB] p-10 text-center text-sm text-[#9aa0ab]">
              Nothing here yet for this filter.
            </div>
          )}

          <p className="text-[11.5px] text-[#b3b8c2] leading-relaxed">
            The library mirrors the whole Google Sheet (14 tabs, English + العربية). New or changed stories appear automatically —
            hit <span className="font-medium text-[#315CEA]">Make video</span> to render any of them on GitHub Actions
            (1080×1920, Edge-TTS voiceover, keyless GLM), then watch it right here.
          </p>
        </div>
      )}

      {/* watch dialog */}
      <Dialog open={!!watching} onOpenChange={(o) => { if (!o) setWatching(null) }}>
        <DialogContent className="max-w-md p-0 overflow-hidden bg-black border-white/10">
          <DialogHeader className="sr-only">
            <DialogTitle>{watching?.title}</DialogTitle>
            <DialogDescription>Rendered video player</DialogDescription>
          </DialogHeader>
          {watching?.video && (
            <>
              <video
                key={watching.video.jobId}
                controls
                autoPlay
                playsInline
                className="w-full max-h-[72vh] bg-black"
                src={`/api/library/video/${watching.video.jobId}`}
                aria-label={`Video player for ${watching.title}`}
              />
              <div className="p-4 bg-black text-white/90">
                <p className="text-[13.5px] font-medium leading-snug line-clamp-2" dir="auto">{watching.title}</p>
                <p className="mt-1 text-[11px] text-white/50 flex items-center gap-2">
                  {watching.duration.replace(/\s*\([^)]*\)/, '') || '60s'}
                  {watching.video.durationSec ? ` · ${watching.video.durationSec}s rendered` : ''}
                  {watching.video.runId ? ` · run #${watching.video.runId}` : ''}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {watching.video.runUrl && (
                    <a href={watching.video.runUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-[12px] text-white/70 hover:text-white border border-white/15 rounded-lg px-2.5 py-1.5 transition-colors">
                      <ExternalLink size={12} /> GitHub run
                    </a>
                  )}
                  <span className="text-[11px] text-white/40">1080×1920 · H.264 + AAC</span>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </ViewShell>
  )
}
