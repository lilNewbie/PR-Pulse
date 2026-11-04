
import pool from './pool'
import type { PrRow, QueueRow } from './types'

/**
 * Returns open, non-draft PRs assigned to the user
 * for review in repositories they can access.
 *
 * Ordering:
 * 1. Oldest review request first
 * 2. Fewest lines changed first
 * 3. PR ID for deterministic ties
 */
export async function listQueueRows(
  userId: number,
): Promise<QueueRow[]> {
  const { rows } = await pool.query<QueueRow>(
    `
    SELECT
      p.*,
      r.owner || '/' || r.name AS repo_full_name,
      rr.requested_at,
      r.sync_status,
      r.last_synced_at
    FROM pull_requests p
    JOIN repos r
      ON r.id = p.repo_id
    JOIN review_requests rr
      ON rr.pr_id = p.id
    JOIN users u
      ON u.github_id = rr.reviewer_github_id
    WHERE u.id = $1
      AND p.state = 'open'
      AND p.is_draft = false
      AND EXISTS (
        SELECT 1
        FROM repo_access ra
        WHERE ra.user_id = $1
          AND ra.repo_id = p.repo_id
      )
    ORDER BY
      rr.requested_at ASC,
      p.lines_changed ASC NULLS LAST,
      p.id ASC
    `,
    [userId],
  )

  return rows
}

/**
 * Returns only open PRs authored by the current user.
 *
 * Draft PRs are included.
 * Closed and merged PRs are excluded.
 *
 * Repository access is enforced.
 */
export async function listMyPrs(
  userId: number,
): Promise<PrRow[]> {
  const { rows } = await pool.query<PrRow>(
    `
    SELECT
      p.*,
      r.owner || '/' || r.name AS repo_full_name
    FROM pull_requests p
    JOIN repos r
      ON r.id = p.repo_id
    JOIN users u
      ON u.github_id = p.author_github_id
    WHERE u.id = $1
      AND p.state = 'open'
      AND EXISTS (
        SELECT 1
        FROM repo_access ra
        WHERE ra.user_id = $1
          AND ra.repo_id = p.repo_id
      )
    ORDER BY
      p.github_updated_at DESC,
      p.id DESC
    `,
    [userId],
  )

  return rows
}

/**
 * Fetches a PR and enforces repository access.
 *
 * Returns:
 * - PrRow       : PR exists and user has access
 * - 'forbidden' : PR exists but user lacks access
 * - 'not_found' : PR does not exist
 *
 * The API route can map these results to:
 * - 200 OK
 * - 403 Forbidden
 * - 404 Not Found
 */
export async function getPrForUser(
  userId: number,
  prId: number,
): Promise<PrRow | 'forbidden' | 'not_found'> {
  const { rows } = await pool.query<
    PrRow & { has_access: boolean }
  >(
    `
    SELECT
      p.*,
      r.owner || '/' || r.name AS repo_full_name,
      EXISTS (
        SELECT 1
        FROM repo_access ra
        WHERE ra.user_id = $1
          AND ra.repo_id = p.repo_id
      ) AS has_access
    FROM pull_requests p
    JOIN repos r
      ON r.id = p.repo_id
    WHERE p.id = $2
    LIMIT 1
    `,
    [userId, prId],
  )

  const pr = rows[0]

  if (!pr) {
    return 'not_found'
  }

  if (!pr.has_access) {
    return 'forbidden'
  }

  // Exclude the internal access-check field
  // from the returned PR data.
  const { has_access: _hasAccess, ...prRow } = pr
  void _hasAccess

  return prRow
}
