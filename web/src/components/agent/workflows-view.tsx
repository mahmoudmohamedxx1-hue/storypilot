'use client'

import { useCallback, useEffect, useState } from 'react'
import { ViewShell, CodeBlock, Badge, CopyButton } from '@/components/agent/view-shell'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Download, Rocket, Loader2, FileCode2, FileText, Workflow as WorkflowIcon, CheckCircle2 } from 'lucide-react'

interface BundleFile {
  path: string
  content: string
  language: string
  description: string
}

const ICONS: Record<string, React.ElementType> = {
  yaml: WorkflowIcon,
  python: FileCode2,
  text: FileText,
  markdown: FileText,
}

export function WorkflowsView() {
  const [files, setFiles] = useState<BundleFile[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [deploying, setDeploying] = useState(false)
  const [deployed, setDeployed] = useState<string[] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/workflow/files')
      const j = await res.json()
      setFiles(j.files || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const deploy = async () => {
    setDeploying(true)
    try {
      const res = await fetch('/api/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deploy' }),
      })
      const j = await res.json()
      if (j.ok) {
        setDeployed(j.result.pushed.length ? j.result.pushed : j.result.skipped)
        toast.success('Pipeline deployed', {
          description: `${j.result.pushed.length} files pushed, ${j.result.skipped.length} unchanged. The hourly cron is live.`,
        })
      } else toast.error(j.error || 'Deploy failed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  const file = files[active]

  return (
    <ViewShell
      title="Workflows"
      subtitle="The hourly GitHub Actions bundle — generated live from your settings"
      actions={
        <>
          <a href="/api/workflow/download" download="storypilot-pipeline.zip">
            <Button variant="outline" size="sm" className="gap-1.5">
              <Download size={13} /> Download .zip
            </Button>
          </a>
          <Button size="sm" onClick={deploy} disabled={deploying} className="gap-1.5 bg-[#315CEA] hover:bg-[#2a50d4]">
            {deploying ? <Loader2 size={13} className="animate-spin" /> : <Rocket size={13} />} Deploy to repo
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-24 text-[#9aa0ab] gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Building bundle…
        </div>
      ) : (
        <div className="space-y-4">
          {deployed && (
            <div className="rounded-2xl border border-[#C9EFDD] bg-[#F6FEFA] p-4 flex items-start gap-3">
              <CheckCircle2 size={18} className="text-[#0e9f6e] mt-0.5 shrink-0" />
              <div className="text-[13px] text-[#0b6b4a] leading-relaxed">
                <span className="font-semibold">Deployed to GitHub.</span> Files: {deployed.join(', ')}. The workflow runs
                hourly (<span className="font-mono text-[12px]">cron 0 * * * *</span>) — watch runs in the Pipeline view.
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => {
              const Icon = ICONS[f.language] || FileText
              return (
                <button
                  key={f.path}
                  onClick={() => setActive(i)}
                  className={cn(
                    'flex items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px] font-medium transition-colors',
                    i === active
                      ? 'border-[#315CEA]/50 bg-[#F0F4FF] text-[#315CEA]'
                      : 'border-[#E5E7EB] text-[#6b7280] hover:border-[#c9d4f5] hover:text-[#315CEA]'
                  )}
                >
                  <Icon size={13} />
                  <span className="font-mono">{f.path}</span>
                </button>
              )
            })}
          </div>

          {file && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                <p className="text-[13px] text-[#6b7280]">{file.description}</p>
                <div className="flex items-center gap-2">
                  <Badge tone="blue">{file.language}</Badge>
                  <CopyButton text={file.content} />
                </div>
              </div>
              <CodeBlock code={file.content} maxH="max-h-[560px]" />
            </div>
          )}

          <div className="rounded-2xl border border-[#E5E7EB] bg-[#F9FAFB] p-5">
            <h3 className="text-[13.5px] font-semibold text-[#1a1c20]">What the pipeline does, every hour</h3>
            <ol className="mt-2.5 space-y-1.5 text-[13px] text-[#6b7280] leading-relaxed list-decimal pl-5">
              <li>Pulls the latest story from the Gemini Spark Google Sheet (falls back to keyless GLM-5.3-Flash via freellmpool).</li>
              <li>Generates Arabic/English voiceover free with Edge-TTS (ar-EG-ShakirNeural default).</li>
              <li>Renders a 1080×1920 vertical MP4 — 24fps, H.264 + AAC (MoviePy + Pillow + arabic-reshaper + python-bidi).</li>
              <li>Uploads the MP4 as the <span className="font-mono text-[12px]">hourly-video</span> artifact (14-day retention).</li>
              <li>Posts to every connected platform: YouTube → TikTok → Instagram Reels.</li>
            </ol>
          </div>
        </div>
      )}
    </ViewShell>
  )
}
