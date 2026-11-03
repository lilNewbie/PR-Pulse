import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import authRouter from './modules/auth/router'
import teamRepoRouter from './modules/team-repo/router'

const app = express()

// Webhook route MUST be mounted before express.json() so it can read the raw body
// TODO (Mandaar): app.use('/webhooks', webhookRouter)

app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use(authRouter)
app.use(teamRepoRouter)

// TODO (Alan, days 3-4): mount queue router at /api/queue
// TODO (Mandaar): mount my-prs router at /api/my-prs
// TODO (Mallikarjun): mount prs router at /api/my-prs/:id

const clientDist = path.join(process.cwd(), 'client', 'dist')
app.use(express.static(clientDist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

export default app
