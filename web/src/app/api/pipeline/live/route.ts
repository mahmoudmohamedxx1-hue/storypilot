import { NextRequest } from 'next/server'
import { getSettings } from '@/lib/settings'
import { getGithubStatus, listWorkflowRuns, getRunJobs, listArtifacts, listWorkflows } from '@/lib/github'
import { getHeartbeatState, heartbeatCheckOnce } from '@/lib/heartbeat'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Live pipeline state for the n8n-style canvas.
 * GET ?runId=<id>  → runs list + per-step state of the selected run + artifacts + heartbeat.
 * Omit runId → latest run is selected automatically.
 * POST { force?: boolean } → run one heartbeat check now (manual "ensure video").
 */
export async function GET(req: NextRequest) {
  const s = await getSettings()
  try {
    const status = await getGithubStatus()
    if (!status.connected) {
      return Response.json({ ok: false, error: status.error || 'GitHub not connected', connected: false }, { status: 200 })
    }

    const [runs, artifacts, workflows] = await Promise.all([
      listWorkflowRuns(s.githubRepo, 10),
      listArtifacts(s.githubRepo).catch(() => []),
      listWorkflows(s.githubRepo).catch(() => []),
    ])

    const requested = req.nextUrl.searchParams.get('runId')
    let selected = requested ? runs.find((r) => String(r.id) === requested) : runs[0]
    if (!selected && requested) selected = runs[0] // stale id → fall back to latest

    let jobs: Awaited<ReturnType<typeof getRunJobs>> = []
    if (selected) {
      jobs = await getRunJobs(s.githubRepo, selected.id, selected.run_attempt || 1).catch(() => [])
    }

    return Response.json({
      ok: true,
      connected: true,
      user: status.user,
      repo: s.githubRepo,
      runs,
      selectedRunId: selected?.id ?? null,
      jobs,
      artifacts,
      workflows,
      heartbeat: getHeartbeatState(),
    })
  } catch (e) {
    return Response.json({ ok: false, connected: false, error: (e as Error).message, heartbeat: getHeartbeatState() }, { status: 200 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const force = body?.force === true
    const result = await heartbeatCheckOnce(force)
    return Response.json({ ok: !result.startsWith('error') && !result.startsWith('no GitHub'), result, heartbeat: getHeartbeatState() })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 200 })
  }
}
