import type { WaitingOnItem } from 'shared'
import { OVERLOAD_THRESHOLD } from '../../lib/constants'
import { listWaitingOnRows, type WaitingOnRow } from '../../db/waiting'

export function buildWaitingOn(rows: WaitingOnRow[]): WaitingOnItem[] {
  const byPr = new Map<number, WaitingOnRow[]>()
  for (const row of rows) {
    const prId = Number(row.pr_id)
    const bucket = byPr.get(prId) ?? []
    bucket.push(row)
    byPr.set(prId, bucket)
  }

  return [...byPr.entries()].map(([prId, prRows]) => {
    const hasRequest = prRows.some((r) => r.login !== null)
    if (!hasRequest) {
      return { prId, noReviewerRequested: true, reviewers: [] }
    }
    const reviewers = prRows
      .filter((r) => r.login !== null)
      .map((r) => ({
        login: r.login!,
        waitingHours: r.waiting_hours ?? 0,
        openRequests: r.open_requests ?? 0,
        overloaded: (r.open_requests ?? 0) >= OVERLOAD_THRESHOLD,
      }))
      .sort((a, b) => b.waitingHours - a.waitingHours)
    return { prId, noReviewerRequested: false, reviewers }
  })
}

export async function getWaitingOn(userId: number): Promise<WaitingOnItem[]> {
  return buildWaitingOn(await listWaitingOnRows(userId))
}
