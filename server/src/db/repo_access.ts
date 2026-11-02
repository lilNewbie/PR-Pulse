import pool from './pool'

const TEN_MINUTES_MS = 10 * 60 * 1000

export async function refreshRepoAccess(userId: number, githubRepoIds: number[]): Promise<void> {
  if (githubRepoIds.length === 0) {
    await pool.query('DELETE FROM repo_access WHERE user_id = $1', [userId])
    return
  }

  await pool.query(
    `DELETE FROM repo_access
     WHERE user_id = $1
       AND repo_id NOT IN (SELECT id FROM repos WHERE github_repo_id = ANY($2::bigint[]))`,
    [userId, githubRepoIds],
  )

  await pool.query(
    `INSERT INTO repo_access (user_id, repo_id, checked_at)
     SELECT $1, repos.id, now()
     FROM repos
     WHERE repos.github_repo_id = ANY($2::bigint[])
     ON CONFLICT (user_id, repo_id) DO UPDATE SET checked_at = now()`,
    [userId, githubRepoIds],
  )
}

export async function needsRepoRefresh(userId: number): Promise<boolean> {
  const { rows } = await pool.query<{ checked_at: Date | null }>(
    'SELECT MAX(checked_at) AS checked_at FROM repo_access WHERE user_id = $1',
    [userId],
  )
  const checkedAt = rows[0]?.checked_at
  if (!checkedAt) return true
  return Date.now() - checkedAt.getTime() > TEN_MINUTES_MS
}

export async function getUserAccessibleRepos(
  userId: number,
): Promise<{ id: number; fullName: string }[]> {
  const { rows } = await pool.query<{ id: number; full_name: string }>(
    `SELECT repos.id, repos.owner || '/' || repos.name AS full_name
     FROM repo_access
     JOIN repos ON repo_access.repo_id = repos.id
     WHERE repo_access.user_id = $1`,
    [userId],
  )
  return rows.map((r) => ({ id: r.id, fullName: r.full_name }))
}
