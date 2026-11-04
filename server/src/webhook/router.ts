// Owned by Mandaar. POST /webhooks/github (Diagram 5, US-02, NFR-03, NFR-06).
import express, { Router } from 'express'
import { z } from 'zod'
import { decrypt } from '../lib/crypto'
import { findWebhookRepo, recordDelivery } from '../db/webhookEvents'
import { verifySignature } from './signature'
import { processDelivery } from './dispatch'

const router = Router()

const repoRef = z.object({ repository: z.object({ id: z.number().int().positive() }) })
const headers = z.object({
  'x-github-delivery': z.string().min(1),
  'x-github-event': z.string().min(1),
})

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return undefined
  }
}

// Raw body: the signature is computed over the exact bytes GitHub sent.
router.post('/github', express.raw({ type: 'application/json', limit: '25mb' }), async (req, res, next) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const payload = parseJson(raw)

    // 1. Which repo? Only repository.id is read before the signature is checked; nothing is trusted yet.
    //    Not connected (or no repository at all): 200, nothing written (US-03).
    const ref = repoRef.safeParse(payload)
    const repo = ref.success ? await findWebhookRepo(ref.data.repository.id) : null
    if (!repo) {
      res.status(200).end()
      return
    }

    // 2. Signature with the repo's secret. Missing or wrong: 401, nothing written (NFR-03).
    if (!verifySignature(raw, req.get('x-hub-signature-256'), decrypt(repo.webhookSecretEnc))) {
      res.status(401).json({ error: 'Bad or missing signature' })
      return
    }

    const h = headers.safeParse(req.headers)
    if (!h.success) {
      res.status(400).json({ error: 'Missing X-GitHub-Delivery or X-GitHub-Event header' })
      return
    }
    const event = h.data['x-github-event']

    // 3. Each delivery is processed once. Repeat: 200, nothing written (NFR-06).
    if (!(await recordDelivery(h.data['x-github-delivery'], repo.id, event))) {
      res.status(200).end()
      return
    }

    // 4. Answer well inside GitHub's 10-second limit, then do the work.
    res.status(202).end()
    setImmediate(() => {
      processDelivery(repo.id, event, payload).catch((err: unknown) => {
        console.error(`webhook: processing failed for repo ${repo.id}: ${err instanceof Error ? err.message : err}`)
      })
    })
  } catch (err) {
    next(err)
  }
})

export default router
