import { buildWorkflowBundle } from '@/lib/workflow-bundle'
import { getDefaultBranch, getFileSha, putFile, putRepoVariable, deleteFile } from '@/lib/github'
import { getSettings } from '@/lib/settings'
import { parseScheduleHours } from '@/lib/schedule'

export interface DeployResult {
  repo: string
  branch: string
  pushed: string[]
  skipped: string[]
  failed: Array<{ path: string; error: string }>
  variables: Record<string, 'created' | 'updated' | 'failed'>
  retired: string[] // old files removed from the repo
}

/** Workflow files from past architectures that must NOT stay in the repo. */
const RETIRED_PATHS = ['.github/workflows/ensure-hourly.yml']

export async function deployBundle(repo: string): Promise<DeployResult> {
  const s = await getSettings()
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
  // the video schedule (hours, Africa/Cairo) as a repo variable so the
  // pipeline's schedule gate and the app heartbeat always agree
  const hours = parseScheduleHours(s.scheduleHours).join(',')
  result.variables.SCHEDULE_HOURS = await putRepoVariable(repo, 'SCHEDULE_HOURS', hours)
  // retire obsolete workflow files (e.g. the old hourly ensure watcher)
  for (const path of RETIRED_PATHS) {
    try {
      if (await deleteFile(repo, path, 'storypilot: retire obsolete workflow (scheduled mode)', branch)) {
        result.retired.push(path)
      }
    } catch { /* already gone */ }
  }
  return result
}
