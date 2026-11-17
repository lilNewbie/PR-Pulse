// Owned by Kaushik. US-15 Explain reviewer expertise (design-final 4, 5.4).
import type { ExpertiseResponse } from 'shared'
import { findAccessibleRepo, getExpertise } from '../../db/expertise'

export type ExpertiseResult = { status: 'forbidden' } | { status: 'ok'; body: ExpertiseResponse }

export async function getMyExpertise(
  user: { id: number; login: string },
  repoId: number,
): Promise<ExpertiseResult> {
  const repo = await findAccessibleRepo(user.id, repoId)
  if (!repo) return { status: 'forbidden' }
  const areas = await getExpertise(user.login, repo.id)
  return { status: 'ok', body: { repo, areas } }
}
