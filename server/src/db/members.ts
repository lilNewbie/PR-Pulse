import type { Role } from 'shared'
import pool from './pool'

interface MemberRow {
  team_id: number
  user_id: number
  role: Role
}

export async function getMemberRole(userId: number): Promise<Role | null> {
  const { rows } = await pool.query<MemberRow>(
    'SELECT role FROM members WHERE user_id = $1 LIMIT 1',
    [userId],
  )
  return rows[0]?.role ?? null
}

export async function countTeamMembers(teamId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*) as count FROM members WHERE team_id = $1',
    [teamId],
  )
  return parseInt(rows[0].count, 10)
}

export async function countLeads(teamId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*) as count FROM members WHERE team_id = $1 AND role = 'lead'",
    [teamId],
  )
  return parseInt(rows[0].count, 10)
}

export async function upsertMember(teamId: number, userId: number, role: Role): Promise<void> {
  await pool.query(
    `INSERT INTO members (team_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_id, user_id) DO NOTHING`,
    [teamId, userId, role],
  )
}

export async function getTeamId(): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM teams LIMIT 1')
  return rows[0]?.id ?? null
}

export async function createTeam(name: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO teams (name) VALUES ($1) RETURNING id',
    [name],
  )
  return rows[0].id
}
