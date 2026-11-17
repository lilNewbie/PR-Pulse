import { describe, it, expect, vi, beforeEach } from 'vitest'

// A strongly typed mock for the repository lookup query.
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn<
    (sql: string) => Promise<{ rows: { id: number }[] }>
  >(),
}))

vi.mock('../server/src/db/pool', () => ({
  default: {
    query: queryMock,
  },
}))

vi.mock('../server/src/sync', () => ({
  syncRepo: vi.fn(),
}))

vi.mock('../server/src/modules/deployments', () => ({
  retryUnlinkedDeployments: vi.fn(),
}))

import { syncRepo } from '../server/src/sync'
import { retryUnlinkedDeployments } from '../server/src/modules/deployments'
import { runScheduledSync } from '../server/src/jobs/sync'

const sync = vi.mocked(syncRepo)
const retry = vi.mocked(retryUnlinkedDeployments)

describe('scheduled synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryMock.mockReset()

    sync.mockResolvedValue({
      status: 'ok',
      prsUpserted: 0,
      prsClosed: 0,
      lastSyncedAt: null,
    })

    retry.mockResolvedValue(undefined)
  })

  it('synchronizes each connected repository once, then retries deployments', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
    })

    await runScheduledSync()

    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync).toHaveBeenNthCalledWith(1, 1, 'scheduled')
    expect(sync).toHaveBeenNthCalledWith(2, 2, 'scheduled')

    expect(retry).toHaveBeenCalledTimes(1)

    expect(sync.mock.invocationCallOrder[1]).toBeLessThan(
      retry.mock.invocationCallOrder[0],
    )
  })

  it('selects only connected repositories', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [],
    })

    await runScheduledSync()

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("status = 'connected'"),
    )
    expect(sync).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('continues after a repository fails', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
    })

    sync.mockRejectedValueOnce(new Error('GitHub unavailable'))

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await runScheduledSync()

      expect(sync).toHaveBeenCalledTimes(2)
      expect(sync).toHaveBeenNthCalledWith(2, 2, 'scheduled')
      expect(retry).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('succeeds when no repositories are connected', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [],
    })

    await expect(runScheduledSync()).resolves.toBeUndefined()

    expect(sync).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('handles deployment retry failures without crashing the job', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [],
    })

    retry.mockRejectedValueOnce(new Error('Deployment retry failed'))

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(runScheduledSync()).resolves.toBeUndefined()

      expect(retry).toHaveBeenCalledTimes(1)

      expect(errorSpy).toHaveBeenCalledWith(
        '[scheduled-sync] deployment-link retry failed:',
        'Deployment retry failed',
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('propagates database failures', async () => {
    queryMock.mockRejectedValueOnce(new Error('Database unavailable'))

    await expect(runScheduledSync()).rejects.toThrow(
      'Database unavailable',
    )

    expect(retry).not.toHaveBeenCalled()
  })
})
