// Owned by Mandaar. SQL used by the PR Sync Service, the only writer of PR data.
import type { PoolClient } from 'pg'
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

export async function listOpenPrNumbers(repoId: number): Promise<number[]> {
  const { rows } = await pool.query<{ number: number }>(
    "SELECT number FROM pull_requests WHERE repo_id = $1 AND state = 'open' ORDER BY number",
    [repoId],
  )
  return rows.map((r) => r.number)
}

// ---- Repo sync state (the sync's own columns on repos) ----

export interface SyncRepo {
  id: number
  owner: string
  name: string
  connectedBy: number | null
  retryAfter: Date | null
  lastSyncedAt: Date | null
}

export async function getSyncRepo(repoId: number): Promise<SyncRepo | null> {
  const { rows } = await pool.query<{
    id: string
    owner: string
    name: string
    connected_by: string | null
    retry_after: Date | null
    last_synced_at: Date | null
  }>('SELECT id, owner, name, connected_by, retry_after, last_synced_at FROM repos WHERE id = $1', [repoId])
  const r = rows[0]
  if (!r) return null
  return {
    id: Number(r.id),
    owner: r.owner,
    name: r.name,
    connectedBy: r.connected_by === null ? null : Number(r.connected_by),
    retryAfter: r.retry_after,
    lastSyncedAt: r.last_synced_at,
  }
}

// Successful sync, in the same transaction as the PR writes. Returns the new last_synced_at.
export async function markSyncOk(client: PoolClient, repoId: number, markConnected: boolean): Promise<Date> {
  const { rows } = await client.query<{ last_synced_at: Date }>(
    `UPDATE repos
     SET sync_status = 'ok', last_synced_at = now(), retry_after = NULL,
         status = CASE WHEN $2 THEN 'connected' ELSE status END
     WHERE id = $1
     RETURNING last_synced_at`,
    [repoId, markConnected],
  )
  return rows[0].last_synced_at
}

// Failed sync: PR rows and last_synced_at stay as they were.
export async function markSyncFailed(
  repoId: number,
  status: 'rate_limited' | 'failed',
  retryAfter: Date | null,
): Promise<void> {
  await pool.query('UPDATE repos SET sync_status = $2, retry_after = $3 WHERE id = $1', [repoId, status, retryAfter])
}

// ---- PR writes ----

export interface PrSnapshot {
  number: number
  title: string
  authorGithubId: number
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  linesChanged: number
  lastActivityAt: Date
  githubUpdatedAt: Date
  createdAt: Date
  mergeable: boolean | null
  behindBy: number
  baseRef: string
  mergeCommitSha: string | null
  mergedAt: Date | null
  requestedReviewerIds: number[]
  reviews: { githubReviewId: number; reviewerGithubId: number | null; state: string; submittedAt: Date }[]
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// Lock-and-compare upsert (design 1.1). Must run inside a transaction.
// Returns false, writing nothing, when the stored row is newer than the snapshot.
export async function upsertPr(client: PoolClient, repoId: number, s: PrSnapshot): Promise<boolean> {
  const { rows: existing } = await client.query<{ id: string; github_updated_at: Date }>(
    'SELECT id, github_updated_at FROM pull_requests WHERE repo_id = $1 AND number = $2 FOR UPDATE',
    [repoId, s.number],
  )
  if (existing[0] && s.githubUpdatedAt < existing[0].github_updated_at) return false

  // ON CONFLICT covers a row inserted by another writer since the SELECT; the WHERE keeps the compare rule.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO pull_requests
       (repo_id, number, title, author_github_id, state, is_draft, ready_at, lines_changed,
        last_activity_at, github_updated_at, mergeable, behind_by, base_ref, merge_commit_sha, merged_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 THEN NULL ELSE $15::timestamptz END, $7,
             $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (repo_id, number) DO UPDATE SET
       title = EXCLUDED.title,
       author_github_id = EXCLUDED.author_github_id,
       state = EXCLUDED.state,
       is_draft = EXCLUDED.is_draft,
       ready_at = CASE WHEN EXCLUDED.is_draft THEN NULL
                       ELSE COALESCE(pull_requests.ready_at, EXCLUDED.github_updated_at) END,
       lines_changed = EXCLUDED.lines_changed,
       last_activity_at = GREATEST(pull_requests.last_activity_at, EXCLUDED.last_activity_at),
       github_updated_at = EXCLUDED.github_updated_at,
       mergeable = EXCLUDED.mergeable,
       behind_by = EXCLUDED.behind_by,
       base_ref = EXCLUDED.base_ref,
       merge_commit_sha = EXCLUDED.merge_commit_sha,
       merged_at = EXCLUDED.merged_at
     WHERE pull_requests.github_updated_at <= EXCLUDED.github_updated_at
     RETURNING id`,
    [
      repoId, s.number, s.title, s.authorGithubId, s.state, s.isDraft, s.linesChanged,
      s.lastActivityAt, s.githubUpdatedAt, s.mergeable, s.behindBy, s.baseRef, s.mergeCommitSha, s.mergedAt,
      s.createdAt,
    ],
  )
  if (!rows[0]) return false
  const prId = Number(rows[0].id)

  // Review requests are the current set on GitHub. A reviewer who stays keeps their requested_at;
  // a new or re-requested one (e.g. after reviewing) gets a fresh one (US-02 AC1, AC2).
  await client.query(
    'DELETE FROM review_requests WHERE pr_id = $1 AND NOT (reviewer_github_id = ANY($2::bigint[]))',
    [prId, s.requestedReviewerIds],
  )
  await client.query(
    `INSERT INTO review_requests (pr_id, reviewer_github_id, requested_at)
     SELECT $1, unnest($2::bigint[]), now()
     ON CONFLICT (pr_id, reviewer_github_id) DO NOTHING`,
    [prId, s.requestedReviewerIds],
  )

  // Reviews: the submitted ones on GitHub. Pending and dismissed ones are not kept.
  const reviewIds = s.reviews.map((r) => r.githubReviewId)
  await client.query('DELETE FROM reviews WHERE pr_id = $1 AND NOT (github_review_id = ANY($2::bigint[]))', [
    prId,
    reviewIds,
  ])
  for (const r of s.reviews) {
    await client.query(
      `INSERT INTO reviews (github_review_id, pr_id, reviewer_github_id, state, submitted_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_review_id) DO UPDATE SET state = EXCLUDED.state, submitted_at = EXCLUDED.submitted_at`,
      [r.githubReviewId, prId, r.reviewerGithubId, r.state, r.submittedAt],
    )
  }
  return true
}
