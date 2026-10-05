'use client'

import { useCallback, useEffect, useState } from 'react'
import { ViewShell, Badge, CodeBlock, CopyButton } from '@/components/agent/view-shell'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import {
  RefreshCw, Loader2, BookOpenText, Clock, Film, Volume2,
  Sparkles, FileCode2, Languages, PlayCircle,
} from 'lucide-react'

interface Scene {
  index: number
  timeRange: string
  visual: string
  aiPrompt: string
  voiceover: string
  sfx: string
}

interface Story {
  title: string
  logline: string
  genre: string
  duration: string
  scenes: Scene[]
  narration: string
  language: string
  totalWords: number
}

interface StoriesData {
  ok: boolean
  stories: Story[]
  pythonCode: string
  codeMeta: Record<string, string>
  fetchedAt: string
  error?: string
}

export function StoriesView() {
  const [data, setData] = useState<StoriesData | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/stories')
      setData(await res.json())
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const story = data?.stories?.[0]

  return (
    <ViewShell
      title="Stories"
      subtitle="The Google Sheet Gemini Spark updates hourly + the generator code tab"
      actions={
        <>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
          <a href={`https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit`} target="_blank" rel="noreferrer">
            <Button variant="outline" size="sm" className="gap-1.5">Open Sheet</Button>
          </a>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-24 text-[#9aa0ab] gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Fetching the sheet…
        </div>
      ) : !data?.ok || !story ? (
        <div className="rounded-2xl border border-[#E5E7EB] p-10 text-center">
          <BookOpenText size={34} className="mx-auto text-[#9aa0ab]" />
          <h3 className="mt-4 font-semibold text-[#1a1c20]">Couldn&apos;t read the sheet</h3>
          <p className="mt-1.5 text-sm text-[#6b7280] max-w-md mx-auto leading-relaxed">
            {data?.error || 'Make sure the Google Sheet is shared with "Anyone with the link".'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* story header */}
          <div className="rounded-2xl border border-[#E5E7EB] bg-gradient-to-br from-[#F7F9FF] to-white p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="blue"><Sparkles size={10} /> {story.genre || 'Story'}</Badge>
              <Badge tone="gray"><Clock size={10} /> {story.duration}</Badge>
              <Badge tone="gray"><Languages size={10} /> {story.language === 'ar' ? 'العربية' : 'English'}</Badge>
              <Badge tone="gray">{story.scenes.length} scenes</Badge>
              <Badge tone="gray">{story.totalWords} words</Badge>
            </div>
            <h2 className="mt-3.5 text-[22px] font-semibold text-[#1a1c20] tracking-tight">{story.title}</h2>
            <p className="mt-2 text-[14.5px] text-[#6b7280] leading-relaxed max-w-2xl">{story.logline}</p>
            {story.narration && (
              <div className="mt-4 rounded-xl bg-white border border-[#EBEDF0] p-4">
                <p className="text-[11px] font-semibold text-[#9aa0ab] uppercase tracking-wide mb-1.5 flex items-center gap-1.5"><Volume2 size={11} /> Full narration (voiceover source)</p>
                <p className="text-[13.5px] leading-relaxed text-[#3c4658]" dir="auto">{story.narration}</p>
              </div>
            )}
          </div>

          {/* scenes */}
          <section>
            <h2 className="text-[14px] font-semibold text-[#1a1c20] mb-3">Scene board</h2>
            <div className="space-y-3">
              {story.scenes.map((s) => (
                <div key={s.index} className="rounded-2xl border border-[#E5E7EB] p-5 hover:border-[#315CEA]/40 transition-colors">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="w-9 h-9 rounded-xl bg-[#315CEA] text-white text-[13px] font-bold flex items-center justify-center shrink-0">
                      {String(s.index).padStart(2, '0')}
                    </span>
                    <span className="text-[12.5px] font-medium text-[#6b7280] flex items-center gap-1.5">
                      <PlayCircle size={13} /> {s.timeRange}
                    </span>
                    {s.sfx && <Badge tone="gray">♪ {s.sfx.slice(0, 40)}</Badge>}
                  </div>
                  <p className="mt-3 text-[14.5px] text-[#202124] leading-relaxed" dir="auto">{s.visual}</p>
                  <div className="mt-3 rounded-xl bg-[#F9FAFB] border border-[#F0F2F5] px-4 py-3">
                    <p className="text-[11px] font-semibold text-[#9aa0ab] uppercase tracking-wide mb-1">Voiceover</p>
                    <p className="text-[13.5px] leading-relaxed text-[#3c4658]" dir="auto">{s.voiceover}</p>
                  </div>
                  {s.aiPrompt && (
                    <p className="mt-2.5 text-[12px] text-[#9aa0ab] leading-relaxed font-mono">AI prompt: {s.aiPrompt}</p>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* python code */}
          {data.pythonCode ? (
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[14px] font-semibold text-[#1a1c20] flex items-center gap-2">
                  <FileCode2 size={15} className="text-[#315CEA]" /> Sheet generator code — «كود بايثون - المولد الآلي»
                </h2>
                <CopyButton text={data.pythonCode} />
              </div>
              <p className="text-[12.5px] text-[#8a8f99] mb-2.5 leading-relaxed">
                This is the original Python from the sheet (edge-tts + moviepy + pillow + arabic-reshaper + python-bidi).
                The deployed pipeline evolves it into <span className="font-medium text-[#315CEA]">generate_video.py</span> which renders any story.json automatically.
              </p>
              <CodeBlock code={data.pythonCode} maxH="max-h-[380px]" />
            </section>
          ) : null}

          <p className="text-[11.5px] text-[#b3b8c2] flex items-center gap-1.5">
            <Film size={12} /> Fetched {new Date(data.fetchedAt).toLocaleString()}
          </p>
        </div>
      )}
    </ViewShell>
  )
}
