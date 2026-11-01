import pool from './pool'

interface SessionRow {
  id: string
  user_id: number
  expires_at: Date
}

export async function findSession(id: string): Promise<SessionRow | null> {
  const { rows } = await pool.query<SessionRow>(
    'SELECT id, user_id, expires_at FROM sessions WHERE id = $1',
    [id],
  )
  return rows[0] ?? null
}

export async function createSession(id: string, userId: number, expiresAt: Date): Promise<void> {
  await pool.query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)', [
    id,
    userId,
    expiresAt,
  ])
}

export async function deleteSession(id: string): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE id = $1', [id])
}

export async function deleteExpiredSessions(): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at < now()')
}
