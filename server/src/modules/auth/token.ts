import { findUserById } from '../../db/users'
import { decrypt } from '../../lib/crypto'

export async function getGitHubToken(userId: number): Promise<string> {
  const user = await findUserById(userId)
  if (!user) throw new Error(`User ${userId} not found`)
  return decrypt(user.github_token_enc)
}
