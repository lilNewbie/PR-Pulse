
import pool from '../src/db/pool'
import { encrypt } from '../src/lib/crypto'

const DEMO_TEAM = 'PR Pulse Demo Team'

const DEMO_USERS = [
  { githubId: 900001, login: 'demo_lead', role: 'lead' },
  { githubId: 900002, login: 'demo_reviewer_1', role: 'reviewer' },
  { githubId: 900003, login: 'demo_reviewer_2', role: 'reviewer' },
  { githubId: 900004, login: 'demo_author', role: 'pr_author' },
] as const

const DEMO_REPOS = [
  { githubRepoId: 800001, name: 'sandbox' },
  { githubRepoId: 800002, name: 'api' },
] as const

export async function seedDevelopmentData(): Promise<void> {
  console.log('Starting PR Pulse development seed...')

  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured')
  }

  const url = new URL(databaseUrl)

  if (
    process.env.NODE_ENV !== 'development' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    url.pathname !== '/pr_pulse'
  ) {
    throw new Error(
      'Development seed is only allowed for the local PR Pulse database'
    )
  }

  // Use the same reference time for every seeded PR.
  const seedNow = Date.now()

  function hoursAgo(hours: number): Date {
    return new Date(seedNow - hours * 60 * 60 * 1000)
  }

  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    // ========================================
    // STEP 0: CLEAR PREVIOUS DEMO DATA
    // ========================================

    await client.query(
      `DELETE FROM reviews
       WHERE pr_id IN (
         SELECT p.id
         FROM pull_requests p
         JOIN repos r ON r.id = p.repo_id
         JOIN teams t ON t.id = r.team_id
         WHERE t.name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM review_requests
       WHERE pr_id IN (
         SELECT p.id
         FROM pull_requests p
         JOIN repos r ON r.id = p.repo_id
         JOIN teams t ON t.id = r.team_id
         WHERE t.name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM pull_requests
       WHERE repo_id IN (
         SELECT r.id
         FROM repos r
         JOIN teams t ON t.id = r.team_id
         WHERE t.name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM webhook_events
       WHERE repo_id IN (
         SELECT r.id
         FROM repos r
         JOIN teams t ON t.id = r.team_id
         WHERE t.name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM repo_access
       WHERE repo_id IN (
         SELECT r.id
         FROM repos r
         JOIN teams t ON t.id = r.team_id
         WHERE t.name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM repos
       WHERE team_id IN (
         SELECT id FROM teams WHERE name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM members
       WHERE team_id IN (
         SELECT id FROM teams WHERE name = $1
       )`,
      [DEMO_TEAM]
    )

    await client.query(
      `DELETE FROM teams WHERE name = $1`,
      [DEMO_TEAM]
    )

    const demoGithubIds = DEMO_USERS.map(user => user.githubId)

    await client.query(
      `DELETE FROM sessions
       WHERE user_id IN (
         SELECT id FROM users
         WHERE github_id = ANY($1::bigint[])
       )`,
      [demoGithubIds]
    )

    await client.query(
      `DELETE FROM repo_access
       WHERE user_id IN (
         SELECT id FROM users
         WHERE github_id = ANY($1::bigint[])
       )`,
      [demoGithubIds]
    )

    await client.query(
      `DELETE FROM members
       WHERE user_id IN (
         SELECT id FROM users
         WHERE github_id = ANY($1::bigint[])
       )`,
      [demoGithubIds]
    )

    await client.query(
      `DELETE FROM users
       WHERE github_id = ANY($1::bigint[])`,
      [demoGithubIds]
    )

    console.log('Cleared previous demo data')

    // ========================================
    // STEP 1: CREATE TEAM
    // ========================================

    const teamResult = await client.query<{ id: string }>(
      `INSERT INTO teams (name)
       VALUES ($1)
       RETURNING id`,
      [DEMO_TEAM]
    )

    const teamId = teamResult.rows[0].id

    console.log('Created demo team')

    // ========================================
    // STEP 2: CREATE USERS
    // ========================================

    const userIds: Record<string, string> = {}

    for (const user of DEMO_USERS) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO users (
          github_id,
          login,
          github_token_enc
        )
        VALUES ($1, $2, $3)
        RETURNING id`,
        [
          user.githubId,
          user.login,
          encrypt('seed'),
        ]
      )

      const userId = result.rows[0].id
      userIds[user.login] = userId

      await client.query(
        `INSERT INTO members (team_id, user_id, role)
         VALUES ($1, $2, $3)`,
        [teamId, userId, user.role]
      )
    }

    console.log('Created four demo users')

    // ========================================
    // STEP 3: CREATE REPOSITORIES
    // ========================================

    const repoIds: Record<string, string> = {}

    for (const repo of DEMO_REPOS) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO repos (
          team_id,
          github_repo_id,
          owner,
          name,
          webhook_secret_enc,
          status,
          sync_status,
          last_synced_at,
          connected_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
        RETURNING id`,
        [
          teamId,
          repo.githubRepoId,
          'pr-pulse-demo',
          repo.name,
          encrypt('seed'),
          'connected',
          'ok',
          userIds.demo_lead,
        ]
      )

      repoIds[repo.name] = result.rows[0].id
    }

    console.log('Created sandbox and api repositories')

    // ========================================
    // STEP 4: CONFIGURE ACCESS
    // ========================================

    for (const user of DEMO_USERS) {
      const userId = userIds[user.login]

      await client.query(
        `INSERT INTO repo_access (user_id, repo_id)
         VALUES ($1, $2)`,
        [userId, repoIds.sandbox]
      )

      if (user.role === 'lead') {
        await client.query(
          `INSERT INTO repo_access (user_id, repo_id)
           VALUES ($1, $2)`,
          [userId, repoIds.api]
        )
      }
    }

    console.log('Configured repository access')

    // ========================================
    // STEP 5: CREATE PULL REQUEST SCENARIOS
    // ========================================

    type DemoPr = {
      number: number
      title: string
      repo: 'sandbox' | 'api'
      authorGithubId: number
      state: 'open' | 'closed' | 'merged'
      isDraft: boolean
      hoursSinceActivity: number
      linesChanged: number
      mergeable: boolean | null
      behindBy: number
      reviewRequestedHoursAgo?: number
      reviewerGithubId?: number
    }

    const demoPrs: DemoPr[] = [
      {
        number: 1,
        title: 'Add authentication middleware',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 30,
        linesChanged: 120,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 30,
        reviewerGithubId: 900002,
      },
      {
        number: 2,
        title: 'Improve dashboard layout',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 5,
        linesChanged: 45,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 5,
        reviewerGithubId: 900002,
      },
      {
        number: 3,
        title: 'Fix navigation styling',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 2,
        linesChanged: 15,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 2,
        reviewerGithubId: 900002,
      },
      {
        number: 4,
        title: 'Update API error handling',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 5,
        linesChanged: 20,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 5,
        reviewerGithubId: 900002,
      },
      {
        number: 5,
        title: 'Refactor API response types',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 5,
        linesChanged: 200,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 5,
        reviewerGithubId: 900002,
      },
      {
        number: 6,
        title: 'WIP: New notification system',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: true,
        hoursSinceActivity: 3,
        linesChanged: 80,
        mergeable: null,
        behindBy: 0,
        reviewRequestedHoursAgo: 3,
        reviewerGithubId: 900002,
      },
      {
        number: 7,
        title: 'Reviewer-authored feature',
        repo: 'sandbox',
        authorGithubId: 900002,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 4,
        linesChanged: 60,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 4,
        reviewerGithubId: 900003,
      },
      {
        number: 8,
        title: 'Update outdated documentation',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 30,
        linesChanged: 10,
        mergeable: true,
        behindBy: 0,
      },
      {
        number: 9,
        title: 'Resolve conflicting changes',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 6,
        linesChanged: 90,
        mergeable: false,
        behindBy: 0,
      },
      {
        number: 10,
        title: 'Investigate mergeability status',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 7,
        linesChanged: 35,
        mergeable: null,
        behindBy: 0,
      },
      {
        number: 11,
        title: 'Update dependencies',
        // Accessible to demo_author for the "Behind main" badge.
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 8,
        linesChanged: 75,
        mergeable: true,
        behindBy: 4,
      },
      {
        number: 12,
        title: 'Previously completed feature',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'merged',
        isDraft: false,
        hoursSinceActivity: 48,
        linesChanged: 55,
        mergeable: true,
        behindBy: 0,
      },
      {
        number: 13,
        title: 'Cancelled experimental feature',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'closed',
        isDraft: false,
        hoursSinceActivity: 72,
        linesChanged: 100,
        mergeable: null,
        behindBy: 0,
      },
    ]

    for (const pr of demoPrs) {
      const lastActivityAt = hoursAgo(pr.hoursSinceActivity)

      const result = await client.query<{ id: string }>(
        `INSERT INTO pull_requests (
          repo_id,
          number,
          title,
          author_github_id,
          state,
          is_draft,
          ready_at,
          lines_changed,
          last_activity_at,
          github_updated_at,
          mergeable,
          behind_by,
          base_ref,
          merged_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING id`,
        [
          repoIds[pr.repo],
          pr.number,
          pr.title,
          pr.authorGithubId,
          pr.state,
          pr.isDraft,
          pr.isDraft ? null : lastActivityAt,
          pr.linesChanged,
          lastActivityAt,
          lastActivityAt,
          pr.mergeable,
          pr.behindBy,
          'main',
          pr.state === 'merged' ? lastActivityAt : null,
        ]
      )

      const prId = result.rows[0].id

      if (
        pr.reviewRequestedHoursAgo !== undefined &&
        pr.reviewerGithubId !== undefined
      ) {
        await client.query(
          `INSERT INTO review_requests (
            pr_id,
            reviewer_github_id,
            requested_at
          )
          VALUES ($1, $2, $3)`,
          [
            prId,
            pr.reviewerGithubId,
            hoursAgo(pr.reviewRequestedHoursAgo),
          ]
        )
      }
    }

    console.log(`Created ${demoPrs.length} demo pull requests`)

    await client.query('COMMIT')

    console.log('Development seed completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Development seed failed:', error)
    throw error
  } finally {
    client.release()
  }
}
