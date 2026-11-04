import type { QueueRow } from '../../db/types'
import type { SessionUser } from '../../middleware/session'
import type { QueueItem } from 'shared'
import { computeFlags } from '../../flags/index'

export function rankQueue(rows: QueueRow[], me: SessionUser, now: Date): QueueItem[] {
  return rows
    .filter((r) => r.state === 'open' && !r.is_draft && r.author_github_id !== me.githubId)
    .sort((a, b) => {
      // Descending wait time (ascending requested_at)
      const reqDiff = a.requested_at.getTime() - b.requested_at.getTime()
      if (reqDiff !== 0) return reqDiff
      // Tie-break: ascending lines changed
      return a.lines_changed - b.lines_changed
    })
    .map((r, i) => ({
      id: r.id,
      repo: r.repo_full_name,
      number: r.number,
      title: r.title,
      url: `https://github.com/${r.repo_full_name}/pull/${r.number}`,
      authorLogin: String(r.author_github_id),
      state: r.state,
      isDraft: r.is_draft,
      linesChanged: r.lines_changed,
      flags: computeFlags(r, now),
      waitingHours: Math.floor((now.getTime() - r.requested_at.getTime()) / (1000 * 60 * 60)),
      position: i + 1,
    }))
}
