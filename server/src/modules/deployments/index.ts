import { z } from 'zod'
import { GitHubError, githubFetch } from '../../github/client'
import { getGitHubToken } from '../auth/token'
import {
  findPrsByMergeCommits,
  getDeploymentWithRepo,
  getPreviousSuccessDeployment,
  listUnlinkedDeploymentIds,
  replaceDeploymentPrs,
  upsertDeployment,
} from '../../db/deploymentWrites'

// ─── compare pagination ──────────────────────────────────────────────────────

const comparePage = z.object({ commits: z.array(z.object({ sha: z.string() })) })

function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null
  const m = linkHeader.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/)
  return m ? m[1] : null
}

async function allCompareCommits(
  token: string,
  owner: string,
  name: string,
  base: string,
  head: string,
): Promise<string[]> {
  const shas: string[] = []
  let path: string | null = `/repos/${owner}/${name}/compare/${base}...${head}`
  while (path) {
    const res = await githubFetch(token, path)
    const data = comparePage.parse(await res.json())
    shas.push(...data.commits.map((c) => c.sha))
    path = nextLink(res.headers.get('link'))
  }
  return shas
}

// ─── linkDeployment ──────────────────────────────────────────────────────────

export async function linkDeployment(
  deploymentId: number,
): Promise<{ prCount: number; previousDeploymentId: number | null }> {
  const dep = await getDeploymentWithRepo(deploymentId)
  if (!dep) throw new Error(`Deployment ${deploymentId} not found`)

  const prev = await getPreviousSuccessDeployment(dep.repo_id, dep.environment, dep.created_at)

  if (!prev) {
    await replaceDeploymentPrs(deploymentId, [])
    return { prCount: 0, previousDeploymentId: null }
  }

  if (dep.connected_by === null) throw new Error(`Repo ${dep.repo_id} has no connecting user`)
  const token = await getGitHubToken(dep.connected_by)

  const shas = await allCompareCommits(token, dep.owner, dep.name, prev.sha, dep.sha)
  const prs = await findPrsByMergeCommits(dep.repo_id, shas)
  const prIds = prs.map((p) => p.id)

  await replaceDeploymentPrs(deploymentId, prIds)
  return { prCount: prIds.length, previousDeploymentId: prev.id }
}

// ─── recordDeploymentEvent ───────────────────────────────────────────────────

const STATE_MAP: Record<string, 'pending' | 'success' | 'failed'> = {
  success: 'success',
  failure: 'failed',
  error: 'failed',
  pending: 'pending',
  queued: 'pending',
  in_progress: 'pending',
}

const deploymentStatusSchema = z.object({
  deployment: z.object({
    id: z.number(),
    sha: z.string(),
    environment: z.enum(['staging', 'production']),
  }),
  deployment_status: z.object({ state: z.string() }),
})

export async function recordDeploymentEvent(
  repoId: number,
  payload: unknown,
): Promise<number | null> {
  const parsed = deploymentStatusSchema.safeParse(payload)
  if (!parsed.success) return null

  const { deployment, deployment_status } = parsed.data
  const status = STATE_MAP[deployment_status.state]
  if (!status) return null

  const deploymentId = await upsertDeployment({
    repoId,
    sha: deployment.sha,
    environment: deployment.environment,
    status,
    source: 'webhook',
    externalIdentifier: String(deployment.id),
  })

  // Link PRs; on GitHub failure keep the row — the scheduled sync retries unlinked deployments
  try {
    await linkDeployment(deploymentId)
  } catch (err) {
    if (err instanceof GitHubError) {
      console.error(`deployments: GitHub ${err.status} linking deployment ${deploymentId} — will retry`)
    } else {
      throw err
    }
  }

  return deploymentId
}

// ─── retryUnlinkedDeployments ────────────────────────────────────────────────
// Called by the scheduled sync job (Mallikarjun adds the call to server/src/jobs/sync.ts).

export async function retryUnlinkedDeployments(): Promise<void> {
  const ids = await listUnlinkedDeploymentIds()
  for (const id of ids) {
    try {
      await linkDeployment(id)
    } catch (err) {
      console.error(
        `deployments: retry link failed for ${id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}
