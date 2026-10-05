import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { buildSystemPrompt, executeTool, ToolResult } from '@/lib/agent'
import { getSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const maxDuration = 120

const MAX_TOOL_CALLS = 4
const FALLBACK_MODEL = 'glm-4.6'

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/** The z-ai SDK returns the raw SSE ReadableStream when stream:true — parse deltas out of it. */
async function* sseDeltas(body: unknown): AsyncGenerator<string> {
  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const obj = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }
          const delta = obj?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) yield delta
        } catch { /* skip malformed event */ }
      }
    }
  }
}

const KNOWN_TOOLS = [
  'fetch_stories', 'get_pipeline', 'create_job', 'trigger_workflow',
  'deploy_workflow', 'list_repos', 'generate_story', 'setup_guide',
]

function parseToolBlock(text: string): { name: string; args: Record<string, unknown> } | null {
  // 1) fenced JSON block: ```tool\n{"tool": "x", "args": {}}\n``` (or unfenced JSON with a tool key)
  const fenceJson = text.match(/```(?:tool)?\s*(\{[\s\S]*?\})\s*```/)
  if (fenceJson) {
    try {
      const o = JSON.parse(fenceJson[1]) as { tool?: string; args?: Record<string, unknown> }
      if (typeof o.tool === 'string') return { name: o.tool, args: o.args || {} }
    } catch { /* fall through */ }
  }
  const bareJson = text.match(/\{\s*"tool"\s*:\s*"([a-z_]+)"[\s\S]*?\}/)
  if (bareJson) {
    try {
      const o = JSON.parse(bareJson[0]) as { tool?: string; args?: Record<string, unknown> }
      if (typeof o.tool === 'string') return { name: o.tool, args: o.args || {} }
    } catch { /* fall through */ }
  }
  // 2) fenced shorthand: ```tool\nget_pipeline {}\n``` (model shorthand — be lenient)
  const fence = text.match(/```(?:tool)?\s*\n?\s*([a-z_]+)\s*(\{[\s\S]*?\})?\s*\n?```/i)
  if (fence && KNOWN_TOOLS.includes(fence[1].toLowerCase())) {
    let args: Record<string, unknown> = {}
    if (fence[2]) {
      try { args = JSON.parse(fence[2]) } catch { /* keep {} */ }
    }
    return { name: fence[1].toLowerCase(), args }
  }
  // 3) bare shorthand line: "get_pipeline {}"
  const bare = text.match(/^\s*([a-z_]+)\s*(\{[\s\S]*?\})?\s*$/)
  if (bare && KNOWN_TOOLS.includes(bare[1].toLowerCase())) {
    let args: Record<string, unknown> = {}
    if (bare[2]) {
      try { args = JSON.parse(bare[2]) } catch { /* keep {} */ }
    }
    return { name: bare[1].toLowerCase(), args }
  }
  return null
}

export async function GET(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get('chatId')
  if (chatId) {
    const chat = await db.chat.findUnique({
      where: { id: chatId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    })
    if (!chat) return Response.json({ error: 'not found' }, { status: 404 })
    return Response.json({ chat })
  }
  const chats = await db.chat.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { messages: { take: 1, orderBy: { createdAt: 'desc' } } },
  })
  return Response.json({ chats })
}

export async function DELETE(req: NextRequest) {
  const chatId = req.nextUrl.searchParams.get('chatId')
  if (!chatId) return Response.json({ error: 'chatId required' }, { status: 400 })
  await db.chat.delete({ where: { id: chatId } })
  return Response.json({ ok: true })
}

