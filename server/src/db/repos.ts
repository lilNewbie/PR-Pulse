import pool from './pool'

export interface RepoRow {
  id: number
  team_id: number
  github_repo_id: number
  owner: string
  name: string
  hook_id: number | null
  status: 'connecting' | 'connected'
  sync_status: 'ok' | 'rate_limited' | 'failed'
  last_synced_at: Date | null
}

export interface NewRepo {
  githubRepoId: number
  owner: string
  name: string
  hookId: number
  webhookSecretEnc: string
  connectedBy: number
}

export class RepoAlreadyConnectedError extends Error {
  constructor() {
    super('Repository is already connected')
    this.name = 'RepoAlreadyConnectedError'
  }
}

// Never select webhook_secret_enc here; these rows can reach API responses.
const REPO_COLUMNS = `r.id, r.team_id, r.github_repo_id, r.owner, r.name, r.hook_id,
  r.status, r.sync_status, r.last_synced_at`

export async function findRepoByGithubId(githubRepoId: number): Promise<RepoRow | null> {
  const { rows } = await pool.query<RepoRow>(
    `SELECT ${REPO_COLUMNS} FROM repos r WHERE r.github_repo_id = $1`,
    [githubRepoId],
  )
  return rows[0] ?? null
}

export async function listTeamRepos(userId: number): Promise<RepoRow[]> {
  const { rows } = await pool.query<RepoRow>(
    `SELECT ${REPO_COLUMNS}
     FROM repos r
     JOIN members m ON m.team_id = r.team_id
     WHERE m.user_id = $1
     ORDER BY r.owner, r.name`,
    [userId],
  )
  return rows
}

export async function listAccessibleRepoSyncStatus(
  userId: number,
): Promise<Pick<RepoRow, 'sync_status' | 'last_synced_at'>[]> {
  const { rows } = await pool.query<Pick<RepoRow, 'sync_status' | 'last_synced_at'>>(
    `SELECT r.sync_status, r.last_synced_at
     FROM repos r
     JOIN repo_access ra ON ra.repo_id = r.id
     WHERE ra.user_id = $1`,
    [userId],
  )
  return rows
}

// Inserts the repo in the connecting user's team and gives them access to it.
// Throws RepoAlreadyConnectedError if another connect for the same repo won the race.
export async function insertConnectingRepo(repo: NewRepo): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // sync_status is set explicitly: the column default in the migration is broken ('''ok''').
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO repos (team_id, github_repo_id, owner, name, hook_id, webhook_secret_enc,
         status, sync_status, connected_by)
       SELECT m.team_id, $1, $2, $3, $4, $5, 'connecting', 'ok', $6
       FROM members m
       WHERE m.user_id = $6
       LIMIT 1
       RETURNING id`,
      [repo.githubRepoId, repo.owner, repo.name, repo.hookId, repo.webhookSecretEnc, repo.connectedBy],
    )
    if (rows.length === 0) throw new Error(`User ${repo.connectedBy} is not in a team`)

    const repoId = Number(rows[0].id)
    await client.query('INSERT INTO repo_access (user_id, repo_id) VALUES ($1, $2)', [
      repo.connectedBy,
      repoId,
    ])
    await client.query('COMMIT')
    return repoId
  } catch (err) {
    await client.query('ROLLBACK')
    if ((err as { code?: string }).code === '23505') throw new RepoAlreadyConnectedError()
    throw err
  } finally {
    client.release()
  }
}

export async function listConnectedRepoIds(): Promise<number[]> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM repos WHERE status = 'connected' ORDER BY id`,
  )
  return rows.map((row) => Number(row.id))
}
