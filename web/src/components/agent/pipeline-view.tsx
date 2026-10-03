'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ViewShell, Badge } from '@/components/agent/view-shell'
import { useApp } from '@/components/agent/store'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  RefreshCw, Rocket, Github, PlayCircle, ExternalLink, Loader2,
  Clock, FileCode2, Package, BookOpenText, Clapperboard, Film, Youtube,
  Music2, Instagram, ZoomIn, ZoomOut, Maximize2, Radio, ChevronRight, Ban,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ------------------------------- data types -------------------------------- */

interface Run {
  id: number; name: string; status: string; conclusion: string | null; event: string
  created_at: string; updated_at: string; run_attempt: number; html_url: string; display_title: string
}
interface Step { name: string; status: string; conclusion: string | null; number: number; started_at: string | null; completed_at: string | null }
interface Job { id: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; html_url: string; steps: Step[] }
interface Artifact { id: number; name: string; size_in_bytes: number; created_at: string; workflow_run?: { id: number } }
interface LiveData {
  ok: boolean; connected: boolean; error?: string
  user?: { login: string; avatar_url: string }
  repo: string
  runs: Run[]
  selectedRunId: number | null
  jobs: Job[]
  artifacts: Artifact[]
  workflows: Array<{ id: number; name: string; state: string; html_url: string }>
}

/* ------------------------------- node graph -------------------------------- */

type NodeStatus = 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'skipped'

interface NodeDef {
  id: string
  label: string
  sub: string
  icon: React.ElementType
  kind: 'trigger' | 'setup' | 'story' | 'render' | 'library' | 'platform'
  steps: string[]
  color: string // icon tile background
}

const NODES: NodeDef[] = [
  { id: 'trigger', label: 'Hourly Schedule', sub: 'cron · 0 * * * * (UTC)', icon: Clock, kind: 'trigger', steps: [], color: 'bg-[#FFF6E5] text-[#b45309]' },
  { id: 'checkout', label: 'Checkout', sub: 'actions/checkout@v4', icon: Github, kind: 'setup', steps: ['Checkout'], color: 'bg-[#F5F7FA] text-[#3c4658]' },
  { id: 'python', label: 'Python 3.11', sub: 'setup-python@v5', icon: FileCode2, kind: 'setup', steps: ['Set up Python'], color: 'bg-[#F5F7FA] text-[#3c4658]' },
  { id: 'deps', label: 'Dependencies', sub: 'ffmpeg · edge-tts · moviepy', icon: Package, kind: 'setup', steps: ['Install system deps (ffmpeg + fonts incl. Arabic)', 'Install Python deps'], color: 'bg-[#F0F4FF] text-[#315CEA]' },
  { id: 'story', label: 'Fetch Story', sub: 'Google Sheet · keyless GLM', icon: BookOpenText, kind: 'story', steps: ['Prepare story (Google Sheet by Gemini Spark + keyless GLM fallback)'], color: 'bg-[#F0F4FF] text-[#315CEA]' },
  { id: 'render', label: 'Render MP4', sub: '1080×1920 · 24fps · Edge-TTS', icon: Clapperboard, kind: 'render', steps: ['Render MP4 (Edge-TTS + MoviePy, 1080x1920)'], color: 'bg-[#F3EEFF] text-[#7c3aed]' },
  { id: 'library', label: 'Save to Library', sub: 'artifact · output.mp4', icon: Film, kind: 'library', steps: ['Upload video artifact'], color: 'bg-[#E9F9F0] text-[#0e9f6e]' },
  { id: 'youtube', label: 'YouTube', sub: 'post_video.py --youtube', icon: Youtube, kind: 'platform', steps: ['Post to YouTube'], color: 'bg-[#FDECEC] text-[#d13438]' },
  { id: 'tiktok', label: 'TikTok', sub: 'post_video.py --tiktok', icon: Music2, kind: 'platform', steps: ['Post to TikTok'], color: 'bg-[#1a1c20] text-white' },
  { id: 'instagram', label: 'Instagram Reels', sub: 'post_video.py --instagram', icon: Instagram, kind: 'platform', steps: ['Post to Instagram Reels'], color: 'bg-[#FCE7F3] text-[#c026d3]' },
]

