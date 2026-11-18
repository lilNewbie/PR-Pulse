// US-18: all SQL for the Lead's team bottleneck view lives in the data-access layer.
import type { Role } from 'shared'
import pool from './pool'
import type { PrRow } from './types'

export interface ReviewerLoadRow {
  login: string
  role: Role
  open_requests: number
  oldest_requested_at: Date | null
}

export interface BottleneckPrRow extends PrRow {
  author_login: string
  open_requests: number
}

/**
 * Explicit repository selection must not leak whether the repo contains PRs.
 * Check access independently of the results, including for an empty repo.
 */
export async function canAccessBottleneckRepo(
  userId: number,
  repoId: number,
): Promise<boolean> {
  const { rows } = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM repo_access
       WHERE user_id = $1 AND repo_id = $2
     ) AS allowed`,
    [userId, repoId],
  )
  return rows[0]?.allowed ?? false
}

/**
 * Include every Lead/Reviewer in a team with an accessible connected repo,
 * including members with no active review requests (LEFT JOIN).
 * Count only requests for open, non-draft PRs in connected, accessible repos.
 */
export async function listReviewerLoadRows(
  userId: number,
  repoId?: number,
): Promise<ReviewerLoadRow[]> {
  const { rows } = await pool.query<ReviewerLoadRow>(
    `WITH visible_repos AS (
       SELECT r.id, r.team_id
       FROM repos r
       JOIN repo_access ra ON ra.repo_id = r.id
       WHERE ra.user_id = $1
         AND r.status = 'connected'
         AND ($2::bigint IS NULL OR r.id = $2)
     ),
     eligible_reviewers AS (
       SELECT DISTINCT ON (u.id)
         u.id, u.github_id, u.login, m.role
       FROM members m
       JOIN users u ON u.id = m.user_id
       WHERE m.role IN ('reviewer', 'lead')
         AND EXISTS (
           SELECT 1 FROM visible_repos vr
           WHERE vr.team_id = m.team_id
         )
       ORDER BY u.id,
         CASE WHEN m.role = 'lead' THEN 0 ELSE 1 END
     ),
     open_requests AS (
       SELECT rr.reviewer_github_id, rr.requested_at
       FROM review_requests rr
       JOIN pull_requests p ON p.id = rr.pr_id
       JOIN visible_repos vr ON vr.id = p.repo_id
       WHERE p.state = 'open'
         AND p.is_draft = false
     )
     SELECT er.login, er.role,
            COUNT(orr.reviewer_github_id)::integer AS open_requests,
            MIN(orr.requested_at) AS oldest_requested_at
     FROM eligible_reviewers er
     LEFT JOIN open_requests orr ON orr.reviewer_github_id = er.github_id
     GROUP BY er.id, er.login, er.role
     ORDER BY open_requests DESC, oldest_requested_at ASC NULLS LAST, er.login ASC`,
    [userId, repoId ?? null],
  )
  return rows
}

/**
 * Return only actionable PRs in connected repositories the Lead can access.
 * An open request is counted here even when the requested GitHub user is not
 * a member of the team; totals therefore reflect all active requests.
 * Leave stale detection to computeFlags in the module (not SQL).
 */
export async function listBottleneckPrRows(
  userId: number,
  repoId?: number,
): Promise<BottleneckPrRow[]> {
  const { rows } = await pool.query<BottleneckPrRow>(
    `SELECT p.*,
            r.owner || '/' || r.name AS repo_full_name,
            COALESCE(u.login, p.author_github_id::text) AS author_login,
            COUNT(rr.reviewer_github_id)::integer AS open_requests
     FROM pull_requests p
     JOIN repos r ON r.id = p.repo_id AND r.status = 'connected'
     JOIN repo_access ra ON ra.repo_id = r.id AND ra.user_id = $1
     LEFT JOIN users u ON u.github_id = p.author_github_id
     LEFT JOIN review_requests rr ON rr.pr_id = p.id
     WHERE p.state = 'open'
       AND p.is_draft = false
       AND ($2::bigint IS NULL OR p.repo_id = $2)
     GROUP BY p.id, r.owner, r.name, u.login
     ORDER BY p.id ASC`,
    [userId, repoId ?? null],
  )
  return rows
}
