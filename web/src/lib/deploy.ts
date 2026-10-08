import { buildWorkflowBundle } from '@/lib/workflow-bundle'
import { getDefaultBranch, getFileSha, putFile, deleteRepoVariable, deleteFile } from '@/lib/github'

export interface DeployResult {
  repo: string
  branch: string
  pushed: string[]
  skipped: string[]
  failed: Array<{ path: string; error: string }>
  variables: Record<string, 'deleted' | 'failed'>
  retired: string[] // old files removed from the repo
}

/** Files from past architectures that must NOT stay in the repo. */
const RETIRED_PATHS = [
  '.github/workflows/ensure-hourly.yml', // pre-factory watcher
  'scripts/schedule_gate.py',            // scheduled-mode hour gate (factory is continuous now)
  'state/schedule_state.json',           // scheduled-mode slot ledger
]

export async function deployBundle(repo: string): Promise<DeployResult> {
  const bundle = await buildWorkflowBundle()
  const branch = await getDefaultBranch(repo).catch(() => 'main')
  const result: DeployResult = { repo, branch, pushed: [], skipped: [], failed: [], variables: {}, retired: [] }
  for (const file of bundle) {
    try {
      const sha = await getFileSha(repo, file.path, branch)
      const res = await putFile(repo, file.path, file.content, `storypilot: update ${file.path}`, sha, branch)
      if (sha) result.skipped.push(file.path)
      else result.pushed.push(file.path)
      void res
    } catch (e) {
      result.failed.push({ path: file.path, error: (e as Error).message })
    }
  }
  // the factory runs CONTINUOUSLY - the SCHEDULE_HOURS variable from the old
  // scheduled mode must go, otherwise it lingers as a confusing no-op
  if (await deleteRepoVariable(repo, 'SCHEDULE_HOURS')) {
    result.variables.SCHEDULE_HOURS = 'deleted'
  }
  // retire obsolete files (old watchers + the scheduled-mode gate)
  for (const path of RETIRED_PATHS) {
    try {
      if (await deleteFile(repo, path, 'storypilot: retire obsolete scheduled-mode file (continuous factory)', branch)) {
        result.retired.push(path)
      }
    } catch { /* already gone */ }
  }
  return result
}
