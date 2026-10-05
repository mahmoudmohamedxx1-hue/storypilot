import nacl from 'tweetnacl'
import { blake2b } from 'blakejs'
import { getSettings } from '@/lib/settings'

const GH_API = 'https://api.github.com'

async function gh(path: string, init: RequestInit = {}, tokenOverride?: string): Promise<Response> {
  const settings = await getSettings()
  const token = tokenOverride || settings.githubToken
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  })
  return res
}

export async function ghJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await gh(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((body as { message?: string }).message || `GitHub API ${res.status}`)
  }
  return body as T
}

export async function getGithubStatus() {
  try {
    const user = await ghJson<{ login: string; name: string | null; avatar_url: string; html_url: string; public_repos: number }>(`/user`)
    return { connected: true as const, user }
  } catch (e) {
    return { connected: false as const, error: (e as Error).message }
  }
}

export async function listRepos() {
  const repos = await ghJson<Array<{ full_name: string; name: string; pushed_at: string; private: boolean; description: string | null }>>(
    `/user/repos?per_page=100&sort=pushed&type=owner`
  )
  return repos.map(r => ({ full_name: r.full_name, name: r.name, pushed_at: r.pushed_at, private: r.private, description: r.description }))
}

export async function listWorkflowRuns(repo: string, perPage = 10) {
  const data = await ghJson<{
    total_count: number
    workflow_runs: Array<{
      id: number
      name: string
      status: string
      conclusion: string | null
      event: string
      created_at: string
      updated_at: string
      run_attempt: number
      html_url: string
      head_branch: string
      display_title: string
    }>
  }>(`/repos/${repo}/actions/runs?per_page=${perPage}`)
  return data.workflow_runs.map(r => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    created_at: r.created_at,
    updated_at: r.updated_at,
    run_attempt: r.run_attempt || 1,
    html_url: r.html_url,
    display_title: r.display_title,
  }))
}

export interface RunStep {
  name: string
  status: string // queued | in_progress | completed
  conclusion: string | null // success | failure | skipped | cancelled
  number: number
  started_at: string | null
  completed_at: string | null
}

export interface RunJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  html_url: string
  steps: RunStep[]
}

/** Live per-step state of one workflow run (used by the n8n-style canvas). */
export async function getRunJobs(repo: string, runId: number, attempt = 1): Promise<RunJob[]> {
  const data = await ghJson<{ jobs: Array<RunJob & { run_url?: string }> }>(
    `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=20`
  )
  return (data.jobs || []).map(j => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    started_at: j.started_at,
    completed_at: j.completed_at,
    html_url: j.html_url,
    steps: (j.steps || []).map(s => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number,
      started_at: s.started_at,
      completed_at: s.completed_at,
    })),
  }))
}

export async function listWorkflows(repo: string) {
  const data = await ghJson<{
    workflows: Array<{ id: number; name: string; path: string; state: string; html_url: string }>
  }>(`/repos/${repo}/actions/workflows`)
  return data.workflows
}

/** Runs of one specific workflow file (e.g. hourly-video.yml). */
export async function listWorkflowFileRuns(repo: string, workflowFile: string, perPage = 5) {
  const data = await ghJson<{
    total_count: number
    workflow_runs: Array<{
      id: number
      name: string
      status: string
      conclusion: string | null
      event: string
      created_at: string
      updated_at: string
      run_attempt: number
      html_url: string
      display_title: string
    }>
  }>(`/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=${perPage}`)
  return data.workflow_runs.map(r => ({
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    created_at: r.created_at,
    updated_at: r.updated_at,
    run_attempt: r.run_attempt || 1,
    html_url: r.html_url,
    display_title: r.display_title,
  }))
}

export async function dispatchWorkflow(repo: string, workflowFile: string, ref = 'main', inputs: Record<string, string> = {}) {
  return ghJson(`/repos/${repo}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  })
}

export async function putFile(repo: string, path: string, content: string, message: string, sha?: string, branch = 'main') {
  const body: Record<string, unknown> = { content: Buffer.from(content).toString('base64'), message, branch }
  if (sha) body.sha = sha
  return ghJson<{ content: { sha: string } }>(`/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function getFileSha(repo: string, path: string, branch = 'main'): Promise<string | undefined> {
  try {
    const res = await gh(`/repos/${repo}/contents/${path}?ref=${branch}`)
    if (res.ok) {
      const data = await res.json()
      return data.sha
    }
  } catch { /* not found */ }
  return undefined
}

export async function getDefaultBranch(repo: string): Promise<string> {
  const data = await ghJson<{ default_branch: string }>(`/repos/${repo}`)
  return data.default_branch
}

// --- Repo secrets (libsodium crypto_box_seal, implemented via tweetnacl + blakejs) ---

/**
 * libsodium-compatible crypto_box_seal:
 *   nonce      = blake2b(ephemeral_pk || recipient_pk, 24 bytes)
 *   ciphertext = nacl.box(message, nonce, recipient_pk, ephemeral_sk)
 *   sealed     = ephemeral_pk (32 bytes) || ciphertext
 */
export function encryptSecret(secret: string, publicKeyBase64: string): string {
  const pk = Buffer.from(publicKeyBase64, 'base64')
  const ephemeral = nacl.box.keyPair()
  const nonce = blake2b(
    Buffer.concat([Buffer.from(ephemeral.publicKey), pk]),
    new Uint8Array(0),
    24
  )
  const message = new TextEncoder().encode(secret)
  const ciphertext = nacl.box(message, nonce, pk, ephemeral.secretKey)
  const sealed = new Uint8Array(32 + ciphertext.length)
  sealed.set(ephemeral.publicKey, 0)
  sealed.set(ciphertext, 32)
  return Buffer.from(sealed).toString('base64')
}

export async function pushRepoSecrets(repo: string, secrets: Record<string, string>) {
  const pk = await ghJson<{ key: string; key_id: string }>(`/repos/${repo}/actions/secrets/public-key`)
  const pushed: string[] = []
  const failed: string[] = []
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue
    try {
      const encrypted = encryptSecret(value, pk.key)
      const res = await gh(`/repos/${repo}/actions/secrets/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ encrypted_value: encrypted, key_id: pk.key_id }),
      })
      if (res.ok || res.status === 201 || res.status === 204) pushed.push(name)
      else failed.push(name)
    } catch {
      failed.push(name)
    }
  }
  return { pushed, failed }
}

export async function listArtifacts(repo: string, runId?: number) {
  const q = runId ? `?per_page=20` : '?per_page=20'
  const data = await ghJson<{
    artifacts: Array<{ id: number; name: string; size_in_bytes: number; expired: boolean; created_at: string; archive_download_url: string; workflow_run?: { id: number } }>
  }>(`/repos/${repo}/actions/artifacts${q}`)
  return data.artifacts.filter(a => !a.expired)
}

export async function downloadArtifactZip(repo: string, artifactId: number): Promise<ArrayBuffer> {
  const res = await gh(`/repos/${repo}/actions/artifacts/${artifactId}/zip`)
  if (!res.ok) throw new Error(`Artifact download failed (${res.status})`)
  return res.arrayBuffer()
}