export async function POST(req: NextRequest) {
  const { chatId, message } = (await req.json()) as { chatId?: string; message: string }
  if (!message?.trim()) return Response.json({ error: 'message required' }, { status: 400 })

  const settings = await getSettings()
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const zai = await ZAI.create()

  // resolve chat
  let chat = chatId ? await db.chat.findUnique({ where: { id: chatId }, include: { messages: { orderBy: { createdAt: 'asc' } } } }) : null
  if (chatId && !chat) return Response.json({ error: 'chat not found' }, { status: 404 })
  if (!chat) {
    chat = await db.chat.create({
      data: { title: message.trim().slice(0, 60) },
      include: { messages: true },
    })
  }
  await db.message.create({ data: { chatId: chat.id, role: 'user', content: message } })

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(sse(data)))
      try {
        send({ type: 'chat', chatId: chat!.id, title: chat!.title })

        const systemPrompt = await buildSystemPrompt()
        const convo: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt },
          ...chat!.messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(-16)
            .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user', content: message },
        ]

        const modelToUse = settings.chatModel || 'glm-5.3-flash'
        const toolTrace: ToolResult[] = []
        let finalText = ''
        let toolCalls = 0

        const callModel = async (msgs: typeof convo) => {
          try {
            return await zai.chat.completions.create({ model: modelToUse, messages: msgs, stream: true })
          } catch (e) {
            if (modelToUse !== FALLBACK_MODEL) {
              send({ type: 'notice', text: `${modelToUse} unavailable, falling back to ${FALLBACK_MODEL}` })
              return await zai.chat.completions.create({ model: FALLBACK_MODEL, messages: msgs, stream: true })
            }
            throw e
          }
        }

        for (let round = 0; round <= MAX_TOOL_CALLS; round++) {
          const completion = await callModel(convo)
          let text = ''
          let decided: 'unknown' | 'text' | 'tool' = 'unknown'
          let pending = ''
          for await (const delta of sseDeltas(completion)) {
            text += delta
            if (decided === 'tool') continue
            if (decided === 'text') {
              send({ type: 'delta', text: delta })
              continue
            }
            // unknown: buffer until we can tell a tool fence from normal text
            pending += delta
            const head = pending.trimStart()
            if (head.startsWith('```')) {
              decided = 'tool'
              continue
            }
            if (pending.length >= 14) {
              decided = 'text'
              send({ type: 'delta', text: pending })
              pending = ''
            }
          }
          if (decided !== 'tool' && pending) {
            decided = 'text'
            send({ type: 'delta', text: pending })
          }

          const tool = round < MAX_TOOL_CALLS ? parseToolBlock(text) : null
          if (!tool) {
            // malformed tool attempt? retry once with a strict-format nudge
            const looksLikeTool = /```|"tool"\s*:/i.test(text) && KNOWN_TOOLS.some((t) => text.toLowerCase().includes(t))
            if (looksLikeTool && round < MAX_TOOL_CALLS - 1) {
              convo.push({ role: 'assistant', content: text })
              convo.push({
                role: 'user',
                content: 'That tool call was malformed. Reply with EXACTLY one fenced block and nothing else:\n```tool\n{"tool": "<tool_name>", "args": {}}\n```',
              })
              continue
            }
            finalText = text.replace(/```(?:tool)?\s*\{[\s\S]*?\}\s*```/g, '').trim() || text.trim()
            break
          }

          toolCalls++
          send({ type: 'tool_start', name: tool.name, args: tool.args })
          const result = await executeTool(tool.name, tool.args)
          toolTrace.push(result)
          send({ type: 'tool_result', name: result.name, ok: result.ok, summary: result.summary, data: result.data })

          convo.push({ role: 'assistant', content: text })
          convo.push({
            role: 'user',
            content: `TOOL_RESULT (${result.name}): ${result.summary}${result.ok && result.data ? '\n' + JSON.stringify(result.data).slice(0, 3500) : ''}\n\nNow answer the user with this data (or call another tool if needed).`,
          })
        }

        if (!finalText) finalText = 'Done — see the tool results above.'

        const saved = await db.message.create({
          data: {
            chatId: chat!.id,
            role: 'assistant',
            content: finalText,
            tools: toolTrace.length ? JSON.stringify(toolTrace) : null,
          },
        })
        await db.chat.update({ where: { id: chat!.id }, data: { updatedAt: new Date() } })
        send({ type: 'done', messageId: saved.id, toolCalls })
      } catch (e) {
        const msg = (e as Error).message || 'agent failed'
        try { send({ type: 'error', error: msg }) } catch { /* client gone */ }
        await db.message.create({
          data: { chatId: chat!.id, role: 'assistant', content: `⚠️ Agent error: ${msg}` },
        }).catch(() => {})
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
