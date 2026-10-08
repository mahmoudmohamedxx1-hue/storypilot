'use client'

import { useCallback, useEffect, useState } from 'react'
import { ViewShell, Badge } from '@/components/agent/view-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { Loader2, Save, Sparkles, Sheet, Github, Volume2, ShieldAlert, CalendarClock } from 'lucide-react'
import { formatScheduleHours, nextSlot } from '@/lib/schedule'

const MODELS = [
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', note: 'default · fastest, via z.ai SDK' },
  { id: 'glm-4.6', label: 'GLM-4.6', note: 'stronger reasoning via z.ai SDK' },
]

const FLP_MODELS = [
  { id: 'auto', label: 'Auto pool', note: 'default · keyless, freellmpool picks a live free model (writes the hyperframe code)' },
  { id: 'ovh/gpt-oss-120b', label: 'gpt-oss-120b', note: 'keyless · big open-weight coder via OVHcloud' },
  { id: 'ovh/Qwen3-Coder-30B-A3B-Instruct', label: 'Qwen3-Coder-30B', note: 'keyless · dedicated code model' },
  { id: 'glm-4.7-flash', label: 'GLM-4.7-Flash', note: 'GLM Flash tier · only live when the pool has a GLM route' },
]

const VOICES = [
  'ar-EG-ShakirNeural',
  'ar-EG-SalmaNeural',
  'en-US-ChristopherNeural',
  'en-US-JennyNeural',
]

