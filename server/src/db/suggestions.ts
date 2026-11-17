// Owned by Mandaar. Reviewer suggestions (US-11, design-final 5.2). Reads only.
import pool from './pool'
import type { PrRow } from './types'

// One row per file of a PR where the user is the suggested reviewer.
export interface SuggestionRow extends PrRow {
  author_login: string
  review_requested: boolean
  path: string
  last_commit_at: Date
}

// For each changed file of each open, non-draft PR the user can access and didn't author, the suggested
// reviewer is the most recent committer to that file who is a member of the repo's team with role reviewer
// or lead, isn't the PR's author and isn't a bot. Non-members and PR Authors are skipped in favour of the
// next most recent (US-11 AC4, AC5; DR-03). Returns the files where that reviewer is this user.
export async function listSuggestionRows(userId: number): Promise<SuggestionRow[]> {
  const { rows } = await pool.query<SuggestionRow>(
    `WITH me AS (
       SELECT id, github_id FROM users WHERE id = $1
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
       winner.committed_at AS last_commit_at
     FROM candidates c
     JOIN pr_files f ON f.pr_id = c.id
     CROSS JOIN LATERAL (
       SELECT u.id AS user_id, ft.committed_at
       FROM file_touches ft
       JOIN users u ON lower(u.login) = lower(ft.author_login)
       JOIN members m ON m.user_id = u.id AND m.team_id = c.team_id AND m.role IN ('reviewer', 'lead')
       WHERE ft.repo_id = c.repo_id
         AND ft.path = f.path
         AND ft.author_login NOT LIKE '%[bot]'
         AND u.github_id <> c.author_github_id
       ORDER BY ft.committed_at DESC, ft.commit_sha
       LIMIT 1
     ) winner
     LEFT JOIN users author ON author.github_id = c.author_github_id
     WHERE winner.user_id = $1
     ORDER BY winner.committed_at DESC, c.id, f.path`,
    [userId],
  )
  return rows
}
