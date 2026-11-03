import { useState, useEffect } from 'react'
import { apiFetch, ApiClientError } from '../api/client'
import type { Me } from 'shared'

export type MeState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'ok'; me: Me }
  | { status: 'error'; message: string }

export function useMe(): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' })

  useEffect(() => {
    apiFetch<Me>('/api/me')
      .then((me) => setState({ status: 'ok', me }))
      .catch((err) => {
        if (err instanceof ApiClientError && err.status === 401) {
          setState({ status: 'unauthenticated' })
        } else {
          setState({ status: 'error', message: err.message })
        }
      })
  }, [])

  return state
}
