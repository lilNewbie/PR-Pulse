import pool from './pool'
import { LOAD_CTE } from './openRequests'

export interface WaitingOnRow {
  pr_id: string
  login: string | null
  waiting_hours: number | null
  open_requests: number | null
}

export async function listWaitingOnRows(userId: number): Promise<WaitingOnRow[]> {
  const { rows } = await pool.query<WaitingOnRow>(
    `WITH ${LOAD_CTE}
    SELECT
      p.id::text                                                           AS pr_id,
      COALESCE(u2.login, rr.reviewer_github_id::text)                     AS login,
      FLOOR(EXTRACT(EPOCH FROM (now() - rr.requested_at)) / 3600)::int    AS waiting_hours,
      COALESCE(l.open_requests, 0)                                        AS open_requests
    FROM pull_requests p
    JOIN repos r ON r.id = p.repo_id
    JOIN users u ON u.github_id = p.author_github_id
    LEFT JOIN review_requests rr ON rr.pr_id = p.id
    LEFT JOIN users u2 ON u2.github_id = rr.reviewer_github_id
    LEFT JOIN load l ON l.reviewer_github_id = rr.reviewer_github_id
    WHERE u.id = $1
      AND p.state = 'open'
      AND p.is_draft = false
      AND EXISTS (
        SELECT 1 FROM repo_access ra WHERE ra.user_id = $1 AND ra.repo_id = p.repo_id
      )
    ORDER BY p.id, waiting_hours DESC NULLS LAST
    `,
    [userId],
  )
  return rows
}
