# TgFleet Worker

Self-hosted Node worker for the TgFleet dashboard. Polls the dashboard for jobs, handles Telegram MTProto logins, syncs groups, and sends scheduled messages.

## What you need

1. **Telegram API credentials** — go to https://my.telegram.org → API development tools → create an app. Note `api_id` and `api_hash`.
2. **Dashboard URL** — your Lovable app URL (e.g. `https://your-app.lovable.app`).
3. **Worker token** — the `WORKER_TOKEN` secret shown in the dashboard's Worker setup page.

## Deploy to Railway (recommended, ~5 min)

1. Fork or clone this repo to your GitHub account.
2. Go to https://railway.app → **New Project** → **Deploy from GitHub repo** → pick this repo.
3. Railway detects the Dockerfile automatically. In the service **Variables** tab, add:
   - `API_BASE` — your dashboard URL
   - `WORKER_TOKEN` — from dashboard
   - `TG_API_ID` — from my.telegram.org
   - `TG_API_HASH` — from my.telegram.org
   - `WORKER_LABEL` — optional, e.g. `railway-1`
4. Deploy. Watch logs — you should see `TgFleet worker "..." → ...` within a minute.
5. The dashboard's "Sender status" indicator should turn **Online** within 30 seconds.

## Deploy to Fly.io

```bash
fly launch --no-deploy
fly secrets set API_BASE=... WORKER_TOKEN=... TG_API_ID=... TG_API_HASH=...
fly deploy
```

## Run locally

```bash
cp .env.example .env
# edit .env with your values
npm install
node --env-file=.env worker.mjs
```

## How it works

- Every 20s: sends heartbeat to `POST /api/public/worker/heartbeat`
- Every 5s: polls `POST /api/public/worker/poll` for pending logins, group syncs, and due sends
- Reports results to `POST /api/public/worker/report`

All requests are authenticated with `x-worker-token` header.

## Safety

The dashboard already enforces per-account rate limits (default 20 msgs/hour) and adds jitter. This worker honors `FLOOD_WAIT_*` errors from Telegram and reports them back so the dashboard can pause the account.

**Mass promotion violates Telegram ToS.** Accounts will get limited or banned. Use on your own or opted-in groups.
