// Owned by Mandaar. SQL used by the PR Sync Service, the only writer of PR data.
import pool from './pool'

// Open PRs in a repo that target a base branch. A push to that branch re-checks each of them (US-09 AC1).
export async function listOpenPrNumbersByBaseRef(repoId: number, baseRef: string): Promise<number[]> {
  const { rows } = await pool.query<{ number: number }>(
    `SELECT number FROM pull_requests
     WHERE repo_id = $1 AND base_ref = $2 AND state = 'open'
     ORDER BY number`,
    [repoId, baseRef],
  )
  return rows.map((r) => r.number)
}
