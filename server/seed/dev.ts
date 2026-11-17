
import pool from '../src/db/pool'
import { encrypt } from '../src/lib/crypto'

const DEMO_TEAM = 'PR Pulse Demo Team'

// Synthetic 40-character SHAs, used only by the local demo data.
// They do not point to commits in a real GitHub repository.
const DEMO_MERGE_SHAS = {
  original: '1'.repeat(40),
  authentication: '2'.repeat(40),
  dashboard: '3'.repeat(40),
} as const

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

  // Port 5433 matches the PostgreSQL mapping in docker-compose.yml.
  // If the local Docker port changes, update this safety check as well.
  // Never run this seed against a production or shared database.
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

    // Deleting demo PRs also cascades to pr_files and deployment_prs;
    // deleting demo repos cascades to deployments and file_touches.

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
      mergeCommitSha?: string
      isReleaseBlocker?: boolean
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
        isReleaseBlocker: true,
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 8,
        linesChanged: 20,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 8,
        reviewerGithubId: 900002,
      },
      {
        number: 5,
        title: 'Refactor API response types',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'open',
        isDraft: false,
        hoursSinceActivity: 8,
        linesChanged: 200,
        mergeable: true,
        behindBy: 0,
        reviewRequestedHoursAgo: 8,
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
        mergeCommitSha: DEMO_MERGE_SHAS.original,
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
      // Additional merged PRs show different PR counts across deploys.
      {
        number: 14,
        title: 'Fix authentication token rotation',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'merged',
        isDraft: false,
        hoursSinceActivity: 18,
        linesChanged: 35,
        mergeable: true,
        behindBy: 0,
        mergeCommitSha: DEMO_MERGE_SHAS.authentication,
      },
      {
        number: 15,
        title: 'Release dashboard improvements',
        repo: 'sandbox',
        authorGithubId: 900004,
        state: 'merged',
        isDraft: false,
        hoursSinceActivity: 6,
        linesChanged: 90,
        mergeable: true,
        behindBy: 0,
        mergeCommitSha: DEMO_MERGE_SHAS.dashboard,
      },
    ]

    const prIds: Record<number, string> = {}

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
          merged_at,
          merge_commit_sha,
          is_release_blocker
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16
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
          pr.mergeCommitSha ?? null,
          pr.isReleaseBlocker ?? false,
        ]
      )

      const prId = result.rows[0].id
      prIds[pr.number] = prId

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

    // ========================================
    // STEP 6: CHANGED FILES AND FILE HISTORY
    // ========================================

    // The changed files match existing open PRs, so the suggestions query
    // can demonstrate eligible reviewers, an ineligible PR Author, and a bot.
    const changedFiles = [
      { prNumber: 1, path: 'src/auth/session.ts' },
      { prNumber: 2, path: 'client/src/pages/Dashboard.tsx' },
      { prNumber: 3, path: 'client/src/navigation/Menu.tsx' },
      { prNumber: 5, path: 'server/src/config/bot-only.ts' },
    ]

    for (const { prNumber, path } of changedFiles) {
      await client.query(
        'INSERT INTO pr_files (pr_id, path) VALUES ($1, $2)',
        [prIds[prNumber], path],
      )
    }

    const fileTouches = [
      // The most recent two touches are ineligible, so reviewer 1 is suggested.
      { path: 'src/auth/session.ts', login: 'demo_reviewer_1', hours: 45, sha: '4'.repeat(40) },
      { path: 'src/auth/session.ts', login: 'demo_author', hours: 10, sha: '5'.repeat(40) },
      { path: 'src/auth/session.ts', login: 'automation[bot]', hours: 2, sha: '6'.repeat(40) },
      // Reviewer 2 works in a different area.
      { path: 'client/src/pages/Dashboard.tsx', login: 'demo_reviewer_2', hours: 28, sha: '7'.repeat(40) },
      // PR Authors and bots are never eligible to be suggested by themselves.
      { path: 'client/src/navigation/Menu.tsx', login: 'demo_author', hours: 9, sha: '8'.repeat(40) },
      { path: 'server/src/config/bot-only.ts', login: 'automation[bot]', hours: 3, sha: '9'.repeat(40) },
    ]

    for (const touch of fileTouches) {
      await client.query(
        `INSERT INTO file_touches
           (repo_id, path, author_login, commit_sha, committed_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [repoIds.sandbox, touch.path, touch.login, touch.sha, hoursAgo(touch.hours)],
      )
    }

    console.log(`Created ${changedFiles.length} PR file entries and ${fileTouches.length} file touches`)

    // ========================================
    // STEP 7: DEPLOYMENT HISTORY AND PR LINKS
    // ========================================

    // Each deployment's date follows the merge of any linked PR.
    // A failed deploy still has linked PRs. The first production deploy and
    // the final staging deploy deliberately have zero linked PRs.
    const deployments = [
      {
        sha: 'a'.repeat(40), environment: 'staging', status: 'success',
        source: 'manual', hours: 36, prNumbers: [12],
      },
      {
        sha: 'b'.repeat(40), environment: 'staging', status: 'failed',
        source: 'webhook', hours: 12, prNumbers: [14],
      },
      {
        sha: 'c'.repeat(40), environment: 'staging', status: 'success',
        source: 'webhook', hours: 3, prNumbers: [14, 15],
      },
      {
        sha: 'd'.repeat(40), environment: 'production', status: 'success',
        source: 'manual', hours: 2, prNumbers: [],
      },
      {
        sha: 'e'.repeat(40), environment: 'staging', status: 'success',
        source: 'manual', hours: 1, prNumbers: [],
      },
    ] as const

    for (const deployment of deployments) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO deployments
           (repo_id, sha, environment, status, source, recorded_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          repoIds.sandbox,
          deployment.sha,
          deployment.environment,
          deployment.status,
          deployment.source,
          deployment.source === 'manual' ? userIds.demo_lead : null,
          hoursAgo(deployment.hours),
        ],
      )

      for (const prNumber of deployment.prNumbers) {
        await client.query(
          'INSERT INTO deployment_prs (deployment_id, pr_id) VALUES ($1, $2)',
          [rows[0].id, prIds[prNumber]],
        )
      }
    }

    console.log(`Created ${deployments.length} deployments, including first production and zero-PR examples`)
    console.log('Marked sandbox PR #4 as a release blocker')

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