const POS: Record<string, { x: number; y: number }> = {
  trigger: { x: 0, y: 0 }, checkout: { x: 288, y: 0 }, python: { x: 576, y: 0 }, deps: { x: 864, y: 0 },
  story: { x: 1152, y: 0 }, render: { x: 1440, y: 0 }, library: { x: 1728, y: 0 },
  youtube: { x: 2016, y: -100 }, tiktok: { x: 2016, y: 0 }, instagram: { x: 2016, y: 100 },
}

const EDGES: Array<[string, string]> = [
  ['trigger', 'checkout'], ['checkout', 'python'], ['python', 'deps'], ['deps', 'story'],
  ['story', 'render'], ['render', 'library'], ['library', 'youtube'], ['library', 'tiktok'], ['library', 'instagram'],
]

const NODE_W = 200, NODE_H = 68
const CONTENT_W = 2016 + NODE_W + 40
const CONTENT_H = 320

function stepToStatus(step?: { status: string; conclusion: string | null }): NodeStatus {
  if (!step) return 'idle'
  if (step.status === 'in_progress') return 'running'
  if (step.status === 'completed') {
    if (step.conclusion === 'success') return 'success'
    if (step.conclusion === 'skipped' || step.conclusion === 'cancelled') return 'skipped'
    return 'failed'
  }
  return 'queued'
}

interface NodeState { status: NodeStatus; steps: Step[]; note?: string }

function computeNodeStates(defs: NodeDef[], run: Run | undefined, jobs: Job[]): Record<string, NodeState> {
  const out: Record<string, NodeState> = {}
  const allSteps: Step[] = (jobs[0]?.steps || []).filter((s) => !/^Post |Complete job|Set up job/.test(s.name))
  for (const def of defs) {
    if (def.kind === 'trigger') {
      if (!run) { out[def.id] = { status: 'idle', steps: [] }; continue }
      const st: NodeStatus = run.status === 'in_progress' ? 'running' : run.status === 'queued' ? 'queued' : run.conclusion === 'success' ? 'success' : run.conclusion ? 'failed' : 'idle'
      out[def.id] = { status: st, steps: [] }
      continue
    }
    const steps = allSteps.filter((s) => def.steps.includes(s.name))
    if (!steps.length) { out[def.id] = { status: 'idle', steps: [] }; continue }
    const statuses = steps.map(stepToStatus)
    const running = statuses.includes('running')
    const failed = statuses.includes('failed')
    const anyQueued = statuses.includes('queued')
    const allDone = statuses.every((s) => s === 'success' || s === 'skipped')
    let status: NodeStatus = 'success'
    if (running) status = 'running'
    else if (failed) status = 'failed'
    else if (anyQueued) status = 'queued'
    else if (allDone) {
      status = steps.every((s) => stepToStatus(s) === 'success') ? 'success' : 'skipped'
    }
    const note = status === 'skipped' ? 'skipped — platform secret not set' : undefined
    out[def.id] = { status, steps, note }
  }
  return out
}

/* --------------------------------- helpers --------------------------------- */

