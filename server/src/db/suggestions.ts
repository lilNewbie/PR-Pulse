// Owned by Mandaar. Reviewer suggestions (US-11 design-final 5.2; US-19, US-20 design-extension 4.1, 4.2).
import pool from './pool'
import type { PrRow } from './types'

// One row per file of a PR where the user is the suggested reviewer.
export interface SuggestionRow extends PrRow {
  author_login: string
  review_requested: boolean
  path: string
  last_commit_at: Date
  open_requests: number
}

// How long a dismissal hides a directory (design-extension 4.2).
export const DISMISS_DAYS = 30

// Directory of a path (design-extension 1): 'src/auth/session.ts' -> 'src/auth', 'README.md' -> '/'.
// directorySql is the same rule as a SQL expression over a path column; keep the two in step.
export function directoryOf(path: string): string {
  if (!path.includes('/')) return '/'
  return path.replace(/\/[^/]*$/, '') || '/'
}
const directorySql = (path: string) =>
  `CASE WHEN strpos(${path}, '/') = 0 THEN '/' ELSE COALESCE(NULLIF(regexp_replace(${path}, '/[^/]*$', ''), ''), '/') END`

// For each changed file of each open, non-draft PR the user can access and didn't author, the eligible touchers
// are committers to that file who are members of the repo's team with role reviewer or lead, aren't the PR's
// author and aren't bots (US-11 AC4, AC5; DR-03). Of the 3 most recent distinct eligible touchers, the suggested
// reviewer is the one with the fewest open requests; ties go to the most recent (US-19, design-extension 4.1).
// A toucher who dismissed the file's directory in that repo within DISMISS_DAYS isn't eligible for it, so the
// next eligible toucher can win instead (US-20, design-extension 4.2). Returns the files where the reviewer is
// this user.
//
// Open requests are counted once for everyone, in the `load` CTE. They span every connected repo, not only the
// caller's, so every caller sees the same load for a teammate and agrees on who wins each file.
export async function listSuggestionRows(userId: number): Promise<SuggestionRow[]> {
  const { rows } = await pool.query<SuggestionRow>(
    `WITH me AS (
       SELECT id, github_id FROM users WHERE id = $1
     ),
     load AS (
       SELECT rr.reviewer_github_id, COUNT(*)::int AS open_requests
       FROM review_requests rr
       JOIN pull_requests p ON p.id = rr.pr_id
       JOIN repos r ON r.id = p.repo_id AND r.status = 'connected'
       WHERE p.state = 'open' AND p.is_draft = false
       GROUP BY rr.reviewer_github_id
     ),
     candidates AS (
       SELECT p.*, r.owner || '/' || r.name AS repo_full_name, r.team_id
       FROM pull_requests p
       JOIN repos r ON r.id = p.repo_id
       JOIN repo_access ra ON ra.repo_id = p.repo_id AND ra.user_id = $1
       WHERE p.state = 'open'
         AND p.is_draft = false
         AND p.author_github_id <> (SELECT github_id FROM me)
     )
     SELECT
       c.id, c.repo_id, c.repo_full_name, c.number, c.title, c.author_github_id, c.state, c.is_draft,
       c.is_release_blocker, c.ready_at, c.lines_changed, c.last_activity_at, c.github_updated_at,
       c.mergeable, c.behind_by, c.base_ref, c.merge_commit_sha, c.merged_at,
       COALESCE(author.login, c.author_github_id::text) AS author_login,
       EXISTS (
         SELECT 1 FROM review_requests rr
         WHERE rr.pr_id = c.id AND rr.reviewer_github_id = (SELECT github_id FROM me)
       ) AS review_requested,
       f.path,
       winner.committed_at AS last_commit_at,
       winner.open_requests
     FROM candidates c
     JOIN pr_files f ON f.pr_id = c.id
     CROSS JOIN LATERAL (
       SELECT recent.user_id, recent.committed_at, COALESCE(l.open_requests, 0) AS open_requests
       FROM (
         SELECT u.id AS user_id, u.github_id, MAX(ft.committed_at) AS committed_at
         FROM file_touches ft
         JOIN users u ON lower(u.login) = lower(ft.author_login)
         JOIN members m ON m.user_id = u.id AND m.team_id = c.team_id AND m.role IN ('reviewer', 'lead')
         WHERE ft.repo_id = c.repo_id
           AND ft.path = f.path
           AND ft.author_login NOT LIKE '%[bot]'
           AND u.github_id <> c.author_github_id
           AND NOT EXISTS (
             SELECT 1 FROM suggestion_feedback sf
             WHERE sf.user_id = u.id
               AND sf.repo_id = c.repo_id
               AND sf.directory = ${directorySql('f.path')}
               AND sf.dismissed_at > now() - make_interval(days => ${DISMISS_DAYS})
           )
         GROUP BY u.id, u.github_id
         ORDER BY committed_at DESC, u.id
         LIMIT 3
       ) recent
       LEFT JOIN load l ON l.reviewer_github_id = recent.github_id
       ORDER BY COALESCE(l.open_requests, 0), recent.committed_at DESC, recent.user_id
       LIMIT 1
     ) winner
     LEFT JOIN users author ON author.github_id = c.author_github_id
     WHERE winner.user_id = $1
     ORDER BY winner.committed_at DESC, c.id, f.path`,
    [userId],
  )
  return rows
}

export interface DismissTarget {
  repo_id: string
  accessible: boolean
  has_path: boolean
}

// The PR's repo, whether the user can access it, and whether `path` is one of its changed files.
// Null when the PR doesn't exist.
export async function findDismissTarget(userId: number, prId: number, path: string): Promise<DismissTarget | null> {
  const { rows } = await pool.query<DismissTarget>(
    `SELECT p.repo_id,
       EXISTS (SELECT 1 FROM repo_access ra WHERE ra.user_id = $1 AND ra.repo_id = p.repo_id) AS accessible,
       EXISTS (SELECT 1 FROM pr_files f WHERE f.pr_id = p.id AND f.path = $3) AS has_path
     FROM pull_requests p
     WHERE p.id = $2`,
    [userId, prId, path],
  )
  return rows[0] ?? null
}

// Stores or refreshes a dismissal (design-extension 4.2: dismissing again refreshes dismissed_at).
export async function upsertDismissal(userId: number, repoId: number, directory: string): Promise<void> {
  await pool.query(
    `INSERT INTO suggestion_feedback (user_id, repo_id, directory, dismissed_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id, repo_id, directory) DO UPDATE SET dismissed_at = now()`,
    [userId, repoId, directory],
  )
}
