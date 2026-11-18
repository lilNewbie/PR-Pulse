// US-18: map database rows to the shared BottleneckResponse contract.
import type { BottleneckResponse } from 'shared'
import { computeFlags } from '../../flags'
import { OVERLOAD_THRESHOLD } from '../../lib/constants'
import {
  canAccessBottleneckRepo,
  listBottleneckPrRows,
  listReviewerLoadRows,
} from '../../db/bottlenecks'

const HOUR_MS = 60 * 60 * 1000

type BottleneckResult =
  | { status: 'forbidden' }
  | { status: 'ok'; body: BottleneckResponse }

export async function getTeamBottlenecks(
  userId: number,
  repoId?: number,
  now = new Date(),
): Promise<BottleneckResult> {
  if (repoId !== undefined && !(await canAccessBottleneckRepo(userId, repoId))) {
    return { status: 'forbidden' }
  }

  const [reviewerRows, prRows] = await Promise.all([
    listReviewerLoadRows(userId, repoId),
    listBottleneckPrRows(userId, repoId),
  ])

  const reviewers: BottleneckResponse['reviewers'] = reviewerRows
    .map((row) => {
      const openRequests = Number(row.open_requests)
      const oldestWaitHours = row.oldest_requested_at === null
        ? null
        : Math.max(0, Math.floor(
            (now.getTime() - new Date(row.oldest_requested_at).getTime()) / HOUR_MS,
          ))
      return {
        login: row.login,
        role: row.role,
        openRequests,
        oldestWaitHours,
        overloaded: openRequests >= OVERLOAD_THRESHOLD,
      }
    })
    .sort((a, b) =>
      b.openRequests - a.openRequests ||
      (b.oldestWaitHours ?? -1) - (a.oldestWaitHours ?? -1) ||
      a.login.localeCompare(b.login),
    )

  const stalePrs: BottleneckResponse['stalePrs'] = prRows
    .map((pr) => {
      const flags = computeFlags(pr, now)
      return {
        isStale: flags.stale,
        item: {
          id: Number(pr.id),
          repo: pr.repo_full_name,
          number: pr.number,
          title: pr.title,
          url: `https://github.com/${pr.repo_full_name}/pull/${pr.number}`,
          authorLogin: pr.author_login,
          state: pr.state,
          isDraft: pr.is_draft,
          linesChanged: pr.lines_changed,
          flags,
          inactiveHours: flags.inactiveHours,
        },
      }
    })
    .filter((entry) => entry.isStale)
    .map((entry) => entry.item)
    .sort((a, b) => b.inactiveHours - a.inactiveHours || a.id - b.id)

  return {
    status: 'ok',
    body: {
      reviewers,
      stalePrs,
      totals: {
        openPrs: prRows.length,
        openRequests: prRows.reduce((sum, pr) => sum + Number(pr.open_requests), 0),
        stalePrs: stalePrs.length,
      },
    },
  }
}
