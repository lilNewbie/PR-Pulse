// Owned by Mandaar. Performs the README's recording steps on the test repo through the GitHub API,
// so every wanted webhook fires once, in order. Run it while capture-webhooks.ts and smee-client run.
//
//   GITHUB_TOKEN=... REVIEWER_TOKEN=... WEBHOOK_URL=https://smee.io/<channel> \
//     npx tsx test/fixtures/github/tools/trigger-events.ts
//
// GITHUB_TOKEN:   your account, admin on the repo (repo + admin:repo_hook scopes).
// REVIEWER_TOKEN: a teammate with access to the repo (GitHub doesn't allow reviewing your own PR).
// Optional: FIXTURE_REPO (default pr-pulse-test/sandbox), SKIP_API_RECORDING=1.
//
// It adds a webhook to WEBHOOK_URL if none exists (and removes it again at the end), creates
// branches fx-1/2/3-<stamp>, opens, reviews, comments, closes and merges PRs, then records the
// API fixtures for PR 1 before merging it. Tokens are never written to disk.
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { join } from 'path'

const API = 'https://api.github.com'
const repo = process.env.FIXTURE_REPO ?? 'pr-pulse-test/sandbox'
const authorToken = process.env.GITHUB_TOKEN ?? ''
const reviewerToken = process.env.REVIEWER_TOKEN ?? ''
const hookUrl = process.env.WEBHOOK_URL ?? ''
const stamp = Date.now().toString(36)
const STEP_DELAY_MS = 4000 // lets each webhook arrive before the next action

type J = { [key: string]: unknown }

async function gh(method: string, path: string, token: string, body?: unknown): Promise<J> {
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

async function graphql(query: string, variables: J): Promise<void> {
  const res = (await gh('POST', '/graphql', authorToken, { query, variables })) as { errors?: unknown }
  if (res.errors) throw new Error(`GraphQL: ${JSON.stringify(res.errors)}`)
}

const pause = (ms = STEP_DELAY_MS) => new Promise((r) => setTimeout(r, ms))

function step(n: number, what: string): void {
  console.log(`[${n}] ${what}`)
}

async function branchFrom(base: string, name: string): Promise<void> {
  const ref = (await gh('GET', `/repos/${repo}/git/ref/heads/${base}`, authorToken)) as { object: { sha: string } }
  await gh('POST', `/repos/${repo}/git/refs`, authorToken, { ref: `refs/heads/${name}`, sha: ref.object.sha })
}

async function commitFile(branch: string, path: string, content: string): Promise<void> {
  await gh('PUT', `/repos/${repo}/contents/${path}`, authorToken, {
    message: `fixture: ${path}`,
    content: Buffer.from(content).toString('base64'),
    branch,
  })
}

async function openPr(head: string, base: string, title: string, draft: boolean): Promise<{ number: number; node_id: string }> {
  return (await gh('POST', `/repos/${repo}/pulls`, authorToken, { head, base, title, draft, body: 'Fixture recording' })) as {
    number: number
    node_id: string
  }
}

const READY = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }'
const DRAFT = 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }'

