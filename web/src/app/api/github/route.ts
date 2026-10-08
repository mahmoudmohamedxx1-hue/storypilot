import { NextRequest } from 'next/server'
import {
  getGithubStatus,
  listRepos,
  listWorkflowRuns,
  dispatchWorkflow,
  listWorkflows,
  listArtifacts,
} from '@/lib/github'
import { deployBundle } from '@/lib/deploy'
import { pushRepoSecrets } from '@/lib/github'
import { getSettings } from '@/lib/settings'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get('view') || 'status'
  const s = await getSettings()
  try {
    if (view === 'status') {
      const status = await getGithubStatus()
      return Response.json({ ok: true, status, repo: s.githubRepo })
    }
    if (view === 'repos') {
      const repos = await listRepos()
      return Response.json({ ok: true, repos })
    }
    if (view === 'pipeline') {
      const [status, runs, workflows, artifacts] = await Promise.all([
        getGithubStatus(),
        listWorkflowRuns(s.githubRepo, 10).catch(() => []),
        listWorkflows(s.githubRepo).catch(() => []),
        listArtifacts(s.githubRepo).catch(() => []),
      ])
      return Response.json({ ok: true, status, repo: s.githubRepo, runs, workflows, artifacts })
    }
    return Response.json({ error: 'unknown view' }, { status: 400 })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}

export async function POST(req: NextRequest) {
  const { action, repo, secrets } = (await req.json()) as {
    action: 'dispatch' | 'deploy' | 'secrets'
    repo?: string
    secrets?: Record<string, string>
  }
  const s = await getSettings()
  try {
    if (action === 'dispatch') {
      await dispatchWorkflow(repo || s.githubRepo, 'factory.yml', 'main', { reason: 'ui' })
      return Response.json({ ok: true, message: `Continuous Video Factory dispatched on ${repo || s.githubRepo}` })
    }
    if (action === 'deploy') {
      const result = await deployBundle(repo || s.githubRepo)
      return Response.json({ ok: true, result })
    }
    if (action === 'secrets') {
      const result = await pushRepoSecrets(repo || s.githubRepo, secrets || {})
      return Response.json({ ok: true, result })
    }
    return Response.json({ error: 'unknown action' }, { status: 400 })
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 })
  }
}
