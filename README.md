# PR Pulse

Tracks which pull requests are waiting on your review, ranked by how long they have waited, and flags your own PRs that are stale, conflicting or behind main.

- Staging: https://pr-pulse-443w.onrender.com
- Full setup guide (OAuth apps, webhooks, staging): [docs/setup.md](docs/setup.md)

## Run it locally

You need Node.js, npm and Docker Desktop.

```sh
git clone https://github.com/lilNewbie/PR-Pulse.git
cd PR-Pulse
npm install
cp .env.example .env   # fill in the values, see docs/setup.md
docker compose up -d db
npm run migrate && npm run seed
npm run dev
```

Open http://localhost:5173. `npm run seed` loads demo data (a team, users in each role, repos and PRs) so the pages have something to show before real GitHub data arrives.

## Tests

```sh
npm run lint && npm run typecheck && npm test
```

Tests run against the Docker Postgres database and mock GitHub with nock.
