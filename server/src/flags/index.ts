import type { Flags } from 'shared'
import type { PrRow } from '../db/types'

// Owned by Mandaar. Pure function, no DB or HTTP access (DR-04: flags are computed on read).

const HOUR_MS = 60 * 60 * 1000
export const STALE_AFTER_HOURS = 24

export function computeFlags(pr: PrRow, now: Date): Flags {
  // Whole hours since the last commit, comment or review. Never negative (clock skew).
  const inactiveMs = now.getTime() - new Date(pr.last_activity_at).getTime()
  const inactiveHours = Math.max(0, Math.floor(inactiveMs / HOUR_MS))

  return {
    // Only open, ready-for-review PRs go stale; drafts, merged and closed PRs never do (US-08).
    stale: pr.state === 'open' && !pr.is_draft && inactiveHours >= STALE_AFTER_HOURS,
    inactiveHours,
    // mergeable null means GitHub is still computing it (US-09 AC4).
    conflict: pr.mergeable === null ? 'checking' : pr.mergeable ? 'no' : 'yes',
    behindBy: pr.behind_by,
  }
}
