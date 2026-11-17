import pool from './pool'
import type { DeploymentDetail } from 'shared'

export interface DeploymentForLink {
  id: number
  repo_id: number
  sha: string
  environment: 'staging' | 'production'
  status: 'pending' | 'success' | 'failed'
  created_at: Date
  owner: string
  name: string
  connected_by: number | null
}

// Load deployment with its repo info (owner/name/token owner) for linkDeployment
export async function getDeploymentWithRepo(deploymentId: number): Promise<DeploymentForLink | null> {
  const { rows } = await pool.query<DeploymentForLink>(
    `SELECT d.id, d.repo_id, d.sha, d.environment, d.status, d.created_at,
            r.owner, r.name, r.connected_by
     FROM deployments d
     JOIN repos r ON r.id = d.repo_id
     WHERE d.id = $1`,
    [deploymentId],
  )
  return rows[0] ?? null
}

// Most recent earlier success deployment for the same repo+environment
export async function getPreviousSuccessDeployment(
  repoId: number,
  environment: 'staging' | 'production',
  beforeCreatedAt: Date,
): Promise<{ id: number; sha: string } | null> {
  const { rows } = await pool.query<{ id: string; sha: string }>(
    `SELECT id, sha FROM deployments
     WHERE repo_id = $1 AND environment = $2 AND status = 'success' AND created_at < $3
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [repoId, environment, beforeCreatedAt],
  )
  if (!rows[0]) return null
  return { id: Number(rows[0].id), sha: rows[0].sha }
}

// Replace all deployment_prs for a deployment atomically (idempotent)
export async function replaceDeploymentPrs(deploymentId: number, prIds: number[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM deployment_prs WHERE deployment_id = $1', [deploymentId])
    if (prIds.length > 0) {
      const placeholders = prIds.map((_, i) => `($1, $${i + 2})`).join(', ')
      await client.query(
        `INSERT INTO deployment_prs (deployment_id, pr_id) VALUES ${placeholders}`,
        [deploymentId, ...prIds],
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

// Find merged PRs whose merge_commit_sha is in the given list
export async function findPrsByMergeCommits(
  repoId: number,
  shas: string[],
): Promise<{ id: number }[]> {
  if (shas.length === 0) return []
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM pull_requests
     WHERE repo_id = $1 AND state = 'merged' AND merge_commit_sha = ANY($2)`,
    [repoId, shas],
  )
  return rows.map((r) => ({ id: Number(r.id) }))
}

export interface UpsertDeploymentInput {
  repoId: number
  sha: string
  environment: 'staging' | 'production'
  status: 'pending' | 'success' | 'failed'
  source: 'manual' | 'webhook'
  externalIdentifier?: string | null
  recordedBy?: number | null
}

// Upsert on (repo_id, sha, environment); on conflict updates status (webhook pattern)
export async function upsertDeployment(input: UpsertDeploymentInput): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO deployments
       (repo_id, sha, environment, status, source, external_identifier, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT deployments_repo_sha_env_unique
     DO UPDATE SET
       status = EXCLUDED.status,
       external_identifier = COALESCE(EXCLUDED.external_identifier, deployments.external_identifier)
     RETURNING id`,
    [
      input.repoId, input.sha, input.environment, input.status,
      input.source, input.externalIdentifier ?? null, input.recordedBy ?? null,
    ],
  )
  return Number(rows[0].id)
}

export class DuplicateDeploymentError extends Error {
  constructor() {
    super('A deployment for this sha and environment already exists')
    this.name = 'DuplicateDeploymentError'
  }
}

// Plain insert for manual POST — throws DuplicateDeploymentError on conflict
export async function insertManualDeployment(input: {
  repoId: number
  sha: string
  environment: 'staging' | 'production'
  recordedBy: number
}): Promise<number> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO deployments (repo_id, sha, environment, status, source, recorded_by)
       VALUES ($1, $2, $3, 'pending', 'manual', $4)
       RETURNING id`,
      [input.repoId, input.sha, input.environment, input.recordedBy],
    )
    return Number(rows[0].id)
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DuplicateDeploymentError()
    throw err
  }
}

export type DeploymentDetailResult =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'ok'; detail: DeploymentDetail }

// Fetch deployment detail with repo-access check
export async function getDeploymentDetail(
  userId: number,
  deploymentId: number,
): Promise<DeploymentDetailResult> {
  const { rows } = await pool.query<{
    id: string
    repo_id: string
    sha: string
    environment: 'staging' | 'production'
    status: 'pending' | 'success' | 'failed'
    source: 'manual' | 'webhook'
    created_at: Date
    has_access: boolean
  }>(
    `SELECT d.id, d.repo_id, d.sha, d.environment, d.status, d.source, d.created_at,
            EXISTS (
              SELECT 1 FROM repo_access ra
              WHERE ra.user_id = $1 AND ra.repo_id = d.repo_id
            ) AS has_access
     FROM deployments d
     WHERE d.id = $2`,
    [userId, deploymentId],
  )

  const dep = rows[0]
  if (!dep) return { status: 'not_found' }
  if (!dep.has_access) return { status: 'forbidden' }

  const [prevRows, prRows] = await Promise.all([
    pool.query<{ id: string }>(
      `SELECT id FROM deployments
       WHERE repo_id = $1 AND environment = $2 AND status = 'success' AND created_at < $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [Number(dep.repo_id), dep.environment, dep.created_at],
    ),
    pool.query<{
      number: number
      title: string
      author_login: string
      merged_at: Date | null
      repo_full_name: string
    }>(
      `SELECT p.number, p.title,
              COALESCE(u.login, p.author_github_id::text) AS author_login,
              p.merged_at,
              r.owner || '/' || r.name AS repo_full_name
       FROM deployment_prs dp
       JOIN pull_requests p ON p.id = dp.pr_id
       JOIN repos r ON r.id = p.repo_id
       LEFT JOIN users u ON u.github_id = p.author_github_id
       WHERE dp.deployment_id = $1
       ORDER BY p.merged_at ASC NULLS LAST, p.number ASC`,
      [deploymentId],
    ),
  ])

  return {
    status: 'ok',
    detail: {
      id: Number(dep.id),
      sha: dep.sha,
      environment: dep.environment,
      status: dep.status,
      source: dep.source,
      createdAt: dep.created_at.toISOString(),
      prCount: prRows.rows.length,
      previousDeploymentId: prevRows.rows[0] ? Number(prevRows.rows[0].id) : null,
      prs: prRows.rows.map((pr) => ({
        number: pr.number,
        title: pr.title,
        authorLogin: pr.author_login,
        mergedAt: pr.merged_at?.toISOString() ?? '',
        url: `https://github.com/${pr.repo_full_name}/pull/${pr.number}`,
      })),
    },
  }
}

// Deployments that have a previous success deploy but no linked PRs — eligible for retry
export async function listUnlinkedDeploymentIds(): Promise<number[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT d.id FROM deployments d
     WHERE NOT EXISTS (SELECT 1 FROM deployment_prs dp WHERE dp.deployment_id = d.id)
       AND EXISTS (
         SELECT 1 FROM deployments prev
         WHERE prev.repo_id = d.repo_id
           AND prev.environment = d.environment
           AND prev.status = 'success'
           AND prev.created_at < d.created_at
       )
     ORDER BY d.created_at ASC`,
  )
  return rows.map((r) => Number(r.id))
}
