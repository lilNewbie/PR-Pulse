/// <reference types="vite/client" />

// Build-time settings for the embedded Qlik dashboard (client/src/pages/Dashboard.tsx).
// Vite bakes VITE_* values into the bundle when `npm run build` runs, so on Render they must be
// set on the service before the build. None of them are secrets.
interface ImportMetaEnv {
  readonly VITE_QLIK_TENANT_URL?: string
  readonly VITE_QLIK_APP_ID?: string
  readonly VITE_QLIK_SHEET_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
