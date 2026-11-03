# GitHub fixtures

Real GitHub payloads, recorded from the test repo and replayed in tests with nock and supertest.
No test calls the real GitHub API.

| Folder | Contents | Format |
| --- | --- | --- |
| `webhooks/` | Webhook deliveries, one file per event/action | `{ headers, body }` |
| `api/` | REST API responses | `{ request: { method, path }, status, headers, body }` |
| `tools/` | Recorders and the sanitizer | |

## Using them in tests

Webhook fixtures are re-signed with `FIXTURE_WEBHOOK_SECRET` (`tools/sanitize.ts`).
The signature covers `JSON.stringify(body)`, so send exactly that string:

```ts
import fx from './fixtures/github/webhooks/pull_request.opened.json'
import { FIXTURE_WEBHOOK_SECRET } from './fixtures/github/tools/sanitize'

// The repo row must have github_repo_id = fx.body.repository.id
// and webhook_secret_enc = encrypt(FIXTURE_WEBHOOK_SECRET).
await request(app)
  .post('/webhooks/github')
  .set(fx.headers)
  .send(JSON.stringify(fx.body))
```

API fixtures map onto nock directly:

```ts
nock('https://api.github.com').get(fx.request.path).reply(fx.status, fx.body, fx.headers)
```

Pagination: GitHub's `Link` header points to `/repositories/<numeric id>/pulls?...`, not `/repos/<owner>/<name>/pulls`.
Follow the `next` URL as given, and mock page 2 on that path.

## Sanitizing

Every file goes through `tools/sanitize.ts`. It does three things:
- Replaces emails with `redacted@example.com`.
- Replaces GitHub tokens, and any value whose key is `token`, `secret`, `password` and so on, with `[REDACTED]`.
- Keeps only an allowlist of headers.

`fixtures.test.ts` fails CI if a committed fixture contains an email or token, or if a webhook signature doesn't match.

## Recording (day 1)

You need:
- Admin on the test repo (`pr-pulse-test/sandbox`) to add a webhook.
- A teammate to review, because GitHub doesn't let you review your own PR.
- Your smee channel (`WEBHOOK_URL` in `.env`).
- A GitHub token with `repo` scope. Export it in your shell only; never put it in a file.

1. In the test repo, open **Settings > Webhooks > Add webhook** and set:
   - Payload URL: your `WEBHOOK_URL`
   - Content type: `application/json`
   - Secret: anything (it gets replaced)
   - Events: *Pull requests*, *Pull request reviews*, *Issue comments*, *Pushes*
2. Start the recorder in two terminals:
   ```sh
   npx tsx test/fixtures/github/tools/capture-webhooks.ts
   npx smee-client --url "$WEBHOOK_URL" --target http://localhost:3009
   ```
   It prints each saved fixture and the ones still missing. The first delivery for a name wins; delete the file to capture it again.
3. Trigger the events in the test repo, in this order:

   | # | Do this | Captures |
   | --- | --- | --- |
   | 1 | Push branch `fx-1` with a commit; open PR 1 as a **draft** | `pull_request.opened` |
   | 2 | Mark PR 1 ready for review | `pull_request.ready_for_review` |
   | 3 | Convert PR 1 to draft, then mark it ready again | `pull_request.converted_to_draft` |
   | 4 | Push another commit to `fx-1` | `pull_request.synchronize` |
   | 5 | Request a review from your teammate | `pull_request.review_requested` |
   | 6 | Remove the request, then request it again | `pull_request.review_request_removed` |
   | 7 | Teammate submits **Request changes**, then **Approve** | `pull_request_review.submitted.changes_requested`, `.approved` |
   | 8 | Comment in PR 1's Conversation tab (not a line comment) | `issue_comment.created` |
   | 9 | Open PR 2 from `fx-2` and leave it open | (needed for pagination) |
   | 10 | Push a commit straight to `main`, so PR 1 is behind | `push.main` |
   | 11 | Open PR 3 from `fx-3`, then close it **without merging** | `pull_request.closed.unmerged` |
   | 12 | **Run the API recorder (below) on PR 1 now, before it is merged** | `api/*` |
   | 13 | Merge PR 1 | `pull_request.closed.merged` |

4. Record the API responses (step 12):
   ```sh
   GITHUB_TOKEN=... FIXTURE_PR=<PR 1 number> npx tsx test/fixtures/github/tools/record-api.ts
   ```
   It writes the following files to `api/`:
   - `pulls.list-open`, plus a two-page sample `pulls.list-open.page1`/`page2`
   - `pull`, plus `pull.mergeable-null` if GitHub was still computing mergeability
   - `pull.reviews`
   - `compare`
   - `rate-limited.403`, a real rate-limit response made by using up the unauthenticated 60/hour limit from your IP. Set `SKIP_RATE_LIMIT=1` to skip it.
5. Check the diff by eye, run `npx vitest run test/fixtures/github`, then commit.

To try the recorders without touching the repo, set `FIXTURE_OUT_DIR=/some/tmp/dir` on either script.
`GITHUB_TOKEN` can be left out for a public repo, for example `FIXTURE_REPO=octocat/Hello-World`.
