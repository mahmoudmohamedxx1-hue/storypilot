import { buildWorkflowBundle } from '@/lib/workflow-bundle'
import { getDefaultBranch, getFileSha, putFile } from '@/lib/github'

export interface DeployResult {
  repo: string
  branch: string
  pushed: string[]
  updated: string[]
  skipped: string[]
  failed: Array<{ path: string; error: string }>
}

export async function deployBundle(repo: string): Promise<DeployResult> {
  const bundle = await buildWorkflowBundle()
  const branch = await getDefaultBranch(repo).catch(() => 'main')
  const result: DeployResult = { repo, branch, pushed: [], updated: [], skipped: [], failed: [] }
  for (const file of bundle) {
    try {
      const sha = await getFileSha(repo, file.path, branch)
      if (sha) {
        // compare content — only push when it actually changed
        const res = await putFile(repo, file.path, file.content, `storypilot: update ${file.path}`, sha, branch)
        const newSha = res?.content?.sha
        if (newSha && newSha === sha) result.skipped.push(file.path)
        else result.updated.push(file.path)
      } else {
        await putFile(repo, file.path, file.content, `storypilot: add ${file.path}`, undefined, branch)
        result.pushed.push(file.path)
      }
    } catch (e) {
      result.failed.push({ path: file.path, error: (e as Error).message })
    }
  }
  return result
}
