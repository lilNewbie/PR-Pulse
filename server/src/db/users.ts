import pool from './pool'

export interface UserRow {
  id: number
  github_id: number
  login: string
  github_token_enc: string
  created_at: Date
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    'SELECT id, github_id, login, github_token_enc, created_at FROM users WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function findUserByGithubId(githubId: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    'SELECT id, github_id, login, github_token_enc, created_at FROM users WHERE github_id = $1',
    [githubId],
  )
  return rows[0] ?? null
}

export async function upsertUser(
  githubId: number,
  login: string,
  tokenEnc: string,
): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (github_id, login, github_token_enc)
     VALUES ($1, $2, $3)
     ON CONFLICT (github_id)
     DO UPDATE SET login = EXCLUDED.login, github_token_enc = EXCLUDED.github_token_enc
     RETURNING id, github_id, login, github_token_enc, created_at`,
    [githubId, login, tokenEnc],
  )
  return rows[0]
}
