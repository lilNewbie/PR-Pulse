// Owned by Kaushik. US-15 reads only: file_touches is written by the PR Sync Service.
import type { ExpertiseArea } from 'shared'
import pool from './pool'

export const MAX_AREAS = 10

// The repo, if the user has repo_access to it; null otherwise (unknown repos included).
export async function findAccessibleRepo(
  userId: number,
  repoId: number,
): Promise<{ id: number; fullName: string } | null> {
  const { rows } = await pool.query<{ id: string; full_name: string }>(
    `SELECT r.id, r.owner || '/' || r.name AS full_name
     FROM repos r
     JOIN repo_access ra ON ra.repo_id = r.id
     WHERE ra.user_id = $1 AND r.id = $2`,
    [userId, repoId],
  )
  return rows[0] ? { id: Number(rows[0].id), fullName: rows[0].full_name } : null
}

// design-final 5.4. An area is the file's directory cut to its first two segments:
// src/auth/session.ts -> src/auth, src/index.ts -> src, README.md -> /.
// Per area: distinct commits and the latest commit date. Newest first, then most commits; at most 10.
// GitHub logins are case-insensitive, so the login match is too.
export async function getExpertise(githubLogin: string, repoId: number): Promise<ExpertiseArea[]> {
  const { rows } = await pool.query<{ area: string; commits: number; last_commit_at: Date }>(
    `SELECT area, COUNT(DISTINCT commit_sha)::int AS commits, MAX(committed_at) AS last_commit_at
     FROM (
       SELECT commit_sha, committed_at,
         CASE
           WHEN strpos(path, '/') = 0 THEN '/'
           WHEN strpos(substr(path, strpos(path, '/') + 1), '/') = 0 THEN split_part(path, '/', 1)
           ELSE split_part(path, '/', 1) || '/' || split_part(path, '/', 2)
         END AS area
       FROM file_touches
       WHERE repo_id = $1 AND lower(author_login) = lower($2)
     ) t
     GROUP BY area
     ORDER BY last_commit_at DESC, commits DESC, area ASC
     LIMIT ${MAX_AREAS}`,
    [repoId, githubLogin],
  )
  return rows.map((row) => ({
    area: row.area,
    commits: row.commits,
    lastCommitAt: row.last_commit_at.toISOString(),
  }))
}
