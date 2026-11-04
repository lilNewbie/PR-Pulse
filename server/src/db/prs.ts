
import pool from './pool'
import type {
  PrRow,
  QueueRow,
  PrDetailRow,
  ReviewRequestRow,
  LatestReviewRow,
} from './types'

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

  const { has_access: _hasAccess, ...prRow } = pr
  void _hasAccess

  return prRow
}

/**
 * Retrieves PR details and the author's login.
 *
 * LEFT JOIN ensures authors without a users row
 * are still included.
 *
 * Falls back to the author's GitHub ID as text.
 *
 * The caller must verify repository access first.
 */
export async function getPrDetailRow(
  prId: number,
): Promise<PrDetailRow | null> {
  const { rows } = await pool.query<PrDetailRow>(
    `
    SELECT
      p.*,
      r.owner || '/' || r.name AS repo_full_name,
      COALESCE(
        u.login,
        p.author_github_id::text
      ) AS author_login
    FROM pull_requests p
    JOIN repos r
      ON r.id = p.repo_id
    LEFT JOIN users u
      ON u.github_id = p.author_github_id
    WHERE p.id = $1
    LIMIT 1
    `,
    [prId],
  )

  return rows[0] ?? null
}

/**
 * Retrieves review requests for a PR.
 *
 * LEFT JOIN preserves reviewers who have not
 * signed into PR Pulse.
 *
 * Falls back to their GitHub ID as text.
 *
 * requested_at reflects the latest request or
 * re-request timestamp stored by sync.
 *
 * The caller must verify repository access first.
 */
export async function listReviewRequests(
  prId: number,
): Promise<ReviewRequestRow[]> {
  const { rows } = await pool.query<ReviewRequestRow>(
    `
    SELECT
      COALESCE(
        u.login,
        rr.reviewer_github_id::text
      ) AS reviewer_login,
      rr.requested_at
    FROM review_requests rr
    LEFT JOIN users u
      ON u.github_id = rr.reviewer_github_id
    WHERE rr.pr_id = $1
    ORDER BY
      rr.requested_at ASC,
      rr.reviewer_github_id ASC
    `,
    [prId],
  )

  return rows
}

/**
 * Returns one meaningful review per reviewer.
 *
 * Rules:
 * 1. Prefer the most recent 'approved' or
 *    'changes_requested' review.
 * 2. If no decision review exists, return the
 *    most recent 'commented' review.
 * 3. A later comment does not override an approval
 *    or a changes-requested decision.
 * 4. Exclude pending, dismissed, and incomplete reviews.
 * 5. Preserve reviewers without a users row by
 *    falling back to their GitHub ID as text.
 *
 * The caller must verify repository access first.
 */
export async function listLatestReviews(
  prId: number,
): Promise<LatestReviewRow[]> {
  const { rows } = await pool.query<LatestReviewRow>(
    `
    SELECT DISTINCT ON (rv.reviewer_github_id)
      COALESCE(
        u.login,
        rv.reviewer_github_id::text
      ) AS reviewer_login,
      rv.state,
      rv.submitted_at
    FROM reviews rv
    LEFT JOIN users u
      ON u.github_id = rv.reviewer_github_id
    WHERE rv.pr_id = $1
      AND rv.reviewer_github_id IS NOT NULL
      AND rv.state IN (
        'approved',
        'changes_requested',
        'commented'
      )
      AND rv.submitted_at IS NOT NULL
    ORDER BY
      rv.reviewer_github_id,
      CASE
        WHEN rv.state IN (
          'approved',
          'changes_requested'
        ) THEN 0
        ELSE 1
      END,
      rv.submitted_at DESC,
      rv.id DESC
    `,
    [prId],
  )

  return rows
}
