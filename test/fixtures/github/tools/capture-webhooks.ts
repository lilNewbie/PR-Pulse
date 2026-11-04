// Owned by Mandaar. Records GitHub webhook deliveries (forwarded by smee) as fixtures.
//
//   npx tsx test/fixtures/github/tools/capture-webhooks.ts            # listens on :3009
//   npx smee-client --url <WEBHOOK_URL> --target http://localhost:3009
//
// Each wanted delivery is sanitized, re-signed with FIXTURE_WEBHOOK_SECRET and written to
// test/fixtures/github/webhooks/<name>.json. The first delivery for a name wins; delete the
// file to capture it again.
import { createServer } from 'http'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { toWebhookFixture, type Json } from './sanitize'
import { WANTED_WEBHOOKS as WANTED, fixtureName, obj, type Body } from './names'

const PORT = Number(process.env.CAPTURE_PORT ?? 3009)
const OUT_DIR = process.env.FIXTURE_OUT_DIR
  ? join(process.env.FIXTURE_OUT_DIR, 'webhooks')
  : join(__dirname, '..', 'webhooks')

function remaining(): string[] {
  return WANTED.filter((n) => !existsSync(join(OUT_DIR, `${n}.json`)))
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(202).end()

      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
      }
      const event = headers['x-github-event'] ?? '(none)'

      let body: Body
      try {
        body = obj(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json)
      } catch {
        console.log(`skip   ${event}: body is not JSON (set the webhook content type to application/json)`)
        return
      }

      const name = fixtureName(event, body)
      if (!name || !WANTED.includes(name)) {
        console.log(`skip   ${name ?? event} (not on the fixture list)`)
        return
      }
      const file = join(OUT_DIR, `${name}.json`)
      if (existsSync(file)) {
        console.log(`keep   ${name} (already captured)`)
        return
      }
      writeFileSync(file, JSON.stringify(toWebhookFixture(headers, body), null, 2) + '\n')
      const left = remaining()
      console.log(`saved  ${name}  —  ${left.length} left${left.length ? ': ' + left.join(', ') : ''}`)
    })
  })

  server.listen(PORT, () => {
    console.log(`Capturing webhooks on http://localhost:${PORT} -> ${OUT_DIR}`)
    console.log(`Still needed: ${remaining().join(', ') || 'nothing, all captured'}`)
  })
}

main()
