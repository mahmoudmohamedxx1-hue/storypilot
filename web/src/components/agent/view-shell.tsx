'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

export function ViewShell({
  title, subtitle, actions, children,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 flex flex-col h-full bg-white min-w-0">
      <header className="shrink-0 border-b border-[#EBEDF0] bg-white/90 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 pl-14 md:pl-6 min-h-16 py-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold text-[#1a1c20] truncate">{title}</h1>
            {subtitle && <p className="text-[12.5px] text-[#8a8f99] truncate mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto sp-scroll">
        <div className="max-w-5xl mx-auto px-6 py-7">{children}</div>
      </div>
    </div>
  )
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1600)
      }}
      className={cn(
        'inline-flex items-center gap-1.5 text-[12px] font-medium text-[#6b7280] hover:text-[#315CEA] bg-white border border-[#E5E7EB] hover:border-[#315CEA]/50 rounded-lg px-2.5 py-1.5 transition-colors',
        className
      )}
    >
      {done ? <Check size={13} className="text-[#0e9f6e]" /> : <Copy size={13} />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

export function CodeBlock({ code, maxH = 'max-h-[420px]' }: { code: string; maxH?: string }) {
  return (
    <div className="relative rounded-xl border border-[#EBEDF0] bg-[#F9FAFB] overflow-hidden">
      <div className="absolute right-2.5 top-2.5 z-10">
        <CopyButton text={code} />
      </div>
      <pre className={cn('overflow-auto sp-scroll p-4 text-[12.5px] leading-[1.65] font-mono text-[#38404d] whitespace-pre', maxH)}>
        {code}
      </pre>
    </div>
  )
}

export function StatusDot({ ok, pending }: { ok: boolean; pending?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block w-2 h-2 rounded-full shrink-0',
        pending ? 'bg-[#f5a623] animate-pulse' : ok ? 'bg-[#0e9f6e]' : 'bg-[#d13438]'
      )}
    />
  )
}

export function Badge({ tone, children }: { tone: 'blue' | 'green' | 'gray' | 'red' | 'amber'; children: React.ReactNode }) {
  const tones = {
    blue: 'bg-[#F0F4FF] text-[#315CEA] border-[#D9E4FF]',
    green: 'bg-[#E9F9F0] text-[#0e9f6e] border-[#C9EFDD]',
    gray: 'bg-[#F5F7FA] text-[#6b7280] border-[#E5E7EB]',
    red: 'bg-[#FDECEC] text-[#d13438] border-[#F8D4D4]',
    amber: 'bg-[#FFF6E5] text-[#b45309] border-[#FBE5B6]',
  }
  return <span className={cn('inline-flex items-center gap-1 text-[11.5px] font-medium rounded-full border px-2 py-0.5', tones[tone])}>{children}</span>
}
