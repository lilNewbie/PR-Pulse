import pool from './pool'

// CTE fragment: counts open review requests per reviewer, scoped to repos the caller
// can access and that are connected. Import this into any query that needs reviewer
// load — do NOT copy the SQL inline; that's how waiting.ts and suggestions.ts drifted.
// $1 must be the caller's user id in every query that uses it.
export const LOAD_CTE = `load AS (
  SELECT rr.reviewer_github_id, COUNT(*)::int AS open_requests
  FROM review_requests rr
  JOIN pull_requests p ON p.id = rr.pr_id
  JOIN repos r ON r.id = p.repo_id AND r.status = 'connected'
  JOIN repo_access ra ON ra.repo_id = r.id AND ra.user_id = $1
  WHERE p.state = 'open' AND p.is_draft = false
  GROUP BY rr.reviewer_github_id
)`

export async function getOpenRequestCount(
  reviewerGithubId: number,
  callerUserId: number,
): Promise<number> {
  const { rows } = await pool.query<{ open_requests: number }>(
    `WITH ${LOAD_CTE}
     SELECT COALESCE(open_requests, 0) AS open_requests
     FROM load
     WHERE reviewer_github_id = $2`,
    [callerUserId, reviewerGithubId],
  )
  return rows[0]?.open_requests ?? 0
}
