export interface SyncResult {
  status: 'ok' | 'rate_limited' | 'skipped' | 'failed'
  prsUpserted: number
  prsClosed: number
  lastSyncedAt: Date | null
}

// Owned by Mandaar
export async function syncRepo(
  _repoId: number,
  _mode: 'initial' | 'scheduled',
): Promise<SyncResult> {
  throw new Error('not implemented')
}

// Owned by Mandaar
export async function applyEvent(_repoId: number, _prNumber: number): Promise<void> {
  throw new Error('not implemented')
}
