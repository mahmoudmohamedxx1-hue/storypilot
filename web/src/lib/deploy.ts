import { buildWorkflowBundle } from '@/lib/workflow-bundle'
import { getDefaultBranch, getFileSha, putFile } from '@/lib/github'

export interface DeployResult {
  repo: string
  branch: string
  pushed: string[]
  skipped: string[]
  failed: Array<{ path: string; error: string }>
}

export async function deployBundle(repo: string): Promise<DeployResult> {
  const bundle = await buildWorkflowBundle()
  const branch = await getDefaultBranch(repo).catch(() => 'main')
  const result: DeployResult = { repo, branch, pushed: [], skipped: [], failed: [] }
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
  return result
}
