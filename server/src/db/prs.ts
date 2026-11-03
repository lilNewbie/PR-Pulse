
import pool from './pool'
import type { PrRow, QueueRow } from './types'

/**
 * Returns open pull requests assigned to the user for review.
 *
 * Security:
 * - User must have repository access.
 * - Review request must match the user's GitHub ID.
 *
 * Ordering:
 * - Oldest review requests first.
 * - Fewest lines changed first for equal timestamps.
 * - PR ID as a deterministic final tie-breaker.
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
 * Returns PRs authored by the current GitHub user,
 * restricted to repositories they can access.
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
 * Returns one PR only if the requesting user
 * has access to its repository.
 *
 * Returns null when the PR does not exist
 * or is inaccessible.
 */
export async function getPrForUser(
  userId: number,
  prId: number,
): Promise<PrRow | null> {
  const { rows } = await pool.query<PrRow>(
    `
    SELECT
      p.*,
      r.owner || '/' || r.name AS repo_full_name
    FROM pull_requests p
    JOIN repos r
      ON r.id = p.repo_id
    WHERE p.id = $2
      AND EXISTS (
        SELECT 1
        FROM repo_access ra
        WHERE ra.user_id = $1
          AND ra.repo_id = p.repo_id
      )
    LIMIT 1
    `,
    [userId, prId],
  )

  return rows[0] ?? null
}
