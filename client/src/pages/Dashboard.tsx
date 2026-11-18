// Embedded Qlik Sense dashboard (frontend only; the PR Pulse API is not involved).
// Uses Qlik's "single integration" iframe: https://<tenant>/single/?appid=<app>&sheet=<sheet>
// Configured with VITE_QLIK_TENANT_URL, VITE_QLIK_APP_ID and VITE_QLIK_SHEET_ID (see client/src/vite-env.d.ts).
import { Navigate } from 'react-router-dom'
import { useMe } from '../hooks/useMe'

export interface QlikConfig {
  tenantUrl: string
  appId: string
  sheetId: string
}

type Env = Partial<Record<'VITE_QLIK_TENANT_URL' | 'VITE_QLIK_APP_ID' | 'VITE_QLIK_SHEET_ID', string>>

/** The Qlik settings from the build environment, or null if any is missing or the tenant isn't https. */
export function readQlikConfig(env: Env): QlikConfig | null {
  const tenantUrl = env.VITE_QLIK_TENANT_URL?.trim().replace(/\/+$/, '')
  const appId = env.VITE_QLIK_APP_ID?.trim()
  const sheetId = env.VITE_QLIK_SHEET_ID?.trim()
  if (!tenantUrl || !appId || !sheetId) return null
  if (!/^https:\/\/[^/\s]+$/.test(tenantUrl)) return null
  return { tenantUrl, appId, sheetId }
}

export function qlikEmbedUrl({ tenantUrl, appId, sheetId }: QlikConfig): string {
  const params = new URLSearchParams({ appid: appId, sheet: sheetId, opt: 'ctxmenu,currsel' })
  return `${tenantUrl}/single/?${params.toString()}`
}

export function qlikAppUrl({ tenantUrl, appId, sheetId }: QlikConfig): string {
  return `${tenantUrl}/sense/app/${encodeURIComponent(appId)}/sheet/${encodeURIComponent(sheetId)}/state/analysis`
}

/** Presentational, exported for component tests. */
export function QlikDashboard({ config }: { config: QlikConfig | null }) {
  if (!config) {
    return (
      <p className="text-muted">
        The Qlik dashboard isn't configured. Set <code>VITE_QLIK_TENANT_URL</code>, <code>VITE_QLIK_APP_ID</code> and{' '}
        <code>VITE_QLIK_SHEET_ID</code>, then rebuild the client.
      </p>
    )
  }

  return (
    <>
      <p className="text-muted">
        Sign in to Qlik if the dashboard asks you to.{' '}
        <a href={qlikAppUrl(config)} target="_blank" rel="noreferrer">Open in Qlik</a> if it doesn't load here.
      </p>
      <iframe
        title="Qlik dashboard"
        src={qlikEmbedUrl(config)}
        style={{ width: '100%', height: '80vh', border: 0 }}
        allow="clipboard-write"
      />
    </>
  )
}

export default function Dashboard() {
  const me = useMe()

  if (me.status === 'loading') return <p className="text-muted">Loading…</p>
  if (me.status === 'unauthenticated') return <Navigate to="/signin" replace />
  if (me.status === 'error') return <p className="text-error">Error: {me.message}</p>

  return (
    <section>
      <h2 className="page-title">Dashboard</h2>
      <QlikDashboard config={readQlikConfig(import.meta.env)} />
    </section>
  )
}