async function main(): Promise<void> {
  if (!authorToken || !reviewerToken || !hookUrl) {
    console.error('Set GITHUB_TOKEN, REVIEWER_TOKEN and WEBHOOK_URL (your smee channel).')
    process.exit(1)
  }

  const me = (await gh('GET', '/user', authorToken)) as { login: string }
  const reviewer = (await gh('GET', '/user', reviewerToken)) as { login: string }
  if (me.login === reviewer.login) throw new Error('REVIEWER_TOKEN must belong to a different account')
  const repoInfo = (await gh('GET', `/repos/${repo}`, authorToken)) as { default_branch: string }
  const main = repoInfo.default_branch
  console.log(`repo ${repo} (default branch ${main}), author ${me.login}, reviewer ${reviewer.login}`)

  // Webhook pointing at the smee channel.
  const hooks = (await gh('GET', `/repos/${repo}/hooks`, authorToken)) as unknown as { id: number; config: { url?: string } }[]
  let createdHookId: number | null = null
  if (!hooks.some((h) => h.config.url === hookUrl)) {
    const hook = (await gh('POST', `/repos/${repo}/hooks`, authorToken, {
      name: 'web',
      active: true,
      events: ['pull_request', 'pull_request_review', 'issue_comment', 'push'],
      config: { url: hookUrl, content_type: 'json', secret: randomBytes(16).toString('hex') },
    })) as { id: number }
    createdHookId = hook.id
    console.log(`added webhook ${hook.id} -> ${hookUrl}`)
    await pause()
  }

  const [b1, b2, b3] = [1, 2, 3].map((i) => `fx-${i}-${stamp}`)
  try {
    step(1, 'open PR 1 as a draft')
    await branchFrom(main, b1)
    await commitFile(b1, `fixtures/${stamp}/one.txt`, 'first commit\n')
    const pr1 = await openPr(b1, main, `Fixture PR 1 (${stamp})`, true)
    await pause()

    step(2, 'mark PR 1 ready for review')
    await graphql(READY, { id: pr1.node_id })
    await pause()

    step(3, 'convert PR 1 to draft, then ready again')
    await graphql(DRAFT, { id: pr1.node_id })
    await pause()
    await graphql(READY, { id: pr1.node_id })
    await pause()

    step(4, 'push another commit to PR 1')
    await commitFile(b1, `fixtures/${stamp}/two.txt`, 'second commit\n')
    await pause()

    const reviewers = `/repos/${repo}/pulls/${pr1.number}/requested_reviewers`
    step(5, `request review from ${reviewer.login}`)
    await gh('POST', reviewers, authorToken, { reviewers: [reviewer.login] })
    await pause()

    step(6, 'remove the review request, then request again')
    await gh('DELETE', reviewers, authorToken, { reviewers: [reviewer.login] })
    await pause()
    await gh('POST', reviewers, authorToken, { reviewers: [reviewer.login] })
    await pause()

    step(7, 'reviewer requests changes, then approves')
    const reviews = `/repos/${repo}/pulls/${pr1.number}/reviews`
    await gh('POST', reviews, reviewerToken, { event: 'REQUEST_CHANGES', body: 'Fixture: please change this.' })
    await pause()
    await gh('POST', reviews, reviewerToken, { event: 'APPROVE', body: 'Fixture: looks good.' })
    await pause()

    step(8, 'comment on PR 1')
    await gh('POST', `/repos/${repo}/issues/${pr1.number}/comments`, authorToken, { body: 'Fixture comment.' })
    await pause()

    step(9, 'open PR 2 and leave it open')
    await branchFrom(main, b2)
    await commitFile(b2, `fixtures/${stamp}/other.txt`, 'pr 2\n')
    const pr2 = await openPr(b2, main, `Fixture PR 2 (${stamp})`, false)
    await pause()

    step(10, `push a commit straight to ${main} so PR 1 is behind`)
    await commitFile(main, `fixtures/${stamp}/main.txt`, 'direct push to main\n')
    await pause()

    step(11, 'open PR 3 and close it without merging')
    await branchFrom(main, b3)
    await commitFile(b3, `fixtures/${stamp}/three.txt`, 'pr 3\n')
    const pr3 = await openPr(b3, main, `Fixture PR 3 (${stamp})`, false)
    await pause()
    await gh('PATCH', `/repos/${repo}/pulls/${pr3.number}`, authorToken, { state: 'closed' })
    await pause()

    if (process.env.SKIP_API_RECORDING !== '1') {
      step(12, `record API fixtures for PR 1 (#${pr1.number}) before it is merged`)
      execFileSync('npx', ['tsx', join(__dirname, 'record-api.ts')], {
        stdio: 'inherit',
        env: { ...process.env, FIXTURE_REPO: repo, FIXTURE_PR: String(pr1.number) },
      })
    }

    step(13, 'merge PR 1')
    await gh('PUT', `/repos/${repo}/pulls/${pr1.number}/merge`, authorToken, { merge_method: 'merge' })
    await pause()

    // Tidy the sandbox. Closing PR 2 fires another closed.unmerged, which the recorder ignores.
    await gh('PATCH', `/repos/${repo}/pulls/${pr2.number}`, authorToken, { state: 'closed' })
  } finally {
    for (const b of [b1, b2, b3]) {
      await gh('DELETE', `/repos/${repo}/git/refs/heads/${b}`, authorToken).catch(() => undefined)
    }
    if (createdHookId !== null) {
      await gh('DELETE', `/repos/${repo}/hooks/${createdHookId}`, authorToken).catch(() => undefined)
      console.log(`removed webhook ${createdHookId}`)
    }
  }
  console.log('done. Check the recorder output for anything still missing.')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
