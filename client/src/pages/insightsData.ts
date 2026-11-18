// Pure aggregations for the Insights dashboard. Read-only: they only reshape responses from
// existing endpoints (GET /api/queue, GET /api/my-prs, GET /api/deployments). No fetching here.
import type { DeploymentSummary, PrSummary, QueueItem } from 'shared'

export interface CountRow {
  label: string
  count: number
}

export interface DeployDay {
  date: string // YYYY-MM-DD (UTC)
  label: string // e.g. "Nov 5"
  success: number
  failed: number
  pending: number
}

export interface Kpis {
  waitingOnMe: number | null // null when the caller can't see a review queue (PR Author)
  longestWaitHours: number | null
  releaseBlockers: number | null
  myOpenPrs: number
  myStalePrs: number
  deploys: number | null // null for non-Leads
  failedDeploys: number | null
}

const WAIT_BUCKETS: { label: string; maxHours: number }[] = [
  { label: '< 4h', maxHours: 4 },
  { label: '4–24h', maxHours: 24 },
  { label: '1–3 days', maxHours: 72 },
  { label: '3+ days', maxHours: Infinity },
]

/** Review-queue items counted by how long they have waited. Every bucket is present, even at 0. */
export function waitBuckets(items: QueueItem[]): CountRow[] {
  const rows = WAIT_BUCKETS.map((b) => ({ label: b.label, count: 0 }))
  for (const item of items) {
    const index = WAIT_BUCKETS.findIndex((b) => item.waitingHours < b.maxHours)
    rows[index].count++
  }
  return rows
}

/** My open PRs counted per flag. A PR with several flags counts once in each. */
export function flagCounts(prs: PrSummary[]): CountRow[] {
  const open = prs.filter((pr) => pr.state === 'open')
  return [
    { label: 'Stale', count: open.filter((pr) => pr.flags.stale).length },
    { label: 'Merge conflict', count: open.filter((pr) => pr.flags.conflict === 'yes').length },
    { label: 'Behind main', count: open.filter((pr) => pr.flags.behindBy > 0).length },
    { label: 'Draft', count: open.filter((pr) => pr.isDraft).length },
  ]
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Deployments per UTC day for the last `days` days ending today, oldest first, split by status. */
export function deploysPerDay(deployments: DeploymentSummary[], now: Date, days = 14): DeployDay[] {
  const rows: DeployDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))
    rows.push({
      date: utcDay(day),
      label: day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      success: 0,
      failed: 0,
      pending: 0,
    })
  }
  const byDate = new Map(rows.map((row) => [row.date, row]))
  for (const deployment of deployments) {
    const row = byDate.get(utcDay(new Date(deployment.createdAt)))
    if (row) row[deployment.status]++
  }
  return rows
}

export function computeKpis(input: {
  queue: QueueItem[] | null
  myPrs: PrSummary[]
  deployDays: DeployDay[] | null
}): Kpis {
  const { queue, myPrs, deployDays } = input
  const open = myPrs.filter((pr) => pr.state === 'open')
  return {
    waitingOnMe: queue ? queue.length : null,
    longestWaitHours: queue && queue.length > 0 ? Math.max(...queue.map((item) => item.waitingHours)) : null,
    releaseBlockers: queue ? queue.filter((item) => item.isReleaseBlocker).length : null,
    myOpenPrs: open.length,
    myStalePrs: open.filter((pr) => pr.flags.stale).length,
    deploys: deployDays ? deployDays.reduce((sum, d) => sum + d.success + d.failed + d.pending, 0) : null,
    failedDeploys: deployDays ? deployDays.reduce((sum, d) => sum + d.failed, 0) : null,
  }
}

/** Keeps only PRs from one repository ("owner/name"); null keeps all. */
export function inRepo<T extends PrSummary>(prs: T[], repoFullName: string | null): T[] {
  return repoFullName === null ? prs : prs.filter((pr) => pr.repo === repoFullName)
}
