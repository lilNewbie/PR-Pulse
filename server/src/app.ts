
import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import authRouter from './modules/auth/router'
import prsRouter from './modules/prs/router'
import queueRouter from './modules/queue/router'
import teamRepoRouter from './modules/team-repo/router'
import webhookRouter from './webhook/router'

const app = express()

// Webhook route MUST be mounted before express.json()
// so GitHub webhook signatures can be verified using the raw body.
app.use('/webhooks', webhookRouter)

app.use(express.json())
app.use(cookieParser())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use(authRouter)
app.use(queueRouter)
app.use(teamRepoRouter)

// Day 3: Authenticated PR details endpoint
// GET /api/my-prs/:id
app.use(prsRouter)

// TODO (Mandaar): mount my-prs list router at /api/my-prs

const clientDist = path.join(process.cwd(), 'client', 'dist')

app.use(express.static(clientDist))

app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'))
})

export default app
