import type { DeploymentSummary } from 'shared'
import pool from './pool'

type Environment = DeploymentSummary['environment']

interface DeploymentHistoryRow {
  id: string
  sha: string
  environment: Environment
  status: DeploymentSummary['status']
  source: DeploymentSummary['source']
  created_at: Date
  pr_count: number
}

export type DeploymentHistoryResult =
  | { status: 'forbidden' }
  | { status: 'ok'; items: DeploymentSummary[] }

/**
 * US-13: A caller must have repo_access even when the repository has no deployments.
 * Repeat the repo_access join in the list query so a revoked permission cannot leak rows.
 * This file only reads deployment data; Alan's Deployments Module owns all writes.
 */
export async function getDeployments(
  userId: number,
  repoId: number,
  environment?: Environment,
): Promise<DeploymentHistoryResult> {
  const { rows: accessRows } = await pool.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM repo_access
       WHERE user_id = $1 AND repo_id = $2
     ) AS allowed`,
    [userId, repoId],
  )

  if (!accessRows[0]?.allowed) {
    return { status: 'forbidden' }
  }

  const { rows } = await pool.query<DeploymentHistoryRow>(
    `SELECT d.id, d.sha, d.environment, d.status, d.source, d.created_at,
            COUNT(dp.pr_id)::integer AS pr_count
     FROM deployments d
     JOIN repo_access ra ON ra.repo_id = d.repo_id AND ra.user_id = $1
     LEFT JOIN deployment_prs dp ON dp.deployment_id = d.id
     WHERE d.repo_id = $2
       AND ($3::text IS NULL OR d.environment = $3)
     GROUP BY d.id
     ORDER BY d.created_at DESC, d.id DESC`,
    [userId, repoId, environment ?? null],
  )

  return {
    status: 'ok',
    items: rows.map((row) => ({
      id: Number(row.id),
      sha: row.sha,
      environment: row.environment,
      status: row.status,
      source: row.source,
      createdAt: row.created_at.toISOString(),
      prCount: Number(row.pr_count),
    })),
  }
}
