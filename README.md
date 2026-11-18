# PR Pulse

Tracks which pull requests are waiting on your review, ranked by how long they have waited, and flags your own PRs that are stale, conflicting or behind main.

- Staging: https://pr-pulse-443w.onrender.com
- Full setup guide (OAuth apps, webhooks, staging): [docs/setup.md](docs/setup.md)

## Run it locally (fresh clone)

You need Node.js and npm, Docker Desktop (running), a GitHub account with access to `pr-pulse-test/sandbox`, and the local OAuth app credentials from the team password manager.

1. Install:
   ```sh
   git clone https://github.com/lilNewbie/PR-Pulse.git
   cd PR-Pulse
   npm install
   cp .env.example .env
   ```
2. Fill in `.env` (details in [docs/setup.md](docs/setup.md#run-it-locally)):
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: the local OAuth app, from the password manager
   - `TOKEN_KEY`, `SESSION_SECRET`: run `openssl rand -base64 32` once for each
   - `WEBHOOK_URL`: your own channel from https://smee.io/new
3. Start the database, create the schema and load demo data:
   ```sh
   docker compose up -d db
   npm run migrate
   npm run seed
   ```
4. Run the app, and forward GitHub webhooks to it in a second terminal:
   ```sh
   npm run dev
   npx smee-client --url <WEBHOOK_URL> --target http://localhost:3001/webhooks/github
   ```
   Open http://localhost:5173 and sign in with GitHub. The API runs on port 3001.
5. Connect a repo: as a Lead, open **Team Repos**, then connect `pr-pulse-test/sandbox` (or your own test repo).
   New connections subscribe to every webhook event and load commit history automatically.
6. Only for a database whose repos were connected **before** the final sprint, run these once:
   ```sh
   npm run hooks:update   # adds deployment_status to existing repo webhooks (US-12)
   npm run backfill       # loads 180 days / max 500 commits of history into file_touches (US-11, US-15)
   ```
   Both are safe to run again. Each logs one line per repo and keeps going if one repo fails.

`npm run seed` loads demo data (a team, users in each role, repos and PRs) so the pages have something to show before real GitHub data arrives.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Server and client with reload |
| `npm run migrate` | Applies every migration in `migrations/` (also runs before `npm start`) |
| `npm run seed` | Loads demo data; safe to re-run |
| `npm run hooks:update` | Patches every connected repo's webhook to the full event list |
| `npm run backfill` | Loads commit history into `file_touches` for every connected repo |
| `npm run lint && npm run typecheck && npm test` | The checks CI runs; run them before every commit |

## Tests

Tests use a separate `pr_pulse_test` database in the same Docker container. Create and migrate it once:

```sh
docker compose exec db createdb -U postgres pr_pulse_test
DATABASE_URL=postgres://postgres:postgres@localhost:5433/pr_pulse_test npm run migrate
```

Then:

```sh
npm run lint && npm run typecheck && npm test
```

Tests run against the Docker Postgres database and mock GitHub with nock.