function fmtDur(a?: string | null, b?: string | null): string {
  if (!a || !b) return '—'
  const ms = new Date(b).getTime() - new Date(a).getTime()
  if (ms < 0 || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

function fmtBytes(b: number): string {
  if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`
  if (b > 1e3) return `${(b / 1e3).toFixed(0)} KB`
  return `${b} B`
}

function nextRunLabel(): string {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0)
  const cairo = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' }).format(next)
  const utc = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(next)
  return `${utc} UTC · ${cairo} Cairo`
}

const STATUS_STYLES: Record<NodeStatus, { ring: string; dot: string; label: string }> = {
  idle: { ring: 'border-[#E5E7EB]', dot: 'bg-[#d5d9e0]', label: 'waiting' },
  queued: { ring: 'border-[#f5a623]/60', dot: 'bg-[#f5a623]', label: 'queued' },
  running: { ring: 'border-[#315CEA] ring-2 ring-[#315CEA]/25 shadow-[0_0_0_4px_rgba(49,92,234,0.08)]', dot: 'bg-[#315CEA] animate-pulse', label: 'running' },
  success: { ring: 'border-[#0e9f6e]', dot: 'bg-[#0e9f6e]', label: 'success' },
  failed: { ring: 'border-[#d13438] ring-2 ring-[#d13438]/20', dot: 'bg-[#d13438]', label: 'failed' },
  skipped: { ring: 'border-dashed border-[#c9ced8]', dot: 'bg-[#c9ced8]', label: 'skipped' },
}

/* ------------------------------- main view --------------------------------- */

export function PipelineView() {
  const setView = useApp((s) => s.setView)
  const [data, setData] = useState<LiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null) // null = follow latest
  const [inspected, setInspected] = useState<string | null>(null)
  const [zoom, setZoom] = useState(0.5)
  const [pan, setPan] = useState({ x: 24, y: 60 })
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const q = selectedRunId ? `?runId=${selectedRunId}` : ''
      const res = await fetch(`/api/pipeline/live${q}`)
      setData(await res.json())
    } catch {
      // keep old data
    } finally {
      setLoading(false)
    }
  }, [selectedRunId])

  useEffect(() => { load() }, [load])

  const run = useMemo(
    () => data?.runs.find((r) => r.id === (selectedRunId ?? data.selectedRunId)) || data?.runs[0],
    [data, selectedRunId]
  )
  const isActive = run?.status === 'in_progress' || run?.status === 'queued'

  // live polling — fast while a run is active, slow otherwise
  useEffect(() => {
    const t = setInterval(load, isActive ? 4000 : 20000)
    return () => clearInterval(t)
  }, [load, isActive])

  // wheel zoom (non-passive)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && Math.abs(e.deltaY) < 2) return
      e.preventDefault()
      setZoom((z) => Math.min(1.4, Math.max(0.25, z * (e.deltaY > 0 ? 0.9 : 1.1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const fit = useCallback(() => {
    const el = containerRef.current
    const w = el?.clientWidth || 900
    const h = el?.clientHeight || 420
    const z = Math.min(1, Math.max(0.25, (w - 48) / CONTENT_W))
    setZoom(z)
    setPan({ x: 24, y: Math.max(10, (h - CONTENT_H * z) / 2) })
  }, [])
  useEffect(() => { fit() }, [fit])

  const nodeStates = useMemo(() => computeNodeStates(NODES, run, data?.jobs || []), [run, data])

  const totalSteps = useMemo(
    () => NODES.filter((n) => n.kind !== 'trigger').reduce((acc, n) => acc + n.steps.length, 0),
    []
  )
  const doneSteps = useMemo(
    () => Object.values(nodeStates).reduce((acc, s) => acc + s.steps.filter((x) => x.status === 'completed').length, 0),
    [nodeStates]
  )

  const act = async (action: 'dispatch' | 'deploy') => {
    setBusy(action)
    try {
      const res = await fetch('/api/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const j = await res.json()
      if (j.ok) {
        toast.success(action === 'dispatch' ? 'Workflow dispatched' : 'Pipeline deployed', {
          description: action === 'dispatch' ? 'Rendering now — the canvas will light up live.' : undefined,
        })
        setSelectedRunId(null)
        setTimeout(load, 2500)
      } else toast.error(j.error || 'Action failed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-node]')) return
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) })
  }
  const onPointerUp = () => { dragRef.current = null }

  const edgePath = (a: string, b: string) => {
    const p1 = POS[a], p2 = POS[b]
    const x1 = p1.x + NODE_W, y1 = p1.y + NODE_H / 2
    const x2 = p2.x, y2 = p2.y + NODE_H / 2
    const dx = Math.max(40, (x2 - x1) * 0.45)
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
  }

  const edgeState = (a: string, b: string): 'idle' | 'active' | 'done' | 'fail' => {
    const sa = nodeStates[a]?.status, sb = nodeStates[b]?.status
    if (sa === 'success' && sb === 'running') return 'active'
    if (sa === 'success' && (sb === 'success')) return 'done'
    if (sa === 'success' && sb === 'skipped') return 'done'
    if (sa === 'failed') return 'fail'
    if (sa === 'running') return 'active'
    return 'idle'
  }

  const connected = data?.connected && data?.ok
  const inspectedNode = NODES.find((n) => n.id === inspected)
  const inspectedState = inspected ? nodeStates[inspected] : null
  const artByRun = useMemo(() => new Map((data?.artifacts || []).map((a) => [a.workflow_run?.id, a])), [data])

  return (
    <ViewShell
      title="Pipeline"
      subtitle="n8n-style live view of the hourly workflow — story → MP4 → YouTube / TikTok / Instagram"
      actions={
        <>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} /> Refresh
          </Button>
          <Button size="sm" onClick={() => act('dispatch')} disabled={!!busy || !connected} className="gap-1.5 bg-[#315CEA] hover:bg-[#2a50d4]">
            {busy === 'dispatch' ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />} Run now
          </Button>
          <Button variant="outline" size="sm" onClick={() => act('deploy')} disabled={!!busy || !connected} className="gap-1.5">
            {busy === 'deploy' ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />} Deploy files
          </Button>
        </>
      }
    >
      {loading && !data ? (
        <div className="flex items-center justify-center py-24 text-[#9aa0ab] gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading the live pipeline…
        </div>
      ) : !connected ? (
        <div className="rounded-2xl border border-[#E5E7EB] p-10 text-center">
          <Github size={34} className="mx-auto text-[#9aa0ab]" />
          <h3 className="mt-4 font-semibold text-[#1a1c20]">GitHub not connected</h3>
          <p className="mt-1.5 text-sm text-[#6b7280] max-w-sm mx-auto leading-relaxed">
            {data?.error || 'Add a GitHub token with repo + workflow permissions to control the hourly pipeline from here.'}
          </p>
          <Button size="sm" className="mt-5 bg-[#315CEA] hover:bg-[#2a50d4]" onClick={() => setView('settings')}>Open Settings</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* status strip */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-[#E5E7EB] px-4 py-3 text-[12.5px] text-[#6b7280]">
            <span className="flex items-center gap-1.5 font-medium text-[#1a1c20]"><Github size={13} /> {data?.user?.login}</span>
            <span className="hidden sm:inline text-[#d5d9e0]">|</span>
            <span className="truncate max-w-[220px]" title={data?.repo}>{data?.repo}</span>
            <span className="text-[#d5d9e0]">|</span>
            <span className="flex items-center gap-1.5"><Clock size={12} /> next run {nextRunLabel()}</span>
            <span className="text-[#d5d9e0]">|</span>
            {run ? (
              <span className="flex items-center gap-1.5">
                {isActive ? (
                  <><Radio size={12} className="text-[#315CEA] animate-pulse" />
                    <span className="font-medium text-[#315CEA]">LIVE</span>
                    <span className="text-[#9aa0ab]">run #{run.id} · {doneSteps}/{totalSteps} steps</span></>
                ) : (
                  <><Ban size={0} className="hidden" />
                    <span className="text-[#9aa0ab]">viewing run #{run.id} · {run.conclusion ?? run.status} · {new Date(run.created_at).toLocaleString()}</span></>
                )}
                <a href={run.html_url} target="_blank" rel="noreferrer" className="text-[#315CEA] hover:underline inline-flex items-center gap-0.5">
                  open <ExternalLink size={10} />
                </a>
              </span>
            ) : (
              <span className="text-[#9aa0ab]">no runs yet — deploy the files then hit Run now</span>
            )}
            {isActive && (
              <span className="ml-auto hidden md:block">
                <span className="inline-block w-36 h-1.5 rounded-full bg-[#F0F2F5] overflow-hidden align-middle">
                  <span className="block h-full bg-[#315CEA] transition-all duration-700" style={{ width: `${(doneSteps / totalSteps) * 100}%` }} />
                </span>
              </span>
            )}
          </div>

          {/* canvas */}
          <div
            ref={containerRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            className="relative h-[400px] md:h-[440px] rounded-2xl border border-[#E5E7EB] overflow-hidden select-none touch-none cursor-grab active:cursor-grabbing bg-[#FBFCFE]"
            style={{
              backgroundImage: 'radial-gradient(#d5d9e0 1.1px, transparent 1.1px)',
              backgroundSize: '22px 22px',
            }}
            role="application"
            aria-label="Pipeline node canvas — drag to pan, use buttons to zoom"
          >
            <div
              className="absolute top-0 left-0 origin-top-left"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, width: CONTENT_W, height: CONTENT_H }}
            >
              {/* edges */}
              <svg width={CONTENT_W} height={CONTENT_H} className="absolute top-0 left-0 pointer-events-none" aria-hidden="true">
                {EDGES.map(([a, b]) => {
                  const st = edgeState(a, b)
                  return (
                    <path key={`${a}-${b}`} d={edgePath(a, b)} fill="none"
                      stroke={st === 'active' ? '#315CEA' : st === 'done' ? '#8fd4b4' : st === 'fail' ? '#f0b6b6' : '#d5d9e0'}
                      strokeWidth={st === 'active' ? 2.5 : 2}
                      strokeDasharray={st === 'active' ? '7 6' : undefined}
                      className={st === 'active' ? 'animate-[dash_1s_linear_infinite]' : undefined}
                    />
                  )
                })}
              </svg>

              {/* nodes */}
              {NODES.map((def) => {
                const st = nodeStates[def.id] || { status: 'idle' as NodeStatus, steps: [] }
                const style = STATUS_STYLES[st.status]
                const Icon = def.icon
                const pos = POS[def.id]
                return (
                  <button
                    key={def.id}
                    data-node
                    onClick={() => setInspected((cur) => (cur === def.id ? null : def.id))}
                    className={cn(
                      'absolute text-left rounded-xl border bg-white shadow-sm hover:shadow-md transition-all',
                      style.ring,
                      st.status === 'skipped' && 'opacity-75',
                      inspected === def.id && 'ring-2 ring-[#315CEA]/30',
                      def.kind === 'trigger' && 'rounded-[14px] border-2'
                    )}
                    style={{ left: pos.x, top: pos.y + 126, width: NODE_W, height: NODE_H }}
                    aria-label={`${def.label} — ${style.label}`}
                  >
                    {/* ports */}
                    {def.id !== 'trigger' && (
                      <span className="absolute -left-[5px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white border-2 border-[#c9ced8]" />
                    )}
                    {def.id !== 'youtube' && def.id !== 'tiktok' && def.id !== 'instagram' && (
                      <span className="absolute -right-[5px] top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white border-2 border-[#c9ced8]" />
                    )}
                    <span className="flex items-center gap-2.5 px-3 h-full">
                      <span className={cn('w-9 h-9 rounded-lg flex items-center justify-center shrink-0', def.color)}>
                        <Icon size={17} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12.5px] font-semibold text-[#1a1c20] leading-tight truncate">{def.label}</span>
                        <span className="block text-[10.5px] text-[#9aa0ab] leading-tight truncate">{def.sub}</span>
                      </span>
                      <span className="shrink-0 flex flex-col items-center gap-1">
                        <span className={cn('w-2.5 h-2.5 rounded-full', style.dot)} />
                        {st.status === 'running' && (
                          <span className="text-[8.5px] font-semibold text-[#315CEA] uppercase">live</span>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            {/* zoom controls */}
            <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-xl border border-[#E5E7EB] bg-white/95 backdrop-blur p-1 shadow-sm">
              <button onClick={() => setZoom((z) => Math.max(0.25, z * 0.85))} aria-label="Zoom out"
                className="p-2 rounded-lg text-[#6b7280] hover:bg-[#F0F4FF] hover:text-[#315CEA] transition-colors"><ZoomOut size={15} /></button>
              <span className="text-[11px] font-medium text-[#9aa0ab] w-10 text-center">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(1.4, z * 1.15))} aria-label="Zoom in"
                className="p-2 rounded-lg text-[#6b7280] hover:bg-[#F0F4FF] hover:text-[#315CEA] transition-colors"><ZoomIn size={15} /></button>
              <button onClick={fit} aria-label="Fit canvas"
                className="p-2 rounded-lg text-[#6b7280] hover:bg-[#F0F4FF] hover:text-[#315CEA] transition-colors"><Maximize2 size={15} /></button>
            </div>

            {/* node inspector */}
            {inspectedNode && inspectedState && (
              <div className="absolute top-3 right-3 w-64 rounded-xl border border-[#E5E7EB] bg-white/97 backdrop-blur shadow-lg p-3.5 text-left">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', inspectedNode.color)}>
                      <inspectedNode.icon size={14} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-semibold text-[#1a1c20] truncate">{inspectedNode.label}</p>
                      <p className="text-[10px] text-[#9aa0ab] truncate">{inspectedNode.sub}</p>
                    </div>
                  </div>
                  <Badge tone={inspectedState.status === 'success' ? 'green' : inspectedState.status === 'failed' ? 'red' : inspectedState.status === 'running' ? 'blue' : inspectedState.status === 'skipped' ? 'gray' : 'amber'}>
                    {STATUS_STYLES[inspectedState.status].label}
                  </Badge>
                </div>
                {inspectedNode.kind === 'trigger' ? (
                  <div className="mt-3 space-y-1.5 text-[11.5px] text-[#6b7280]">
                    <p className="flex justify-between"><span>schedule</span><span className="font-medium text-[#1a1c20]">hourly</span></p>
                    <p className="flex justify-between"><span>cron</span><span className="font-mono text-[#1a1c20]">0 * * * *</span></p>
                    <p className="flex justify-between"><span>next</span><span className="font-medium text-[#1a1c20]">{nextRunLabel()}</span></p>
                  </div>
                ) : inspectedState.steps.length ? (
                  <div className="mt-3 space-y-2">
                    {inspectedState.steps.map((s) => (
                      <div key={s.name} className="rounded-lg bg-[#F9FAFB] border border-[#F0F2F5] px-2.5 py-2">
                        <p className="text-[10.5px] font-medium text-[#3c4658] leading-snug">{s.name}</p>
                        <p className="text-[10px] text-[#9aa0ab] mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className={cn('w-1.5 h-1.5 rounded-full inline-block', STATUS_STYLES[stepToStatus(s)].dot)} />
                          {STATUS_STYLES[stepToStatus(s)].label}
                          {s.started_at && <span>· {fmtDur(s.started_at, s.completed_at)}</span>
                          }
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-[11.5px] text-[#9aa0ab] leading-relaxed">
                    {run ? 'This step has not run in the selected execution.' : 'No execution selected — run the workflow to see live states.'}
                  </p>
                )}
                {inspectedState.note && <p className="mt-2 text-[10.5px] text-[#b45309]">{inspectedState.note}</p>}
              </div>
            )}

            {!run && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <p className="rounded-xl bg-white/90 border border-[#E5E7EB] px-4 py-2.5 text-[12.5px] text-[#9aa0ab]">
                  Deploy the pipeline files, then hit <span className="font-medium text-[#315CEA]">Run now</span> to see the canvas light up.
                </p>
              </div>
            )}
          </div>

          {/* executions */}
          <section aria-label="Executions">
            <div className="flex items-center justify-between mb-2.5">
              <h2 className="text-[13.5px] font-semibold text-[#1a1c20] flex items-center gap-1.5">
                <Radio size={13} className={cn(isActive ? 'text-[#315CEA] animate-pulse' : 'text-[#9aa0ab]')} /> Executions
              </h2>
              <p className="text-[11px] text-[#b3b8c2]">click a run to replay its state on the canvas</p>
            </div>
            {data?.runs?.length ? (
              <div className="flex gap-2 overflow-x-auto pb-2 sp-scroll">
                {data.runs.map((r) => {
                  const sel = (selectedRunId ?? data.selectedRunId) === r.id
                  const active = r.status !== 'completed'
                  return (
                    <button key={r.id}
                      onClick={() => { setSelectedRunId(r.id); setInspected(null) }}
                      className={cn(
                        'shrink-0 rounded-xl border px-3.5 py-2.5 text-left transition-all min-w-[190px]',
                        sel ? 'border-[#315CEA] bg-[#F0F4FF] shadow-[0_0_0_3px_rgba(49,92,234,0.08)]' : 'border-[#E5E7EB] bg-white hover:border-[#315CEA]/50'
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {active ? (
                          <Badge tone="amber"><Loader2 size={9} className="animate-spin" /> {r.status}</Badge>
                        ) : r.conclusion === 'success' ? (
                          <Badge tone="green">success</Badge>
                        ) : (
                          <Badge tone="red">{r.conclusion || 'unknown'}</Badge>
                        )}
                        <span className="text-[10.5px] text-[#9aa0ab]">#{r.id}</span>
                        {artByRun.get(r.id) && <Badge tone="gray"><Film size={9} /> mp4</Badge>}
                      </span>
                      <span className="block mt-1 text-[11.5px] text-[#4a4f58] truncate max-w-[170px]" title={r.display_title}>
                        {r.event === 'schedule' ? ' hourly cron' : ` ${r.event}`}
                        <ChevronRight size={9} className="inline mx-0.5" />{new Date(r.created_at).toLocaleString()}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-[#E5E7EB] p-6 text-center text-sm text-[#9aa0ab]">
                No executions yet.
              </div>
            )}
          </section>

          {/* artifacts */}
          {data?.artifacts?.length ? (
            <section aria-label="Artifacts">
              <h2 className="text-[13.5px] font-semibold text-[#1a1c20] mb-2.5">Rendered videos (artifacts)</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {data.artifacts.slice(0, 6).map((a) => (
                  <div key={a.id} className="rounded-xl border border-[#E5E7EB] p-3.5 flex items-center gap-3">
                    <span className="w-9 h-9 rounded-lg bg-[#E9F9F0] text-[#0e9f6e] flex items-center justify-center shrink-0"><Film size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium text-[#1a1c20] truncate">{a.name}</p>
                      <p className="text-[11px] text-[#9aa0ab]">{fmtBytes(a.size_in_bytes)} · {new Date(a.created_at).toLocaleDateString()}</p>
                    </div>
                    {a.workflow_run && <Badge tone="green">run #{a.workflow_run.id}</Badge>}
                  </div>
                ))}
              </div>
              <p className="text-[11.5px] text-[#b3b8c2] mt-2.5">
                Every finished run stores output.mp4 + meta.json — they also appear, watchable, in the <button onClick={() => setView('library')} className="text-[#315CEA] font-medium hover:underline">Library</button>.
              </p>
            </section>
          ) : null}
        </div>
      )}
    </ViewShell>
  )
}
