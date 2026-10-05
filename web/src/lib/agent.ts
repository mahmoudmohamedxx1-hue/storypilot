import { fetchSheetData } from '@/lib/sheet'
import { getSettings } from '@/lib/settings'
import { db } from '@/lib/db'
import {
  getGithubStatus,
  listWorkflowRuns,
  dispatchWorkflow,
  listRepos,
} from '@/lib/github'
import { buildWorkflowBundle } from '@/lib/workflow-bundle'
import { syncSheet } from '@/lib/sync'
import { buildLibrary, renderStoryById, renderAllPending, enhanceStoryWithGLM } from '@/lib/library'

export interface ToolResult {
  name: string
  args: Record<string, unknown>
  ok: boolean
  summary: string
  data?: unknown
}

export const AGENT_NAME = 'StoryPilot'

export async function buildSystemPrompt(): Promise<string> {
  const s = await getSettings()
  const gh = await getGithubStatus().catch(() => ({ connected: false }))
  const platformBits = [
    s.youtubeToken ? 'YouTube: connected' : 'YouTube: not configured (YOUTUBE_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET secrets needed)',
    s.tiktokToken ? 'TikTok: connected' : 'TikTok: not configured (TIKTOK_ACCESS_TOKEN secret needed)',
    s.instagramToken ? 'Instagram: connected' : 'Instagram: not configured (INSTAGRAM_ACCESS_TOKEN/USER_ID secrets needed)',
  ].join(' | ')
  return `You are ${AGENT_NAME}, an AI agent that operates a CONTINUOUS AI video factory.

MISSION — videos are generated CONTINUOUSLY, not just hourly:
1. Read every story from the Google Sheet that Gemini Spark updates (sheet id: ${s.sheetId}) — always in sync.
2. Render each one into a vertical 1080x1920 60fps MP4 with keyless AI imagery + Edge-TTS + MoviePy (GitHub Actions, keyless & free).
3. The app's CONTINUOUS RENDER LOOP polls every 90s and dispatches the render workflow BACK-TO-BACK with ${s.workers} PARALLEL WORKERS whenever pending stories exist — so the whole sheet becomes videos as fast as possible, then keeps up with new Spark stories automatically. Hourly crons (:47 render, :19 watcher) are backup layers.
4. Post every finished MP4 to YouTube, TikTok and Instagram Reels.

CURRENT STATE
- Chat model: ${s.chatModel} via z.ai SDK (GLM-5.3-Flash is the default — it also polishes stories on-demand before rendering)
- Keyless AI in the workflow: ${s.flpModel} via freellmpool (github.com/0xzr/freellmpool) — story generation fallback + AI polish of voiceovers and platform metadata (title/description/tags) with auto-failover across keyless routes
- AI polish: ${s.aiEnhance ? 'ON — every video narration is tightened by keyless AI (freellmpool in the workflow, GLM-5.3-Flash for app-dispatched single renders)' : 'OFF (enable in Settings)'}
- GitHub: ${gh.connected === true ? 'connected' : 'NOT connected (add a token in Settings)'} (pipeline repo: ${s.githubRepo})
- Platforms: ${platformBits}
- TTS voice (Arabic): ${s.voice}
- The app runs an ALWAYS-SYNC engine: every ~60s it re-reads the whole Google Sheet (all 14 tabs), parses every story (English + Arabic formats) and keeps a video Library of everything (to be made / rendering / done).

TOOLS — when you need live data or an action, reply with ONE fenced json block and nothing else:
\`\`\`tool
{"tool": "<name>", "args": {}}
\`\`\`
Available tools:
- fetch_stories {} — fetch the current story + generator code from the Google Sheet
- sync_sheet {} — re-sync the app with the Google Sheet now (all tabs, all stories, change detection)
- get_library {} — the video library: every story from the sheet + its render status (to make / rendering / done) + stats
- render_story {"storyId": str} — dispatch a GitHub Actions render for one library story (any tab, any format)
- make_all_videos {} — dispatch the continuous factory: N parallel workers render EVERY pending sheet story (keyless AI polish on); the app's render loop re-dispatches back-to-back until all are done
- enhance_story {"storyId": str} — preview the GLM-5.3-Flash (z.ai SDK) polish of one story's narration without rendering it
- get_pipeline {} — GitHub connection, recent workflow runs, local job list
- create_job {"storyTitle": str} — queue a video job in the app's job board
- trigger_workflow {} — dispatch the hourly-video GitHub Actions workflow right now
- deploy_workflow {} — push the workflow bundle files (.github/workflows/hourly-video.yml + python scripts) to the repo
- list_repos {} — list the GitHub repos available to pick as pipeline repo
- generate_story {"topic": str} — write a brand-new 4-6 scene story JSON (same schema as the sheet) for the next video
- setup_guide {} — the step-by-step guide for wiring YouTube/TikTok/Instagram secrets

RULES
- Prefer tools over guessing. If the user asks about stories/pipeline/jobs/repos, call the tool first, then answer with real data.
- After a tool result you will receive it as a TOOL_RESULT message; then write the final answer (or call another tool, max 4 calls).
- Be concise and structured: short paragraphs, bullet lists, bold key facts. Use the user's language (English or Arabic).
- Never invent workflow run statuses or story content — always read them via tools.
- If GitHub is not connected, guide the user to Settings to add a token.
- For anything about rendering tech: 1080x1920 9:16, 60fps hyperframes (FRAME_RATE var), H.264+AAC, Edge-TTS voices (ar-EG-ShakirNeural default), arabic-reshaper + python-bidi for Arabic text.
- The factory is CONTINUOUS: each dispatched run fans out to ${s.workers} parallel workers, each rendering its own shard of the pending queue (tracked in state/videos*.json committed to the repo) until every story has a video. Edited stories re-queue automatically (content-hash change). Pending counts come from the sheet stories minus the repo render state — always truthful.`
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'fetch_stories': {
        const data = await fetchSheetData()
        const story = data.stories[0]
        return {
          name, args, ok: true,
          summary: `Fetched "${story.title}" (${story.scenes.length} scenes, ${story.language}, ${story.totalWords} narration words). Python code tab: ${data.pythonCode ? `${data.pythonCode.split('\n').length} lines` : 'not found'}.`,
          data: { story, codeLines: data.pythonCode ? data.pythonCode.split('\n').length : 0, codeMeta: data.codeMeta },
        }
      }
      case 'sync_sheet': {
        const result = await syncSheet(true)
        return {
          name, args, ok: result.ok,
          summary: result.ok
            ? `Synced with the sheet: ${result.tabsFound} tabs, ${result.storiesNew} new stories, ${result.storiesChanged} changed, ${result.storiesGone} gone. (${result.durationMs}ms)`
            : `Sync failed: ${result.error}`,
          data: result,
        }
      }
      case 'get_library': {
        const lib = await buildLibrary()
        const lines = lib.items.slice(0, 12).map((i) =>
          `• "${i.title}" [${i.language}] ${i.scenes} scenes — ${i.status}${i.video?.runId ? ` (run #${i.video.runId}${i.video.runConclusion ? ' ' + i.video.runConclusion : ''})` : ''}`
        )
        return {
          name, args, ok: true,
          summary: `Library: ${lib.stats.totalStories} stories (${lib.stats.toMake} to make, ${lib.stats.inProgress} in progress, ${lib.stats.done} done, ${lib.stats.failed} failed). Videos: ${lib.stats.totalVideos}, storage ${(lib.stats.storageBytes / 1e6).toFixed(1)}MB. Top items:\n${lines.join('\n')}`,
          data: { stats: lib.stats, items: lib.items.slice(0, 12) },
        }
      }
      case 'render_story': {
        const storyId = args.storyId as string
        if (!storyId) return { name, args, ok: false, summary: 'render_story needs a storyId (get one from get_library).' }
        const result = await renderStoryById(storyId)
        return {
          name, args, ok: result.ok,
          summary: result.message + (result.ok ? ' Watch it live in the Pipeline view (n8n-style canvas).' : ''),
          data: result,
        }
      }
      case 'enhance_story': {
        const storyId = args.storyId as string
        if (!storyId) return { name, args, ok: false, summary: 'enhance_story needs a storyId (get one from get_library).' }
        const story = await db.storyRecord.findUnique({ where: { id: storyId } })
        if (!story) return { name, args, ok: false, summary: 'Story not found.' }
        let scenes: Array<{ visual?: string; voiceover?: string }> = []
        try { scenes = JSON.parse(story.storyJson || '{}').scenes || [] } catch { /* none */ }
        const polish = await enhanceStoryWithGLM({ title: story.title, logline: story.logline, scenes })
        if (!polish) return { name, args, ok: true, summary: `GLM-5.3-Flash polish unavailable right now — "${story.title}" would render with its original sheet narration (the keyless freellmpool polish in the workflow is the fallback).` }
        return {
          name, args, ok: true,
          summary: `GLM-5.3-Flash polish preview for "${story.title}":\n• AI title: ${polish.title}\n• First line: ${polish.voiceovers[0]?.slice(0, 140)}\n• Tags: ${polish.tags.slice(0, 6).join(', ')}\n(render_story applies this automatically before dispatching)`,
          data: { polish },
        }
      }
      case 'make_all_videos': {
        const result = await renderAllPending()
        return {
          name, args, ok: result.ok,
          summary: result.message + (result.ok ? ' Progress lands in the Library (catch-up banner) as videos finish.' : ''),
          data: result,
        }
      }
      case 'get_pipeline': {
        const s = await getSettings()
        const [gh, runs, jobs] = await Promise.all([
          getGithubStatus().catch(e => ({ connected: false as const, error: (e as Error).message })),
          listWorkflowRuns(s.githubRepo, 5).catch(() => []),
          db.videoJob.findMany({ take: 5, orderBy: { createdAt: 'desc' } }).catch(() => []),
        ])
        return {
          name, args, ok: true,
          summary: `Continuous factory: ${gh.connected ? 'GitHub connected' : `not connected (${(gh as { error?: string }).error || ''})`}. Recent runs: ${runs.length ? runs.map(r => `#${r.id} ${r.status}${r.conclusion ? '/' + r.conclusion : ''} (${r.created_at})`).join('; ') : 'none yet'}. Local jobs: ${jobs.length}.`,
          data: { github: gh, runs, jobs },
        }
      }
      case 'create_job': {
        const storyTitle = (args.storyTitle as string) || 'Hourly story'
        const job = await db.videoJob.create({
          data: { title: `Hourly video · ${storyTitle}`, storyTitle, status: 'queued' },
        })
        return {
          name, args, ok: true,
          summary: `Created video job ${job.id.slice(-6)} for "${storyTitle}" (status: queued).`,
          data: { job },
        }
      }
      case 'trigger_workflow': {
        const s = await getSettings()
        await dispatchWorkflow(s.githubRepo, 'hourly-video.yml')
        return {
          name, args, ok: true,
          summary: `Dispatched the hourly-video workflow on ${s.githubRepo}. It fetches the story, renders the MP4 and posts to the connected platforms. Watch it in the Pipeline view.`,
        }
      }
      case 'deploy_workflow': {
        const { deployBundle } = await import('@/lib/deploy')
        const s = await getSettings()
        const result = await deployBundle(s.githubRepo)
        return {
          name, args, ok: true,
          summary: `Deployed ${result.pushed.length} files to ${s.githubRepo}: ${result.pushed.join(', ')}. ${result.skipped.length ? `Skipped (unchanged): ${result.skipped.join(', ')}.` : ''} The hourly schedule (cron: 0 * * * *) is now live.`,
          data: result,
        }
      }
      case 'list_repos': {
        const repos = await listRepos()
        return {
          name, args, ok: true,
          summary: `${repos.length} repos: ${repos.slice(0, 10).map(r => r.full_name).join(', ')}${repos.length > 10 ? '…' : ''}`,
          data: { repos: repos.slice(0, 20) },
        }
      }
      case 'generate_story': {
        const topic = (args.topic as string) || 'a surprising 60-second micro-story with a twist ending'
        const story = await generateStoryJson(topic)
        return {
          name, args, ok: true,
          summary: `Wrote a new story "${story.title}" (${story.scenes.length} scenes) about: ${topic}.`,
          data: { story },
        }
      }
      case 'setup_guide': {
        const bundle = await buildWorkflowBundle()
        const md = bundle.find(f => f.path === 'STORYPILOT.md')?.content || ''
        return {
          name, args, ok: true,
          summary: 'Setup guide retrieved. Summarize the secrets table and the run instructions for the user.',
          data: { guide: md.slice(0, 4000) },
        }
      }
      default:
        return { name, args, ok: false, summary: `Unknown tool: ${name}` }
    }
  } catch (e) {
    return { name, args, ok: false, summary: `Tool failed: ${(e as Error).message}` }
  }
}

