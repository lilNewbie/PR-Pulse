// Owned by Mandaar
import { createHmac, timingSafeEqual } from 'crypto'

const PREFIX = 'sha256='

// Checks GitHub's X-Hub-Signature-256: HMAC-SHA256 of the raw request body with the repo's webhook secret.
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith(PREFIX)) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  const given = Buffer.from(header.slice(PREFIX.length), 'hex')
  // Lengths must match before timingSafeEqual; a wrong length is simply a bad signature.
  return given.length === expected.length && timingSafeEqual(given, expected)
}
