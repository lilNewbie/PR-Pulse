import express from 'express'
import cookieParser from 'cookie-parser'

const app = express()

// Webhook route MUST be mounted before express.json() so it can read the raw body
// TODO (Mandaar): app.use('/webhooks', webhookRouter)

app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// TODO (Alan, days 2-3): mount auth router at /auth
// TODO (Alan, days 3-4): mount queue router at /api/queue
// TODO (Kaushik): mount repos router at /api/repos
// TODO (Mandaar): mount my-prs router at /api/my-prs
// TODO (Mallikarjun): mount prs router at /api/my-prs/:id

export default app