export function SettingsView() {
  const [s, setS] = useState<Record<string, unknown> | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [autoPost, setAutoPost] = useState(true)
  const [saving, setSaving] = useState(false)
  const [repos, setRepos] = useState<Array<{ full_name: string }>>([])

  const load = useCallback(async () => {
    const res = await fetch('/api/settings')
    const j = await res.json()
    setS(j.settings)
    setAutoPost(!!j.settings.autoPost)
    try {
      const r = await fetch('/api/github?view=repos')
      const rj = await r.json()
      if (rj.ok) setRepos(rj.repos || [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      const payload: Record<string, string | boolean> = { ...form, autoPost }
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await res.json()
      if (j.settings) setS(j.settings)
      setForm({})
      toast.success('Settings saved')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!s) {
    return (
      <ViewShell title="Settings">
        <div className="flex items-center justify-center py-24 text-[#9aa0ab] gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> Loading settings…
        </div>
      </ViewShell>
    )
  }

  return (
    <ViewShell
      title="Settings"
      subtitle="Model, story source, GitHub connection and voice"
      actions={
        <Button size="sm" onClick={save} disabled={saving} className="gap-1.5 bg-[#315CEA] hover:bg-[#2a50d4]">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save changes
        </Button>
      }
    >
      <div className="space-y-5 max-w-2xl">
        {/* model */}
        <section className="rounded-2xl border border-[#E5E7EB] p-5">
          <h2 className="text-[14px] font-semibold text-[#1a1c20] flex items-center gap-2">
            <Sparkles size={15} className="text-[#315CEA]" /> AI model
          </h2>
          <div className="grid sm:grid-cols-2 gap-3 mt-3.5">
            {MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => setForm((f) => ({ ...f, chatModel: m.id }))}
                className={`text-left rounded-xl border p-3.5 transition-colors ${
                  (form.chatModel || s.chatModel) === m.id
                    ? 'border-[#315CEA]/60 bg-[#F0F4FF]'
                    : 'border-[#E5E7EB] hover:border-[#c9d4f5]'
                }`}
              >
                <p className="text-[13.5px] font-semibold text-[#1a1c20]">{m.label}</p>
                <p className="text-[12px] text-[#8a8f99] mt-0.5">{m.note}</p>
              </button>
            ))}
          </div>
          <div className="mt-5">
            <p className="text-[12.5px] font-semibold text-[#3c4658] mb-2.5">Keyless story model (hourly workflow · freellmpool)</p>
            <div className="grid sm:grid-cols-3 gap-3">
              {FLP_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setForm((f) => ({ ...f, flpModel: m.id }))}
                  className={`text-left rounded-xl border p-3.5 transition-colors ${
                    (form.flpModel || s.flpModel) === m.id
                      ? 'border-[#315CEA]/60 bg-[#F0F4FF]'
                      : 'border-[#E5E7EB] hover:border-[#c9d4f5]'
                  }`}
                >
                  <p className="text-[13px] font-semibold text-[#1a1c20]">{m.label}</p>
                  <p className="text-[11.5px] text-[#8a8f99] mt-0.5">{m.note}</p>
                </button>
              ))}
            </div>
          </div>
          <p className="mt-3 text-[12px] text-[#9aa0ab] leading-relaxed">
            Chat runs through the z.ai SDK (default <span className="font-mono">GLM-5.3-Flash</span>). The hourly
            workflow generates stories keyless via <a href="https://github.com/0xzr/freellmpool" target="_blank" rel="noreferrer" className="text-[#315CEA] hover:underline">freellmpool</a> —
            GLM Flash is tried first, then it auto-fails-over to a live keyless model, so the pipeline never stalls.
          </p>
        </section>

        {/* video schedule */}
        <section className="rounded-2xl border border-[#E5E7EB] p-5">
          <h2 className="text-[14px] font-semibold text-[#1a1c20] flex items-center gap-2">
            <CalendarClock size={15} className="text-[#315CEA]" /> Video schedule (Africa/Cairo)
          </h2>
          <label className="block mt-3">
            <span className="text-[11px] font-medium text-[#8a8f99] uppercase tracking-wide">Scheduled hours — comma-separated, 0-23</span>
            <Input
              value={form.scheduleHours ?? (s.scheduleHours as string) ?? '11,12,13,15,20'}
              onChange={(e) => setForm((f) => ({ ...f, scheduleHours: e.target.value }))}
              placeholder="11,12,13,15,20"
              className="mt-1 h-9 text-[13px] font-mono"
            />
          </label>
          <div className="mt-2.5 flex items-center gap-2 text-[12px] text-[#6b7280]">
            <span className="inline-flex items-center gap-1 rounded-full bg-[#F0F4FF] text-[#315CEA] px-2.5 py-1 font-medium">
              <CalendarClock size={11} /> {formatScheduleHours((form.scheduleHours ?? (s.scheduleHours as string)) || '11,12,13,15,20')}
            </span>
            {(() => {
              const nx = nextSlot((form.scheduleHours ?? (s.scheduleHours as string)) || '11,12,13,15,20')
              return nx ? <span>next slot ≈ {String(nx.hour).padStart(2, '0')}:00 Cairo</span> : null
            })()}
          </div>
          <p className="mt-2 text-[12px] text-[#9aa0ab] leading-relaxed">
            Videos are made ONLY at these hours (your local time) — e.g. <span className="font-mono">11,12,13,15,20</span> = videos at
            11:00, 12:00, 13:00, 15:00 and 20:00. Between them nothing renders, and each slot makes up to 2 videos (repo variable
            <span className="font-mono"> MAX_VIDEOS_PER_SLOT</span>). Saving updates the app heartbeat immediately; hit <span className="font-medium">Deploy files</span> (Pipeline view) to push it to the repo as the
            <span className="font-mono"> SCHEDULE_HOURS</span> variable. Manual runs and "make a video now" always bypass the schedule.
          </p>
        </section>

        {/* story source */}
        <section className="rounded-2xl border border-[#E5E7EB] p-5">
          <h2 className="text-[14px] font-semibold text-[#1a1c20] flex items-center gap-2">
            <Sheet size={15} className="text-[#315CEA]" /> Story source (Google Sheet)
          </h2>
          <label className="block mt-3">
            <span className="text-[11px] font-medium text-[#8a8f99] uppercase tracking-wide">Sheet ID</span>
            <Input
              value={form.sheetId ?? (s.sheetId as string)}
              onChange={(e) => setForm((f) => ({ ...f, sheetId: e.target.value }))}
              className="mt-1 h-9 text-[13px] font-mono"
            />
          </label>
          <p className="mt-2 text-[12px] text-[#9aa0ab] leading-relaxed">
            The sheet Gemini Spark rewrites hourly. Tab 1 = the story, tab «كود بايثون - المولد الآلي» = the generator code.
            Must be shared as “Anyone with the link”.
          </p>
        </section>

        {/* github */}
        <section className="rounded-2xl border border-[#E5E7EB] p-5">
          <h2 className="text-[14px] font-semibold text-[#1a1c20] flex items-center gap-2">
            <Github size={15} className="text-[#315CEA]" /> GitHub connection
          </h2>
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="text-[11px] font-medium text-[#8a8f99] uppercase tracking-wide">
                Token {s.hasGithubToken ? <Badge tone="green">stored (env)</Badge> : <Badge tone="amber">missing</Badge>}
              </span>
              <Input
                type="password"
                placeholder={s.hasGithubToken ? `${s.githubToken} — paste to override` : 'ghp_…'}
                value={form.githubToken || ''}
                onChange={(e) => setForm((f) => ({ ...f, githubToken: e.target.value }))}
                className="mt-1 h-9 text-[13px] font-mono"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-medium text-[#8a8f99] uppercase tracking-wide">Pipeline repo</span>
              {repos.length ? (
                <select
                  value={form.githubRepo || (s.githubRepo as string)}
                  onChange={(e) => setForm((f) => ({ ...f, githubRepo: e.target.value }))}
                  className="mt-1 w-full h-9 rounded-md border border-input bg-white px-2.5 text-[13px] outline-none focus:ring-1 focus:ring-[#315CEA]"
                >
                  {repos.map((r) => (
                    <option key={r.full_name} value={r.full_name}>{r.full_name}</option>
                  ))}
                </select>
              ) : (
                <Input
                  value={form.githubRepo ?? (s.githubRepo as string)}
                  onChange={(e) => setForm((f) => ({ ...f, githubRepo: e.target.value }))}
                  className="mt-1 h-9 text-[13px] font-mono"
                />
              )}
            </label>
          </div>
          <div className="mt-3 rounded-xl bg-[#FFF7ED] border border-[#FFE4C7] px-3.5 py-2.5 flex gap-2.5">
            <ShieldAlert size={15} className="text-[#b45309] shrink-0 mt-0.5" />
            <p className="text-[12px] text-[#92400e] leading-relaxed">
              Tip: tokens you shared in chat should be revoked and regenerated — paste the new one here or in
              <span className="font-mono"> .env</span> (<span className="font-mono">GITHUB_TOKEN</span>). Needs <span className="font-medium">repo</span> + <span className="font-medium">workflow</span> scopes.
            </p>
          </div>
        </section>

        {/* voice + autopost */}
        <section className="rounded-2xl border border-[#E5E7EB] p-5">
          <h2 className="text-[14px] font-semibold text-[#1a1c20] flex items-center gap-2">
            <Volume2 size={15} className="text-[#315CEA]" /> Voiceover &amp; posting
          </h2>
          <label className="block mt-3">
            <span className="text-[11px] font-medium text-[#8a8f99] uppercase tracking-wide">Edge-TTS voice (Arabic)</span>
            <select
              value={form.voice || (s.voice as string)}
              onChange={(e) => setForm((f) => ({ ...f, voice: e.target.value }))}
              className="mt-1 w-full h-9 rounded-md border border-input bg-white px-2.5 text-[13px] outline-none focus:ring-1 focus:ring-[#315CEA]"
            >
              {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <div className="mt-4 flex items-center justify-between">
            <div>
              <p className="text-[13.5px] font-medium text-[#1a1c20]">Auto-post after render</p>
              <p className="text-[12px] text-[#8a8f99]">Post to all connected platforms after each scheduled slot</p>
            </div>
            <Switch checked={autoPost} onCheckedChange={setAutoPost} aria-label="Auto-post after render" />
          </div>
        </section>
      </div>
    </ViewShell>
  )
}
