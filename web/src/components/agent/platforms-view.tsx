'use client'

import { useCallback, useEffect, useState } from 'react'
import { ViewShell, Badge, StatusDot } from '@/components/agent/view-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { Youtube, Instagram, Music2, Loader2, KeyRound, ShieldCheck, ExternalLink, HardDrive } from 'lucide-react'

type PlatformKey = 'youtubeToken' | 'tiktokToken' | 'instagramToken' | 'driveWebappUrl'

interface Platform {
  key: PlatformKey
  extra?: Array<{ env: string; label: string }>
  name: string
  icon: React.ElementType
  color: string
  bg: string
  desc: string
  hint: string
  link: string
  linkLabel: string
}

const PLATFORMS: Platform[] = [
  {
    key: 'youtubeToken',
    extra: [{ env: 'YOUTUBE_CLIENT_ID', label: 'Client ID' }, { env: 'YOUTUBE_CLIENT_SECRET', label: 'Client secret' }],
    name: 'YouTube Shorts',
    icon: Youtube,
    color: '#d13438',
    bg: '#FDECEC',
    desc: 'Uploads the hourly MP4 via the YouTube Data API (resumable upload).',
    hint: 'Create an OAuth client in Google Cloud Console with the youtube.upload scope, then exchange the code for a refresh token.',
    link: 'https://console.cloud.google.com/apis/credentials',
    linkLabel: 'Google Cloud credentials',
  },
  {
    key: 'tiktokToken',
    name: 'TikTok',
    icon: Music2,
    color: '#202124',
    bg: '#F0F0F2',
    desc: 'Posts the video with the Content Posting API (chunked FILE_UPLOAD).',
    hint: 'Register an app at TikTok for Developers, request Content Posting API access, and generate a user access token. Unapproved apps post as SELF_ONLY by default.',
    link: 'https://developers.tiktok.com/',
    linkLabel: 'TikTok for Developers',
  },
  {
    key: 'instagramToken',
    extra: [{ env: 'INSTAGRAM_USER_ID', label: 'IG user id' }],
    name: 'Instagram Reels',
    icon: Instagram,
    color: '#c1358f',
    bg: '#FBE9F5',
    desc: 'Publishes a Reel via the Instagram Graph API container flow.',
    hint: 'You need an Instagram Business/Creator account linked to a Facebook Page, plus a long-lived token with instagram_content_publish.',
    link: 'https://developers.facebook.com/docs/instagram-api/getting-started',
    linkLabel: 'Instagram Graph API docs',
  },
  {
    key: 'driveWebappUrl',
    extra: [{ env: 'DRIVE_WEBAPP_KEY', label: 'Web app key (optional)' }],
    name: 'Google Drive',
    icon: HardDrive,
    color: '#1a73e8',
    bg: '#E8F0FE',
    desc: 'Syncs every finished video to your Drive folder hourly (deduped) — a permanent backup next to the Spark sheet.',
    hint: 'One-time, 3 minutes: script.google.com → New project → paste the code from scripts/drive_webapp.js in the repo (or STORYPILOT.md) → Deploy as Web app (Execute as: Me, Access: Anyone) → copy the /exec URL here. No OAuth keys needed.',
    link: 'https://script.google.com',
    linkLabel: 'Open Apps Script',
  },
]

