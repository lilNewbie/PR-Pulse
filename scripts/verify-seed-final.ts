/**
 * Read-only smoke check for the final-sprint local development seed.
 * Run after `npm run seed` with `npx tsx scripts/verify-seed-final.ts`.
 * Never runs against staging, production, or the Vitest database.
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import pool from '../server/src/db/pool'

const demoTeam = 'PR Pulse Demo Team'

async function verify(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  assert.ok(databaseUrl, 'DATABASE_URL is missing')

  const url = new URL(databaseUrl)
  assert.ok(
    process.env.NODE_ENV === 'development' &&
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      url.port === '5433' &&
      url.pathname === '/pr_pulse',
    'Verification is allowed only on the local development database',
  )

  const count = async (sql: string): Promise<number> => {
    const { rows } = await pool.query<{ count: number }>(sql, [demoTeam])
    return Number(rows[0].count)
  }

  const prs = await count(`
    SELECT COUNT(*)::integer AS count FROM pull_requests p
    JOIN repos r ON r.id = p.repo_id JOIN teams t ON t.id = r.team_id
    WHERE t.name = $1
  `)
  const blockers = await count(`
    SELECT COUNT(*)::integer AS count FROM pull_requests p
    JOIN repos r ON r.id = p.repo_id JOIN teams t ON t.id = r.team_id
    WHERE t.name = $1 AND p.state = 'open' AND p.is_release_blocker = true
  `)
  const changedFiles = await count(`
    SELECT COUNT(*)::integer AS count FROM pr_files f
    JOIN pull_requests p ON p.id = f.pr_id JOIN repos r ON r.id = p.repo_id
    JOIN teams t ON t.id = r.team_id WHERE t.name = $1
  `)
  const touches = await count(`
    SELECT COUNT(*)::integer AS count FROM file_touches f
    JOIN repos r ON r.id = f.repo_id JOIN teams t ON t.id = r.team_id
    WHERE t.name = $1
  `)
  const links = await count(`
    SELECT COUNT(*)::integer AS count FROM deployment_prs dp
    JOIN deployments d ON d.id = dp.deployment_id
    JOIN repos r ON r.id = d.repo_id JOIN teams t ON t.id = r.team_id
    WHERE t.name = $1
  `)
  const badLinks = await count(`
    SELECT COUNT(*)::integer AS count FROM deployment_prs dp
    JOIN deployments d ON d.id = dp.deployment_id
    JOIN pull_requests p ON p.id = dp.pr_id
    JOIN repos r ON r.id = d.repo_id JOIN teams t ON t.id = r.team_id
    WHERE t.name = $1 AND (p.state <> 'merged' OR p.repo_id <> d.repo_id)
  `)

  const { rows: deploymentRows } = await pool.query<{
    environment: 'staging' | 'production'
    status: 'success' | 'failed' | 'pending'
    source: 'manual' | 'webhook'
    linked_at: Date | null
    pr_count: number
  }>(`
    SELECT d.environment, d.status, d.source, d.linked_at, COUNT(dp.pr_id)::integer AS pr_count
    FROM deployments d
    JOIN repos r ON r.id = d.repo_id JOIN teams t ON t.id = r.team_id
    LEFT JOIN deployment_prs dp ON dp.deployment_id = d.id
    WHERE t.name = $1
    GROUP BY d.id
    ORDER BY d.created_at ASC, d.id ASC
  `, [demoTeam])

  const { rows: authors } = await pool.query<{ author_login: string }>(`
    SELECT DISTINCT f.author_login FROM file_touches f
    JOIN repos r ON r.id = f.repo_id JOIN teams t ON t.id = r.team_id
    WHERE t.name = $1
  `, [demoTeam])
  const authorLogins = new Set(authors.map((row) => row.author_login))

  assert.equal(prs, 15, 'Expected original 13 PRs plus two merged PRs')
  assert.equal(blockers, 1, 'Expected one open release blocker')
  assert.equal(changedFiles, 4, 'Expected four changed-file fixtures')
  assert.equal(touches, 6, 'Expected six file-touch fixtures')
  assert.equal(links, 3, 'Expected three deployment-to-PR links')
  assert.equal(badLinks, 0, 'All deployment links must point to merged PRs in the same repo')
  assert.ok(deploymentRows.every((r) => r.linked_at !== null), 'All seeded deployments must be marked as linked')
  assert.deepEqual(deploymentRows.map((r) => ({
    environment: r.environment, status: r.status, source: r.source, prCount: Number(r.pr_count),
  })), [
    { environment: 'staging', status: 'success', source: 'manual', prCount: 0 },
    { environment: 'staging', status: 'failed', source: 'webhook', prCount: 1 },
    { environment: 'staging', status: 'success', source: 'webhook', prCount: 2 },
    { environment: 'production', status: 'success', source: 'manual', prCount: 0 },
    { environment: 'staging', status: 'success', source: 'manual', prCount: 0 },
  ])
  for (const name of ['demo_reviewer_1', 'demo_reviewer_2', 'demo_author', 'automation[bot]']) {
    assert.ok(authorLogins.has(name), `Missing file touches for ${name}`)
  }

  console.log('Final-sprint development seed verified:')
  console.log(`  ${prs} pull requests, ${blockers} release blocker`)
  console.log(`  ${changedFiles} PR file rows, ${touches} file touches`)
  console.log(`  ${deploymentRows.length} deployments, ${links} linked deployment-PR pairs`)
  console.log('  Staging success -> failed -> success; first production; valid zero-PR example')
  console.log('  Two reviewers, PR Author, and bot file history present')
}

verify()
  .catch((err: unknown) => {
    console.error('Seed verification failed:', err)
    process.exitCode = 1
  })
  .finally(async () => { await pool.end() })
