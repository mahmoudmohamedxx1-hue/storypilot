import { fetchSheetData } from '@/lib/sheet'
import { getSettings } from '@/lib/settings'
import { db } from '@/lib/db'
import {
  getGithubStatus,
  listWorkflowRuns,
  dispatchWorkflow,
  listRepos,
  putFile,
  getFileSha,
  ghJson,
} from '@/lib/github'
import { buildWorkflowBundle } from '@/lib/workflow-bundle'
import { syncSheet } from '@/lib/sync'
import { buildLibrary, renderStoryById, renderAllPending } from '@/lib/library'
import { isScheduledHour, formatScheduleHours } from '@/lib/schedule'

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
    s.driveWebappUrl ? 'Google Drive: connected (video sync every slot)' : 'Google Drive: not configured (DRIVE_WEBAPP_URL secret needed - one-time Apps Script setup, see Platforms view)',
  ].join(' | ')
  const scheduleBits = s.scheduleHours || '11,12,13,15,20'
  return `You are ${AGENT_NAME}, an AI agent that operates a SCHEDULED video factory.

MISSION — videos are made BY THE CLOCK, never continuously:
1. The Scheduled Video Factory (factory.yml on GitHub Actions) ticks hourly; the schedule gate makes videos ONLY at the scheduled hours (${scheduleBits} Africa/Cairo, repo variable SCHEDULE_HOURS). Between scheduled hours NOTHING is rendered.
2. Each scheduled slot renders up to MAX_VIDEOS_PER_SLOT (default 2) videos: pending Google Sheet stories first (sheet id: ${s.sheetId}, Spark's live edits), and if the queue is empty the keyless AI invents ONE fresh story so the slot still produces.
3. For EVERY video, the KEYLESS AI WRITES THE HYPERFRAME CODE first (scripts/ai_forge.py: freellmpool → Pollinations, no API keys) - a full Python renderer for that story, sandbox-run and self-repaired on errors; the battle-tested built-in renderer is the guaranteed fallback so a video ALWAYS comes out.
4. Finished MP4s post to YouTube, TikTok and Instagram Reels, and every video is synced to Google Drive (deduped in state/drive_sync.json) when the DRIVE_WEBAPP_URL secret is set.
5. Manual/agent requests ("make a video now", catch-up batches) BYPASS the schedule - explicit human intent always works immediately.

CURRENT STATE
- Video schedule: ${scheduleBits} (hours, Africa/Cairo) — change it in Settings; it deploys as the SCHEDULE_HOURS repo variable
- Chat model: ${s.chatModel} via z.ai SDK (GLM-5.3-Flash is the default chat model)
- Keyless code-writing/story models in the workflow: freellmpool "${s.flpModel}" first, then live keyless routes (ovh/gpt-oss-120b, Qwen3-Coder, kilo/openrouter), then Pollinations text API (gpt-oss) - all keyless with auto-failover
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
- render_story {"storyId": str} — dispatch a GitHub Actions render for one library story (any tab, any format, immediate)
- make_all_videos {} — on-demand batch: render EVERY pending sheet story NOW on parallel workers (bypasses the schedule)
- get_pipeline {} — GitHub connection, recent workflow runs, local job list
- create_job {"storyTitle": str} — queue a video job in the app's job board
- trigger_workflow {} — dispatch the Scheduled Video Factory right now (schedule bypassed for this run)
- control_factory {"action": "start"|"stop"|"status"} — start/resume the scheduled factory, stop it gracefully (state/FACTORY_STOP), or check if it's alive
- drive_status {} — live health check of the Google Drive sync (pings the user's Apps Script web app; explains setup if not configured)
- deploy_workflow {} — push the full bundle (factory.yml + hourly-video.yml + python scripts + SCHEDULE_HOURS variable) to the repo
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
- The schedule is THE engine: each scheduled slot renders up to MAX_VIDEOS_PER_SLOT stories (keyless-AI-written renderer per story, tracked in state/videos.json committed to the repo), records itself in state/schedule_state.json (one session per slot, never two) and STOPS - no chaining, no continuous making. The next videos come at the next scheduled hour. Edited sheet stories re-queue automatically. The hourly-video workflow is the manual catch-up tool (Library "Render all" button / on-demand batches).`
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
          summary: `GitHub: ${gh.connected ? 'connected' : `not connected (${(gh as { error?: string }).error || ''})`}. Recent runs: ${runs.length ? runs.map(r => `#${r.id} ${r.status}${r.conclusion ? '/' + r.conclusion : ''} (${r.created_at})`).join('; ') : 'none yet'}. Local jobs: ${jobs.length}.`,
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
        await dispatchWorkflow(s.githubRepo, 'factory.yml', 'main', { reason: 'chat' })
        return {
          name, args, ok: true,
          summary: `Dispatched the Scheduled Video Factory on ${s.githubRepo} (schedule bypassed for this manual run). It renders up to the per-slot cap of pending stories (keyless AI writes the renderer code per video), syncs them to Drive and posts to the connected platforms, then stops - the regular schedule (${s.scheduleHours || '11,12,13,15,20'} Africa/Cairo) continues at the next slot. Watch it in the Pipeline view.`,
        }
      }
      case 'control_factory': {
        const s = await getSettings()
        const action = String(args.action || 'status')
        if (action === 'stop') {
          await putFile(s.githubRepo, 'state/FACTORY_STOP',
            `Factory stop requested by ${AGENT_NAME} at ${new Date().toISOString()}\nDelete this file (or ask "start the factory") to resume.\n`,
            'chore: graceful factory stop [skip ci]')
          return {
            name, args, ok: true,
            summary: 'Factory STOP requested (state/FACTORY_STOP committed). The current run finishes its video, uploads it, and does NOT chain the next run. Say "start the factory" to resume.',
          }
        }
        if (action === 'start') {
          const sha = await getFileSha(s.githubRepo, 'state/FACTORY_STOP').catch(() => undefined)
          if (sha) {
            await ghJson(`/repos/${s.githubRepo}/contents/state/FACTORY_STOP`, {
              method: 'DELETE',
              body: JSON.stringify({ message: 'chore: resume the factory [skip ci]', sha }),
            })
          }
          await dispatchWorkflow(s.githubRepo, 'factory.yml', 'main', { reason: 'chat-start' })
          return {
            name, args, ok: true,
            summary: `Factory RESUMED: stop flag removed${sha ? '' : ' (was not set)'} and a fresh run dispatched on ${s.githubRepo}. The regular schedule (${s.scheduleHours || '11,12,13,15,20'} Africa/Cairo) takes over from the next slot.`,
          }
        }
        const runs = await listWorkflowRuns(s.githubRepo, 10).catch(() => [])
        const factoryRuns = runs.filter((r) => r.name === 'Scheduled Video Factory' || r.name === 'Continuous Video Factory')
        const live = factoryRuns.find((r) => r.status === 'in_progress' || r.status === 'queued')
        const sched = isScheduledHour(s.scheduleHours)
        return {
          name, args, ok: true,
          summary: live
            ? `Factory is WORKING: run #${live.id} ${live.status} (started ${new Date(live.created_at).toLocaleString()}). It stops when the slot is done - the next videos come at the next scheduled hour.`
            : (sched
                ? `No active factory run, but we are INSIDE a scheduled hour (${formatScheduleHours(s.scheduleHours)} Africa/Cairo) - the ensure-slot watcher or app heartbeat should revive it within minutes, or use control_factory {"action":"start"}.`
                : `Factory is idle - OUTSIDE the scheduled hours (${formatScheduleHours(s.scheduleHours)} Africa/Cairo). Next videos at the next scheduled slot. Use control_factory {"action":"start"} to bypass the schedule now.`),
          data: { live: live?.id ?? null, inScheduledHour: sched },
        }
      }
      case 'drive_status': {
        const s = await getSettings()
        if (!s.driveWebappUrl) {
          return {
            name, args, ok: true,
            summary: 'Google Drive sync is NOT configured yet. The factory still renders + posts without it. To turn on the hourly Drive backup (3 minutes, one-time): 1) open script.google.com and create a new project, 2) paste the code from scripts/drive_webapp.js in the repo, 3) Deploy as Web app (Execute as: Me, Access: Anyone) and copy the /exec URL, 4) paste it in the Platforms view (Google Drive card) and hit Save & push secrets. Videos then land in a "StoryPilot Videos" folder in your Drive within an hour.',
          }
        }
        try {
          const url = new URL(s.driveWebappUrl)
          url.searchParams.set('action', 'ping')
          if (s.driveWebappKey) url.searchParams.set('key', s.driveWebappKey)
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
          const j = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok?: boolean; root?: string; error?: string }
          if (j.ok) {
            return {
              name, args, ok: true,
              summary: `Google Drive sync is LIVE: web app reachable, uploading into the "${j.root || 'StoryPilot Videos'}" folder. Every finished video is synced right after it renders (deduped), plus a flush at the end of each scheduled slot.`,
              data: j,
            }
          }
          return {
            name, args, ok: false,
            summary: `Drive web app reachable but rejected the ping: ${j.error || 'unknown error'}. If you set a KEY in the Apps Script, make sure the same value is in the DRIVE_WEBAPP_KEY secret (Platforms view).`,
            data: j,
          }
        } catch (e) {
          return { name, args, ok: false, summary: `Could not reach the Drive web app: ${(e as Error).message}. Check the /exec URL in the Platforms view (redeploy the Apps Script web app if it was revoked).` }
        }
      }
      case 'deploy_workflow': {
        const { deployBundle } = await import('@/lib/deploy')
        const s = await getSettings()
        const result = await deployBundle(s.githubRepo)
        return {
          name, args, ok: true,
          summary: `Deployed ${result.pushed.length} files to ${s.githubRepo}: ${result.pushed.join(', ')}. ${result.skipped.length ? `Skipped (unchanged): ${result.skipped.join(', ')}.` : ''} The Continuous Video Factory (factory.yml) is live - dispatch it with trigger_workflow or control_factory {"action":"start"}.`,
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