export function PlatformsView() {
  const [settings, setSettings] = useState<Record<string, string>>({})
  const [form, setForm] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/settings')
      const j = await res.json()
      setSettings(j.settings || {})
      setForm({
        youtubeToken: '', tiktokToken: '', instagramToken: '', driveWebappUrl: '',
        YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '', INSTAGRAM_USER_ID: '', DRIVE_WEBAPP_KEY: '',
      })
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const has = (k: string) => !!settings[`has${k.charAt(0).toUpperCase() + k.slice(1)}`]

  const saveAll = async () => {
    setSaving(true)
    try {
      const payload: Record<string, string> = {}
      for (const [k, v] of Object.entries(form)) if (v.trim()) payload[k] = v.trim()
      if (Object.keys(payload).length) {
        // token fields map to their canonical setting keys
        const mapped: Record<string, string> = {}
        for (const [k, v] of Object.entries(payload)) {
          if (k === 'YOUTUBE_CLIENT_ID' || k === 'YOUTUBE_CLIENT_SECRET' || k === 'INSTAGRAM_USER_ID') continue
          mapped[k] = v
        }
        if (Object.keys(mapped).length) {
          const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mapped),
          })
          const j = await res.json()
          if (j.settings) setSettings(j.settings)
        }
        // the Drive web app key is stored in the app too (masked) so the
        // built-in health check can ping the web app with it
        if (payload.DRIVE_WEBAPP_KEY) {
          const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driveWebappKey: payload.DRIVE_WEBAPP_KEY }),
          })
          const j = await res.json()
          if (j.settings) setSettings(j.settings)
        }
        toast.success('Saved in the app')
        await pushSecrets(payload)
      } else {
        toast.info('Nothing to save — paste a token first')
      }
    } finally {
      setSaving(false)
    }
  }

  const pushSecrets = async (payload: Record<string, string>) => {
    setBusy('secrets')
    try {
      const res = await fetch('/api/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'secrets', secrets: payload }),
      })
      const j = await res.json()
      if (j.ok) {
        const { pushed, failed } = j.result
        if (pushed.length) toast.success(`Pushed to GitHub secrets: ${pushed.join(', ')}`)
        if (failed.length) toast.warning(`Failed: ${failed.join(', ')}`)
        if (!pushed.length && !failed.length) toast.info('No new secrets to push')
      } else toast.error(j.error || 'Secrets push failed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <ViewShell
      title="Platforms"
      subtitle="Connect YouTube, TikTok, Instagram and Google Drive — secrets are encrypted (libsodium) before hitting GitHub"
      actions={
        <Button size="sm" onClick={saveAll} disabled={saving || busy === 'secrets'} className="gap-1.5 bg-[#315CEA] hover:bg-[#2a50d4]">
          {saving || busy === 'secrets' ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
          Save &amp; push secrets
        </Button>
      }
    >
      <div className="grid lg:grid-cols-4 gap-4">
        {PLATFORMS.map((p) => {
          const connected = has(p.key)
          return (
            <div key={p.key} className={`rounded-2xl border p-5 flex flex-col ${connected ? 'border-[#C9EFDD] bg-[#FBFFFD]' : 'border-[#E5E7EB] bg-white'}`}>
              <div className="flex items-center justify-between">
                <span className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: p.bg, color: p.color }}>
                  <p.icon size={21} />
                </span>
                {connected ? <Badge tone="green"><StatusDot ok /> connected</Badge> : <Badge tone="gray">not configured</Badge>}
              </div>
              <h3 className="mt-3.5 font-semibold text-[15px] text-[#1a1c20]">{p.name}</h3>
              <p className="mt-1 text-[13px] text-[#6b7280] leading-relaxed">{p.desc}</p>

              <div className="mt-4 space-y-2.5">
                <Field
                  label="Access token / refresh token"
                  placeholder={connected ? '•••• stored — paste to replace' : 'paste token'}
                  value={form[p.key] || ''}
                  onChange={(v) => setForm((f) => ({ ...f, [p.key]: v }))}
                />
                {p.extra?.map((x) => (
                  <Field
                    key={x.env}
                    label={x.label}
                    placeholder={x.env}
                    value={form[x.env] || ''}
                    onChange={(v) => setForm((f) => ({ ...f, [x.env]: v }))}
                  />
                ))}
              </div>

              <div className="mt-auto pt-4">
                <p className="text-[11.5px] text-[#9aa0ab] leading-relaxed">{p.hint}</p>
                <a href={p.link} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-[#315CEA] hover:underline">
                  {p.linkLabel} <ExternalLink size={11} />
                </a>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-6 rounded-2xl border border-[#E5E7EB] bg-[#F9FAFB] p-5">
        <h3 className="text-[13.5px] font-semibold text-[#1a1c20] flex items-center gap-2"><KeyRound size={14} className="text-[#315CEA]" /> How posting works</h3>
        <ol className="mt-2.5 space-y-1.5 text-[13px] text-[#6b7280] leading-relaxed list-decimal pl-5">
          <li>Paste tokens above and hit <span className="font-medium">Save &amp; push secrets</span> — they are stored in the app and encrypted into your repo&apos;s GitHub Actions secrets.</li>
          <li>Each factory run renders <span className="font-mono text-[12px]">videos/*/output.mp4</span> continuously, posts to every connected platform, and syncs everything new to Google Drive hourly (deduped in <span className="font-mono text-[12px]">state/drive_sync.json</span>).</li>
          <li>Missing platforms are skipped gracefully — the pipeline never fails because one network is unset.</li>
        </ol>
      </div>
    </ViewShell>
  )
}

function Field({ label, placeholder, value, onChange }: {
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-[#8a8f99] uppercase tracking-wide">{label}</span>
      <Input
        type="password"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-9 text-[13px] bg-white"
      />
    </label>
  )
}
