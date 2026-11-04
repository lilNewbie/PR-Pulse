import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../server/src/db/pool', () => ({
  default: {
    query: vi.fn(),
  },
}))

vi.mock('../server/src/sync', () => ({
  syncRepo: vi.fn(),
}))

import pool from '../server/src/db/pool'
import { syncRepo } from '../server/src/sync'
import { runScheduledSync } from '../server/src/jobs/sync'

const query = vi.mocked(pool.query)
const sync = vi.mocked(syncRepo)

describe('scheduled synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sync.mockResolvedValue({
      status: 'ok',
      prsUpserted: 0,
      prsClosed: 0,
      lastSyncedAt: null,
    })
  })

  it('synchronizes each connected repository once', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
    } as Awaited<ReturnType<typeof pool.query>>)

    await runScheduledSync()

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenNthCalledWith(1, 1, 'scheduled')
    expect(sync).toHaveBeenNthCalledWith(2, 2, 'scheduled')
  })

  it('selects only connected repositories', async () => {
    query.mockResolvedValueOnce({
      rows: [],
    } as Awaited<ReturnType<typeof pool.query>>)

    await runScheduledSync()

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'connected'"),
    )
    expect(sync).not.toHaveBeenCalled()
  })

  it('continues after a repository fails', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
    } as Awaited<ReturnType<typeof pool.query>>)

    sync.mockRejectedValueOnce(new Error('GitHub unavailable'))

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await runScheduledSync()

      expect(sync).toHaveBeenCalledTimes(2)
      expect(sync).toHaveBeenNthCalledWith(2, 2, 'scheduled')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('succeeds when no repositories are connected', async () => {
    query.mockResolvedValueOnce({
      rows: [],
    } as Awaited<ReturnType<typeof pool.query>>)

    await expect(runScheduledSync()).resolves.toBeUndefined()
  })

  it('propagates database failures', async () => {
    query.mockRejectedValueOnce(new Error('Database unavailable'))

    await expect(runScheduledSync()).rejects.toThrow(
      'Database unavailable',
    )
  })
})