/** Uses the chat model itself to write a complete story JSON. */
export async function generateStoryJson(topic: string): Promise<{
  title: string
  logline: string
  genre: string
  duration: string
  language: string
  scenes: Array<{ index: number; timeRange: string; visual: string; aiPrompt: string; voiceover: string; sfx: string }>
  narration: string
}> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const zai = await ZAI.create()
  const s = await getSettings()
  const res = await zai.chat.completions.create({
    model: s.chatModel,
    messages: [
      {
        role: 'system',
        content: 'You write 60-second vertical-video stories. Reply with ONE JSON object only, no markdown fences. Schema: {"title":str,"logline":str,"genre":str,"duration":"60 Seconds","language":"en"|"ar","scenes":[{"timeRange":str,"visual":str,"aiPrompt":str,"voiceover":str,"sfx":str}],"narration":str}. Exactly 4-6 scenes. visual = one cinematic sentence, aiPrompt = short image prompt, voiceover = 1-3 spoken sentences. Match the topic language.',
      },
      { role: 'user', content: `Write a fresh hourly story about: ${topic}` },
    ],
    thinking: { type: 'disabled' },
  })
  let text = res.choices[0]?.message?.content || ''
  text = text.replace(/```json|```/g, '').trim()
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('Model did not return a story JSON')
  const story = JSON.parse(m[0])
  story.scenes = (story.scenes || []).map((sc: Record<string, unknown>, i: number) => ({
    index: i + 1,
    timeRange: (sc.timeRange as string) || `0:${String(i * 12).padStart(2, '0')} - 0:${String((i + 1) * 12).padStart(2, '0')}`,
    visual: sc.visual || '',
    aiPrompt: sc.aiPrompt || '',
    voiceover: sc.voiceover || '',
    sfx: sc.sfx || '',
  }))
  story.duration = story.duration || '60 Seconds'
  story.language = story.language || 'en'
  story.narration = story.narration || story.scenes.map((x: { voiceover: string }) => x.voiceover).join(' ')
  return story
}
