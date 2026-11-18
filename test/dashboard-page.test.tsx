// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QlikDashboard, qlikEmbedUrl, readQlikConfig } from '../client/src/pages/Dashboard'

const ENV = {
  VITE_QLIK_TENANT_URL: 'https://acme.us.qlikcloud.com/',
  VITE_QLIK_APP_ID: 'a1b2c3d4-app',
  VITE_QLIK_SHEET_ID: 'sheet-9',
}

describe('Qlik dashboard page', () => {
  it('reads the three settings and trims a trailing slash from the tenant', () => {
    expect(readQlikConfig(ENV)).toEqual({
      tenantUrl: 'https://acme.us.qlikcloud.com',
      appId: 'a1b2c3d4-app',
      sheetId: 'sheet-9',
    })
  })

  it('is unconfigured when a setting is missing or the tenant is not https', () => {
    expect(readQlikConfig({})).toBeNull()
    expect(readQlikConfig({ ...ENV, VITE_QLIK_SHEET_ID: '' })).toBeNull()
    expect(readQlikConfig({ ...ENV, VITE_QLIK_TENANT_URL: 'http://acme.us.qlikcloud.com' })).toBeNull()
    expect(readQlikConfig({ ...ENV, VITE_QLIK_TENANT_URL: 'https://acme.qlik.com/evil?x=' })).toBeNull()
  })

  it('builds the single-integration URL with encoded parameters', () => {
    expect(qlikEmbedUrl({ tenantUrl: 'https://t.qlikcloud.com', appId: 'app 1&x', sheetId: 's/2' })).toBe(
      'https://t.qlikcloud.com/single/?appid=app+1%26x&sheet=s%2F2&opt=ctxmenu%2Ccurrsel',
    )
  })

  it('embeds the dashboard in an iframe with an "Open in Qlik" fallback link', () => {
    render(<QlikDashboard config={readQlikConfig(ENV)} />)

    expect(screen.getByTitle('Qlik dashboard').getAttribute('src')).toBe(
      'https://acme.us.qlikcloud.com/single/?appid=a1b2c3d4-app&sheet=sheet-9&opt=ctxmenu%2Ccurrsel',
    )
    expect(screen.getByRole('link', { name: 'Open in Qlik' }).getAttribute('href')).toBe(
      'https://acme.us.qlikcloud.com/sense/app/a1b2c3d4-app/sheet/sheet-9/state/analysis',
    )
  })

  it('shows how to configure it, and no iframe, when unconfigured', () => {
    render(<QlikDashboard config={null} />)

    expect(screen.getByText(/The Qlik dashboard isn't configured/)).toBeTruthy()
    expect(screen.queryByTitle('Qlik dashboard')).toBeNull()
  })
})
