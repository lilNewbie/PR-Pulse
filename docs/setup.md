# Setup

Gets PR Pulse running on your laptop. Should take under 15 minutes.

## You need
- Node.js and npm
- Docker Desktop, running
- A GitHub account with access to `pr-pulse-test/sandbox`
- Access to the team password manager

## Run it locally

```sh
git clone https://github.com/lilNewbie/PR-Pulse.git
cd PR-Pulse
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The local OAuth app, from the password manager |
| `TOKEN_KEY`, `SESSION_SECRET` | Run `openssl rand -base64 32` once for each |
| `WEBHOOK_URL` | Your own channel from https://smee.io/new |

`TOKEN_KEY` must be base64 and decode to exactly 32 bytes.

Start the database and the app:

```sh
docker compose up -d db
npm run migrate && npm run seed
npm run dev
```

Open http://localhost:5173. The API runs on port 3001, and Vite forwards `/api` and `/auth` to it.

## Webhooks

GitHub can't reach localhost, so smee.io forwards events to your machine. Leave this running in a second terminal, using your `WEBHOOK_URL`:

```sh
npx smee-client --url <WEBHOOK_URL> --target http://localhost:3001/webhooks/github
```

Use your own channel and test repo so your events don't reach a teammate's server.

## Staging

Staging deploys from `main` using `render.yaml`:

1. In Render, choose **New > Blueprint** and select this repo.
2. Enter the values Render asks for, using the table below.
3. After the deploy, check that `https://pr-pulse-staging-api.onrender.com/health` returns 200.

| Variable | Value |
| --- | --- |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The staging OAuth app, from the password manager |
| `TOKEN_KEY` | Output of `openssl rand -base64 32`, the same on the API service and the cron job |
| `APP_URL`, `PUBLIC_URL` | `https://pr-pulse-staging.onrender.com` |
| `WEBHOOK_URL` | `https://pr-pulse-staging-api.onrender.com/webhooks/github` |

If Render assigns different URLs, update these values, the rewrites in `render.yaml` and the OAuth app.

Free Postgres expires after 30 days. When it does, recreate it, then run the migrations and seed data again.

## OAuth apps

There is one app per environment. The app requests the scopes `read:user repo admin:repo_hook` at sign-in. Client IDs and secrets go in the password manager, never in the repo.

| Environment | Homepage URL | Callback URL |
| --- | --- | --- |
| Local | `http://localhost:5173` | `http://localhost:5173/auth/github/callback` |
| Staging | `https://pr-pulse-staging.onrender.com` | `https://pr-pulse-staging.onrender.com/auth/github/callback` |
