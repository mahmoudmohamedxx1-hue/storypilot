'use client'

import { useEffect, useCallback, useState } from 'react'
import { useApp, View } from '@/components/agent/store'
import { Logo } from '@/components/agent/logo'
import { cn } from '@/lib/utils'
import {
  Plus, Search, MessageSquare,
  Activity, Library as LibraryIcon, BookOpenText, Share2, Workflow, Settings2,
  Github, ChevronLeft, ChevronRight, Trash2, RefreshCw,
} from 'lucide-react'

const NAV: Array<{ view: View; label: string; icon: React.ElementType }> = [
  { view: 'library', label: 'Library', icon: LibraryIcon },
  { view: 'pipeline', label: 'Pipeline', icon: Activity },
  { view: 'stories', label: 'Stories', icon: BookOpenText },
  { view: 'platforms', label: 'Platforms', icon: Share2 },
  { view: 'workflows', label: 'Workflows', icon: Workflow },
  { view: 'settings', label: 'Settings', icon: Settings2 },
]

interface SyncStateLite {
  lastSyncAt: string | null
  counts: { total: number; new: number; rendering: number; queued: number; done: number }
  tabs: Array<{ gid: string; name: string }>
}

/** Global always-sync heartbeat: re-syncs the sheet every 60s and bumps the app when new stories appear. */
function SyncIndicator({ collapsed }: { collapsed: boolean }) {
  const bumpSync = useApp((s) => s.bumpSync)
  const [state, setState] = useState<SyncStateLite | null>(null)
  const [syncing, setSyncing] = useState(false)

  const tick = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      const j = await res.json()
      if (j.state) setState(j.state as SyncStateLite)
      if (j.result?.storiesNew > 0) bumpSync()
    } catch { /* offline — retry next beat */ } finally {
      setSyncing(false)
    }
  }, [bumpSync])

  useEffect(() => {
    tick()
    const t = setInterval(tick, 60000)
    return () => clearInterval(t)
  }, [tick])

  const ago = state?.lastSyncAt
    ? Math.max(0, Math.round((Date.now() - new Date(state.lastSyncAt).getTime()) / 1000))
    : null
  const label = !state?.lastSyncAt
    ? 'syncing…'
    : syncing
      ? 'syncing sheet…'
      : ago === null ? 'never synced' : ago < 60 ? `synced ${ago}s ago` : `synced ${Math.floor(ago / 60)}m ago`

  if (collapsed) {
    return (
      <div className="flex justify-center py-1.5" title={`Always-sync · ${label}`}>
        <span className={cn('w-2 h-2 rounded-full', syncing ? 'bg-[#f5a623]' : 'bg-[#0e9f6e] heartbeat')} />
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-white border border-[#E5E7EB] px-3 py-2.5 text-[11px]">
      <div className="flex items-center gap-2 text-[#4a4f58]">
        <RefreshCw size={11} className={cn('text-[#0e9f6e]', syncing && 'animate-spin text-[#f5a623]')} />
        <span className="font-medium flex-1 truncate">Always-sync</span>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', syncing ? 'bg-[#f5a623]' : 'bg-[#0e9f6e] heartbeat')} />
      </div>
      <p className="mt-1 text-[#9aa0ab] truncate" title={label}>{label}</p>
      {state && (
        <p className="mt-0.5 text-[#9aa0ab]">
          {state.tabs.length} tabs · {state.counts.total} stories
          {state.counts.new > 0 && <span className="text-[#315CEA] font-medium"> · {state.counts.new} to make</span>}
          {(state.counts.rendering + state.counts.queued) > 0 && (
            <span className="text-[#b45309] font-medium"> · {state.counts.rendering + state.counts.queued} rendering</span>
          )}
        </p>
      )}
    </div>
  )
}

function timeGroup(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const days = (now.getTime() - d.getTime()) / 86400000
  if (days < 1) return 'Today'
  if (days < 2) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  return 'Older'
}

export function Sidebar({ collapsed, onToggle, onNavigate }: { collapsed: boolean; onToggle: () => void; onNavigate?: () => void }) {
  const { view, setView, chats, setChats, activeChatId, setActiveChat, bumpChats, chatsVersion } = useApp()

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch('/api/chat')
      const data = await res.json()
      if (data.chats) setChats(data.chats)
    } catch { /* offline */ }
  }, [setChats])

  useEffect(() => {
    loadChats()
  }, [loadChats, chatsVersion])

  const deleteChat = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await fetch(`/api/chat?chatId=${id}`, { method: 'DELETE' })
    if (activeChatId === id) setActiveChat(null)
    bumpChats()
  }

  const groups: Record<string, typeof chats> = {}
  for (const c of chats.slice(0, 24)) {
    const g = timeGroup(c.updatedAt)
    ;(groups[g] = groups[g] || []).push(c)
  }

  return (
    <aside
      className={cn(
        'h-full flex flex-col bg-[#F7F8FA] border-r border-[#EBEDF0] transition-all duration-200 shrink-0',
        collapsed ? 'w-[68px]' : 'w-[264px]'
      )}
      aria-label="Sidebar"
    >
      {/* brand + collapse */}
      <div className="flex items-center gap-2 px-3 h-14 shrink-0">
        <button
          onClick={() => { setView('chat'); setActiveChat(null); onNavigate?.() }}
          className="flex items-center gap-2.5 min-w-0 flex-1 rounded-lg py-1.5 hover:bg-[#EDEFF3] transition-colors"
          aria-label="StoryPilot home"
        >
          <Logo size={26} />
          {!collapsed && <span className="font-semibold text-[15px] text-[#1a1c20] truncate">StoryPilot</span>}
        </button>
        <button
          onClick={onToggle}
          className="p-1.5 rounded-md text-[#8a8f99] hover:bg-[#EDEFF3] hover:text-[#4a4f58] transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      {/* new chat + search */}
      <div className="px-3 space-y-2 shrink-0">
        <button
          onClick={() => { setView('chat'); setActiveChat(null); onNavigate?.() }}
          className={cn(
            'w-full flex items-center gap-2 rounded-xl bg-[#315CEA] text-white text-sm font-medium py-2.5 px-3.5',
            'hover:bg-[#2a50d4] active:scale-[0.99] transition-all shadow-[0_1px_2px_rgba(22,40,120,0.25)]',
            collapsed && 'justify-center px-0'
          )}
        >
          <Plus size={17} strokeWidth={2.5} />
          {!collapsed && 'New chat'}
        </button>
        {!collapsed && (
          <div className="flex items-center gap-2 rounded-xl bg-white border border-[#E5E7EB] px-3 py-2 text-sm text-[#9aa0ab]">
            <Search size={15} />
            <input
              placeholder="Search chats"
              className="bg-transparent outline-none w-full placeholder:text-[#b3b8c2] text-[#4a4f58]"
              aria-label="Search chats"
              onChange={(e) => {
                const q = e.target.value.toLowerCase()
                document.querySelectorAll('[data-chat-item]').forEach((el) => {
                  const t = (el as HTMLElement).dataset.title || ''
                  el.classList.toggle('hidden', q && !t.toLowerCase().includes(q))
                })
              }}
            />
          </div>
        )}
      </div>

      {/* chat history */}
      {!collapsed && (
        <nav className="flex-1 overflow-y-auto mt-3 px-2 pb-2 space-y-3 sp-scroll" aria-label="Chat history">
          {chats.length === 0 && (
            <p className="text-xs text-[#9aa0ab] px-3 pt-2">No conversations yet — say hi to your agent.</p>
          )}
          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <p className="text-[11px] font-medium text-[#9aa0ab] px-3 pb-1 uppercase tracking-wide">{group}</p>
              {items.map((c) => (
                <div
                  key={c.id}
                  data-chat-item
                  data-title={c.title}
                  onClick={() => { setActiveChat(c.id); setView('chat'); onNavigate?.() }}
                  className={cn(
                    'group flex items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition-colors',
                    activeChatId === c.id && view === 'chat'
                      ? 'bg-[#E4EAF9] text-[#1a2b6d]'
                      : 'text-[#4a4f58] hover:bg-[#EDEFF3]'
                  )}
                >
                  <MessageSquare size={15} className={cn('shrink-0', activeChatId === c.id ? 'text-[#315CEA]' : 'text-[#9aa0ab]')} />
                  <span className="truncate flex-1">{c.title}</span>
                  <button
                    onClick={(e) => deleteChat(e, c.id)}
                    className="opacity-0 group-hover:opacity-100 text-[#9aa0ab] hover:text-red-500 transition-all"
                    aria-label={`Delete chat ${c.title}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </nav>
      )}
      {collapsed && <div className="flex-1" />}

      {/* nav items */}
      <div className="px-2 pb-2 space-y-1.5 shrink-0 border-t border-[#EBEDF0] pt-2">
        <SyncIndicator collapsed={collapsed} />
        <div className="space-y-0.5">
          {NAV.map(({ view: v, label, icon: Icon }) => (
          <button
            key={v}
            onClick={() => { setView(v); onNavigate?.() }}
            title={label}
            className={cn(
              'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
              view === v ? 'bg-[#E4EAF9] text-[#1a2b6d] font-medium' : 'text-[#4a4f58] hover:bg-[#EDEFF3]',
              collapsed && 'justify-center px-0'
            )}
          >
            <Icon size={16} className={view === v ? 'text-[#315CEA]' : 'text-[#8a8f99]'} />
            {!collapsed && label}
          </button>
          ))}
        </div>
        <a
          href="https://github.com/0xzr/freellmpool"
          target="_blank"
          rel="noreferrer"
          title="freellmpool — keyless AI"
          className={cn(
            'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[#4a4f58] hover:bg-[#EDEFF3] transition-colors',
            collapsed && 'justify-center px-0'
          )}
        >
          <Github size={16} className="text-[#8a8f99]" />
          {!collapsed && <span className="flex-1 text-left">freellmpool</span>}
          {!collapsed && <span className="text-[10px] font-medium text-[#0e9f6e] bg-[#def7ec] rounded-full px-1.5 py-0.5">keyless</span>}
        </a>
      </div>
    </aside>
  )
}
