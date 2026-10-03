'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { useApp } from '@/components/agent/store'
import { Logo } from '@/components/agent/logo'
import { Markdown } from '@/components/agent/markdown'
import { cn } from '@/lib/utils'
import {
  ArrowUp, Square, Sparkles, BookOpenText, Rocket, Activity,
  Wrench, CheckCircle2, XCircle, Loader2, ChevronDown, RefreshCw,
} from 'lucide-react'

interface ToolEvent {
  name: string
  ok?: boolean
  summary?: string
  status: 'running' | 'done' | 'failed'
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  tools?: ToolEvent[]
}

const SUGGESTIONS = [
  { icon: BookOpenText, title: 'Fetch this hour\'s story', desc: 'Read the Gemini Spark sheet + generator code', prompt: 'Fetch the current story from the Google Sheet and give me a scene-by-scene breakdown.' },
  { icon: Rocket, title: 'Deploy the hourly pipeline', desc: 'Push the workflow to GitHub + go live', prompt: 'Deploy the hourly video pipeline to my GitHub repo and tell me what got set up.' },
  { icon: Activity, title: 'Pipeline status', desc: 'Latest runs, videos and platforms', prompt: 'Show me the pipeline status: recent workflow runs, video jobs and platform connections.' },
  { icon: Sparkles, title: 'Write a new story', desc: 'A fresh 60-second video script', prompt: 'Generate a new story about a lighthouse keeper who hears the sea counting ships, then show me the scenes.' },
]

