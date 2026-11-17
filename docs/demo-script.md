# Final demo script

Run top to bottom on the graded deployment. Each step lists what to do, what should happen, and the error or
permission case for that story. Anything that fails in the rehearsal is either fixed or moved to In progress.

**Status: draft.** Owners, confirm your story's steps and fill in each `TODO`.

## Before the demo

- [ ] Graded deployment is up: `GET /health` returns 200 (Render or localhost: TBD with the team).
- [ ] Final `main` deployed, every migration applied (`npm start` runs `npm run migrate` first).
- [ ] `npm run seed` has run (seeded deployments, file touches and a release-blocker PR, from Mallikarjun's seed).
- [ ] The sandbox repo `pr-pulse-test/sandbox` is connected and its webhook includes `deployment_status`
      (repo **Settings → Webhooks → Recent Deliveries** shows 202s).
- [ ] Signed in on separate browser profiles:
  - **Lead**: TODO (account)
  - **Reviewer**: TODO (account)
  - **PR Author**: TODO (account; the "second account" that opens PRs)
- [ ] `npm run backfill` has run on the graded database, so expertise and suggestions have history.

## Stories

### 1. US-01 Sign in with GitHub (Alan)
1. Open the app signed out → redirected to sign-in. Sign in as the Lead → **My PRs** loads.
2. **Error case:** call `GET /api/me` with no session cookie → 401.
3. **Error case:** a user with no accessible connected repo sees the "no connected repo" notice.

### 2. US-05 Connect a repository (Kaushik)
1. As the Lead, open **Team Repos** and connect `pr-pulse-test/sandbox` (or show it already connected, with its sync status).
2. **Error cases:** connect it again → "This repository is already connected"; a repo that doesn't exist →
   "Repository not found"; a repo where you aren't a GitHub admin → "You need admin access to this repo on GitHub".
3. **Permission case:** as the Reviewer, `POST /api/repos` → 403.

### 3. US-07 Ranked review queue and US-04 release-blocking PRs first (Alan)
1. As the Reviewer, open **Review Queue**: PRs ordered by wait time, then lines changed.
2. US-04: the seeded release-blocker PR is at the top with a **Release blocker** badge, above a PR that has waited longer.
3. On GitHub, add the `release-blocker` label to another sandbox PR → within a minute it moves to the top.
   Remove the label → it returns to its normal position.
4. **Error case:** the PR Author doesn't see their own PR in their queue.

### 4. US-02 Keep my queue current after I review (Mandaar)
1. As the Reviewer, submit a review on a queued sandbox PR on GitHub → it leaves the queue within a minute.
2. **Error case:** a webhook with a bad signature → 401 and nothing changes (show the test or a `curl`).

### 5. US-08 Stale and US-09 conflict / behind-main flags (Mandaar)
1. As the PR Author, open **My PRs**: the stale, merge conflict and behind-main flags show on the seeded PRs.
2. Comment on the stale PR on GitHub → the stale flag clears after sync.
3. **Error case:** TODO (Mandaar).

### 6. US-10 Recover from missed webhooks and sync failures (Mandaar / Mallikarjun)
1. Show the last-synced time on the queue. Explain the 15-minute scheduled sync (DR-01).
2. **Error case:** a repo that hit the rate limit shows its sync status and recovers on the next run. TODO: how to show it live.

### 7. US-11 PRs suggested to me, with the reason (Mandaar)
1. From the PR Author account, open a sandbox PR that changes a file the Reviewer last committed to.
2. As the Reviewer, **Review Queue → Suggested for you** shows it with "You changed `<path>` on `<date>`".
3. **Permission case:** as the PR Author, `GET /api/suggestions` → 403. The PR's author is never suggested for it.

### 8. US-15 Explain reviewer expertise (Kaushik)
1. As the Reviewer, open **Expertise**, pick `pr-pulse-test/sandbox`: up to 10 areas with commit count and last commit date, newest first.
2. Push a commit touching `src/auth/` to the sandbox default branch → reload within a minute: `src/auth` count and date go up.
3. **Empty case:** pick a repo with no commits by this user → "No contribution history in this repository".
4. **Permission case:** `GET /api/me/expertise?repoId=<repo I can't access>` → 403; without `repoId` → 400.

### 9. US-13 Review deployment history (Mallikarjun)
1. As the Lead, open **Deployments**, pick the sandbox repo: seeded deploys newest first, with environment,
   date, status (red **Failed** on the failed one), source and PR count.
2. Filter **Production** → only production deploys.
3. **Empty case:** a repo with no deploys → "No deployments recorded for this repository".
4. **Permission case:** the Reviewer has no **Deployments** nav link; `GET /api/deployments?repoId=…` → 403.

### 10. US-12 Trace a regression to a deploy (Alan)
1. In the sandbox repo, **Actions → Fake deploy → Run workflow** with `staging` / `success`.
2. Within a minute it appears in **Deployments**. Open it: the PRs merged since the previous successful staging deploy, each linking to GitHub.
3. Run it again with `failure` → the detail shows a red **Failed** label and still lists its PRs.
4. **Edge cases:** the first production deploy shows "No previous deploy to compare"; a deploy with nothing merged shows "No linked PR";
   a `preview` run is ignored (nothing new in the list).
5. **Permission case:** as the Reviewer, `GET /api/deployments/<id>` → 403.

## Not in this demo (confirm on the board)

These stories in `design.md` §7.1 have no route on `main` as of 2026-11-17. Mark them In progress or show them only if they land:
- US-03 Disconnect a repository (`DELETE /api/repos/:id`)
- US-06 Manage team roles (`PATCH /api/members/:id/role`)
- US-14 Export bottleneck data (`GET /api/export`)
- US-16 Record a manual deployment: the API exists (`POST /api/deployments`), but there's no page, no "Unknown commit" check and no tests yet.
