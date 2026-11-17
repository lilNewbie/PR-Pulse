// Owned by Mandaar. Decides which PRs a verified delivery affects and hands them to the PR Sync Service.
import { z } from 'zod'
import { applyEvent, recordPushTouches } from '../sync'
import { listOpenPrNumbersByBaseRef } from '../db/prWrites'
import { recordDeploymentEvent } from '../modules/deployments'

const prEvent = z.object({ pull_request: z.object({ number: z.number().int().positive() }) })
const issueComment = z.object({
  issue: z.object({ number: z.number().int().positive(), pull_request: z.unknown().optional() }),
})
const push = z.object({ ref: z.string(), deleted: z.boolean().optional() })

const BRANCH_PREFIX = 'refs/heads/'

const deploymentStatus = z.object({
  deployment: z.object({ environment: z.string() }),
})

// Only these environments are tracked (US-12, design-final section 2). Anything else is ignored.
const TRACKED_ENVIRONMENTS = new Set(['staging', 'production'])

// Pure: whether a deployment_status delivery is for a tracked environment.
export function isTrackedDeployment(payload: unknown): boolean {
  const p = deploymentStatus.safeParse(payload)
  return p.success && TRACKED_ENVIRONMENTS.has(p.data.deployment.environment)
}

export type Target = { kind: 'pr'; prNumber: number } | { kind: 'base'; baseRef: string } | null

// Pure: which PR (or which base branch's open PRs) an event is about. null means nothing to do.
export function targetOf(event: string, payload: unknown): Target {
  switch (event) {
    case 'pull_request':
    case 'pull_request_review': {
      const p = prEvent.safeParse(payload)
      return p.success ? { kind: 'pr', prNumber: p.data.pull_request.number } : null
    }
    case 'issue_comment': {
      // Comments on plain issues are not PR activity.
      const p = issueComment.safeParse(payload)
      return p.success && p.data.issue.pull_request ? { kind: 'pr', prNumber: p.data.issue.number } : null
    }
    case 'push': {
      const p = push.safeParse(payload)
      if (!p.success || p.data.deleted || !p.data.ref.startsWith(BRANCH_PREFIX)) return null
      return { kind: 'base', baseRef: p.data.ref.slice(BRANCH_PREFIX.length) }
    }
    default:
      return null // ping and anything else we subscribe to by accident
  }
}

// Runs after the 202 has been sent. A failing PR doesn't stop the others; the next sync repairs it.
export async function processDelivery(repoId: number, event: string, payload: unknown): Promise<void> {
  if (event === 'deployment_status') {
    if (isTrackedDeployment(payload)) await recordDeploymentEvent(repoId, payload)
    return
  }
  if (event === 'push') {
    // Who changed which files on the default branch (US-11, US-15). Independent of the PR re-checks below.
    await recordPushTouches(repoId, payload).catch((err: unknown) => {
      console.error(`webhook: file touches failed for repo ${repoId}: ${err instanceof Error ? err.message : err}`)
    })
  }
  const target = targetOf(event, payload)
  if (!target) return
  const prNumbers =
    target.kind === 'pr' ? [target.prNumber] : await listOpenPrNumbersByBaseRef(repoId, target.baseRef)

  const results = await Promise.allSettled(prNumbers.map((n) => applyEvent(repoId, n)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
      console.error(`webhook: applyEvent failed for repo ${repoId} PR #${prNumbers[i]}: ${reason}`)
    }
  })
}
