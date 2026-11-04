// Owned by Mandaar
import pool from './pool'

export interface WebhookRepo {
  id: number
  webhookSecretEnc: string
}

// The connected repo for an incoming delivery, with its encrypted webhook secret.
// Only the Webhook Receiver uses this; the secret never reaches an API response.
export async function findWebhookRepo(githubRepoId: number): Promise<WebhookRepo | null> {
  const { rows } = await pool.query<{ id: string; webhook_secret_enc: string }>(
    'SELECT id, webhook_secret_enc FROM repos WHERE github_repo_id = $1',
    [githubRepoId],
  )
  const row = rows[0]
  return row ? { id: Number(row.id), webhookSecretEnc: row.webhook_secret_enc } : null
}

// Records a delivery ID. Returns false if it was already recorded (a repeated delivery, NFR-06).
export async function recordDelivery(deliveryId: string, repoId: number, eventType: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO webhook_events (delivery_id, repo_id, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [deliveryId, repoId, eventType],
  )
  return rowCount === 1
}