export function ChatView() {
  const { activeChatId, setActiveChat, bumpChats, setChats, modelLabel } = useApp()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [liveTools, setLiveTools] = useState<ToolEvent[]>([])
  const [liveText, setText] = useState('')
  const [atBottom, setAtBottom] = useState(true)
  const [chatId, setChatId] = useState<string | null>(activeChatId)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setChatId(activeChatId) }, [activeChatId])

  const loadHistory = useCallback(async (id: string) => {
    setLoadingHistory(true)
    try {
      const res = await fetch(`/api/chat?chatId=${id}`)
      if (res.ok) {
        const { chat } = await res.json()
        setMessages(chat.messages.map((m: { id: string; role: string; content: string; tools?: string }) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          tools: m.tools ? (JSON.parse(m.tools) as ToolEvent[]) : undefined,
        })))
      }
    } finally {
      setLoadingHistory(false)
    }
  }, [])

  useEffect(() => {
    if (chatId) loadHistory(chatId)
    else setMessages([])
  }, [chatId, loadHistory])

  useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: messages.length > 0 ? 'smooth' : 'auto' })
  }, [messages, liveText, liveTools, atBottom])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 90)
  }

  const send = async (text?: string) => {
    const content = (text ?? input).trim()
    if (!content || streaming) return
    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'
    setAtBottom(true)
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', content }])
    setStreaming(true)
    setLiveTools([])
    setText('')
    const toolsAccum: ToolEvent[] = []

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: chatId, message: content }),
      })
      if (!res.ok || !res.body) throw new Error(`chat failed (${res.status})`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finalText = ''
      let appended = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          let evt: Record<string, unknown>
          try { evt = JSON.parse(line.slice(6)) } catch { continue }

          if (evt.type === 'chat') {
            const id = evt.chatId as string
            setChatId(id)
            setActiveChat(id)
            bumpChats()
          } else if (evt.type === 'tool_start') {
            // text streamed before a tool call is preamble — reset it
            finalText = ''
            setText('')
            toolsAccum.push({ name: evt.name as string, status: 'running' })
            setLiveTools([...toolsAccum])
          } else if (evt.type === 'tool_result') {
            const last = toolsAccum[toolsAccum.length - 1]
            if (last) {
              last.ok = evt.ok as boolean
              last.summary = evt.summary as string
              last.status = evt.ok ? 'done' : 'failed'
            }
            setLiveTools([...toolsAccum])
          } else if (evt.type === 'delta') {
            finalText += evt.text as string
            setText(finalText)
          } else if (evt.type === 'done') {
            setMessages((m) => [...m, {
              id: (evt.messageId as string) || `a-${Date.now()}`,
              role: 'assistant',
              content: finalText,
              tools: toolsAccum.length ? toolsAccum.map((t) => ({ ...t })) : undefined,
            }])
            appended = true
            setLiveTools([])
            setText('')
            bumpChats()
          } else if (evt.type === 'error') {
            setMessages((m) => [...m, { id: `e-${Date.now()}`, role: 'assistant', content: `⚠️ ${evt.error}` }])
            appended = true
            setLiveTools([])
            setText('')
          }
        }
      }
      // safety: stream ended without a done event
      if (!appended && (finalText || toolsAccum.length)) {
        setMessages((m) => [...m, { id: `a-${Date.now()}`, role: 'assistant', content: finalText, tools: toolsAccum.length ? toolsAccum : undefined }])
        setLiveTools([])
        setText('')
      }
      const list = await fetch('/api/chat').then((r) => r.json()).catch(() => null)
      if (list?.chats) setChats(list.chats)
    } catch (e) {
      setMessages((m) => [...m, { id: `e-${Date.now()}`, role: 'assistant', content: `⚠️ ${(e as Error).message}` }])
    } finally {
      setStreaming(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const empty = messages.length === 0 && !loadingHistory

  return (
    <div className="flex-1 flex flex-col h-full bg-white min-w-0">
      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto sp-scroll">
        {loadingHistory ? (
          <div className="h-full flex items-center justify-center text-[#9aa0ab] gap-2 text-sm">
            <Loader2 size={16} className="animate-spin" /> Loading conversation…
          </div>
        ) : empty ? (
          <div className="max-w-2xl mx-auto px-6 pt-[14vh] pb-8">
            <div className="flex flex-col items-center text-center">
              <Logo size={52} />
              <h1 className="mt-5 text-[30px] font-semibold tracking-tight text-[#1a1c20]">
                Hi, I&apos;m StoryPilot
              </h1>
              <p className="mt-3 text-[15px] text-[#6b7280] leading-relaxed max-w-md">
                Your hourly video agent. I read the stories Gemini Spark writes to your Sheet,
                turn them into vertical MP4s on GitHub Actions with keyless{' '}
                <span className="font-medium text-[#315CEA]">GLM-5.3-Flash</span>, and post them to
                YouTube, TikTok &amp; Instagram.
              </p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 mt-9">
              {SUGGESTIONS.map(({ icon: Icon, title, desc, prompt }) => (
                <button
                  key={title}
                  onClick={() => send(prompt)}
                  className="group text-left rounded-2xl border border-[#E5E7EB] bg-white p-4 hover:border-[#315CEA]/50 hover:shadow-[0_4px_16px_rgba(49,92,234,0.08)] hover:-translate-y-0.5 transition-all"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-xl bg-[#F0F4FF] flex items-center justify-center text-[#315CEA]">
                      <Icon size={17} />
                    </span>
                    <span className="font-medium text-[14.5px] text-[#1a1c20]">{title}</span>
                  </div>
                  <p className="mt-2 text-[13px] text-[#8a8f99] leading-relaxed">{desc}</p>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-5 py-8 space-y-7">
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
                {m.role === 'user' ? (
                  <div className="max-w-[78%] rounded-2xl rounded-br-md bg-[#EBF1FF] px-4 py-2.5 text-[15.5px] leading-[1.7] text-[#1f2b53] whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {m.tools?.map((t, i) => <ToolCard key={i} tool={t} />)}
                    <Markdown text={m.content} />
                  </div>
                )}
              </div>
            ))}
            {/* live streaming block */}
            {streaming && (
              <div className="space-y-3">
                {liveTools.map((t, i) => <ToolCard key={i} tool={t} live />)}
                {liveText && <Markdown text={liveText} />}
                {!liveText && !liveTools.length && (
                  <div className="flex items-center gap-1.5 text-[#9aa0ab]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#315CEA] animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#315CEA] animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 rounded-full bg-[#315CEA] animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                )}
              </div>
            )}
            <div ref={bottomRef} className="h-1" />
          </div>
        )}
      </div>

      {/* scroll-to-bottom */}
      {!atBottom && !empty && (
        <div className="relative">
          <button
            onClick={() => { setAtBottom(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }}
            className="absolute -top-12 left-1/2 -translate-x-1/2 z-10 bg-white border border-[#E5E7EB] shadow-sm rounded-full p-2 text-[#6b7280] hover:text-[#315CEA] hover:border-[#315CEA]/40 transition-colors"
            aria-label="Scroll to bottom"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      )}

      {/* input bar */}
      <div className="shrink-0 bg-gradient-to-t from-white via-white to-transparent">
        <div className="max-w-3xl mx-auto px-5 pb-4 pt-2">
          <div className="rounded-[22px] border border-[#E5E7EB] bg-white shadow-[0_2px_12px_rgba(20,30,70,0.05)] focus-within:border-[#315CEA]/60 transition-colors">
            <textarea
              ref={taRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 176) + 'px'
              }}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask StoryPilot to fetch stories, run the pipeline, deploy workflows…"
              className="w-full resize-none bg-transparent outline-none px-4.5 pt-3.5 pb-1 text-[15.5px] leading-relaxed placeholder:text-[#b3b8c2] max-h-44"
              aria-label="Message StoryPilot"
            />
            <div className="flex items-center justify-between px-3.5 pb-2.5 pt-1">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[12px] font-medium text-[#6b7280] bg-[#F5F7FA] border border-[#EBEDF0] rounded-full px-2.5 py-1">
                  <Sparkles size={12} className="text-[#315CEA]" /> {modelLabel}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1.5 text-[12px] text-[#9aa0ab] bg-[#F0FAF4] border border-[#D6F0E2] rounded-full px-2.5 py-1">
                  keyless · freellmpool
                </span>
              </div>
              {streaming ? (
                <span className="w-9 h-9 rounded-full bg-[#F5F7FA] flex items-center justify-center text-[#9aa0ab]" title="Generating…">
                  <Square size={13} fill="currentColor" />
                </span>
              ) : (
                <button
                  onClick={() => send()}
                  disabled={!input.trim()}
                  className={cn(
                    'w-9 h-9 rounded-full flex items-center justify-center transition-all',
                    input.trim()
                      ? 'bg-[#315CEA] text-white hover:bg-[#2a50d4] active:scale-95 shadow-[0_2px_8px_rgba(49,92,234,0.35)]'
                      : 'bg-[#EBEDF0] text-[#b3b8c2] cursor-not-allowed'
                  )}
                  aria-label="Send message"
                >
                  <ArrowUp size={17} strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
          <p className="text-center text-[11.5px] text-[#b3b8c2] mt-2.5">
            StoryPilot runs real actions — fetching sheets, dispatching GitHub workflows, posting videos.
          </p>
        </div>
      </div>
    </div>
  )
}

function ToolCard({ tool, live }: { tool: ToolEvent; live?: boolean }) {
  const [open, setOpen] = useState(!live)
  const running = tool.status === 'running'
  return (
    <div className="rounded-xl border border-[#E5E7EB] bg-[#FBFCFE] overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-[#F5F7FA] transition-colors"
      >
        <span className={cn(
          'w-6 h-6 rounded-lg flex items-center justify-center shrink-0',
          running ? 'bg-[#F0F4FF] text-[#315CEA]' : tool.ok ? 'bg-[#E9F9F0] text-[#0e9f6e]' : 'bg-[#FDECEC] text-[#d13438]'
        )}>
          {running ? <Loader2 size={13} className="animate-spin" /> : tool.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
        </span>
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#3c4658]">
          <Wrench size={11} className="text-[#9aa0ab]" />
          {tool.name}
        </span>
        {tool.summary && (
          <span className="text-[12.5px] text-[#9aa0ab] truncate flex-1 hidden sm:block">{tool.summary}</span>
        )}
        {tool.summary && <ChevronDown size={14} className={cn('text-[#b3b8c2] transition-transform ml-auto shrink-0', open && 'rotate-180', !tool.summary && 'ml-auto')} />}
      </button>
      {open && tool.summary && (
        <div className="px-3.5 pb-3 pt-0.5">
          <p className="text-[13px] leading-relaxed text-[#6b7280] bg-white rounded-lg border border-[#EEF0F3] px-3 py-2.5">{tool.summary}</p>
        </div>
      )}
    </div>
  )
}
