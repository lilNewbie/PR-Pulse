// Owned by Mandaar. Fires one `deployment_status` webhook on the test repo for the US-12 fixture.
// Run it while capture-webhooks.ts and smee-client run (or use record-deployment.sh).
//
//   GITHUB_TOKEN=... WEBHOOK_URL=https://smee.io/<channel> \
//     npx tsx test/fixtures/github/tools/trigger-deployment.ts
//
// GITHUB_TOKEN: your account, admin on the repo (repo + admin:repo_hook scopes).
// Optional: FIXTURE_REPO (default pr-pulse-test/sandbox), FIXTURE_ENVIRONMENT (default staging).
//
// It adds a temporary webhook subscribed to deployment_status only, creates a deployment of the default
// branch's head and marks it successful. Then it cleans up: the deployment is made inactive and deleted,
// the webhook is removed, and the environment is deleted if this run created it. It doesn't push,
// open PRs or touch existing PRs. Tokens are never written to disk.
import { randomBytes } from 'crypto'

const API = 'https://api.github.com'
const repo = process.env.FIXTURE_REPO ?? 'pr-pulse-test/sandbox'
const token = process.env.GITHUB_TOKEN ?? ''
const hookUrl = process.env.WEBHOOK_URL ?? ''
const environment = process.env.FIXTURE_ENVIRONMENT ?? 'staging'
const DELIVERY_WAIT_MS = 8000

type J = { [key: string]: unknown }

async function gh(method: string, path: string, body?: unknown): Promise<J> {
  const res = await fetch(API + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-pulse-fixture-trigger',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const json = (text ? JSON.parse(text) : {}) as J
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${String(json.message ?? text)}`)
  return json
}

async function environmentExists(): Promise<boolean> {
  try {
    await gh('GET', `/repos/${repo}/environments/${encodeURIComponent(environment)}`)
    return true
  } catch (err) {
    if (err instanceof Error && err.message.includes('-> 404')) return false
    throw err
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  if (!token) throw new Error('Set GITHUB_TOKEN')
  if (!hookUrl) throw new Error('Set WEBHOOK_URL (your smee channel)')

  const hadEnvironment = await environmentExists()
  const { default_branch: branch } = (await gh('GET', `/repos/${repo}`)) as { default_branch: string }

  const hook = (await gh('POST', `/repos/${repo}/hooks`, {
    name: 'web',
    active: true,
    events: ['deployment_status'],
    config: { url: hookUrl, content_type: 'json', secret: randomBytes(16).toString('hex') },
  })) as { id: number }
  console.log(`webhook ${hook.id} added (deployment_status only)`)

  let deploymentId: number | null = null
  try {
    const deployment = (await gh('POST', `/repos/${repo}/deployments`, {
      ref: branch,
      environment,
      description: 'Fixture recording (US-12)',
      auto_merge: false,
      required_contexts: [],
    })) as { id: number; sha: string }
    deploymentId = deployment.id
    console.log(`deployment ${deployment.id} created: ${environment} @ ${deployment.sha.slice(0, 7)}`)

    await gh('POST', `/repos/${repo}/deployments/${deployment.id}/statuses`, { state: 'success', environment })
    console.log('status: success')
    await pause(DELIVERY_WAIT_MS) // let the delivery reach smee before the hook goes away
  } finally {
    if (deploymentId !== null) {
      await gh('POST', `/repos/${repo}/deployments/${deploymentId}/statuses`, { state: 'inactive' }).catch(() => undefined)
      await gh('DELETE', `/repos/${repo}/deployments/${deploymentId}`).catch((e: Error) =>
        console.log(`could not delete deployment ${deploymentId}: ${e.message}`),
      )
      console.log(`deployment ${deploymentId} deleted`)
    }
    await gh('DELETE', `/repos/${repo}/hooks/${hook.id}`)
    console.log(`webhook ${hook.id} removed`)
    if (!hadEnvironment) {
      await gh('DELETE', `/repos/${repo}/environments/${encodeURIComponent(environment)}`).catch((e: Error) =>
        console.log(`could not delete environment ${environment}: ${e.message}`),
      )
      console.log(`environment ${environment} removed (this run created it)`)
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
