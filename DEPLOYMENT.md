# Deployment (Railway)

This backend deploys on Railway from this repo. Railway builds with Nixpacks
(`npm ci` → `npm run build`) and runs `npm start`, which is:

```
prisma migrate deploy && node dist/server.js
```

So **migrations run automatically on every deploy** against the linked Postgres.

## Required environment variables

Set these in the Railway service **Variables** tab before deploying this change.

| Variable | Required? | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Injected automatically by the linked Railway Postgres. |
| `NODE_ENV` | **yes → `production`** | Turns on the security hardening below. Without it the server runs in dev mode (insecure JWT fallback). |
| `JWT_ACCESS_SECRET` | **yes** | A strong random value: `openssl rand -hex 32`. **The server now refuses to boot in production if this is missing or still the dev placeholder** — set it or the deploy will crash-loop. |
| `CORS_ORIGINS` | yes | Comma-separated; must include the deployed admin panel's origin. |
| `GOOGLE_CLIENT_ID` | required for login | Comma-separated Google OAuth client id(s) accepted as ID-token audience (at minimum the WEB client id the app uses as `serverClientId`). While it is the checked-in placeholder, `/api/auth/google` returns 503 `GOOGLE_NOT_CONFIGURED`. |
| `ENABLE_TEST_LOGIN` | optional | `true` exposes `POST /api/auth/test-login` on a production-mode deploy (staging only — it is password-less). Outside production it is always on. |
| `ADMIN_ACCESS_TOKEN_TTL` | optional | Defaults to `8h`. |
| `LOG_LEVEL` | optional | Defaults to `info`. Logs are JSON on stdout — Railway captures them. |

> **Most important for this deploy:** if `NODE_ENV=production` is set but
> `JWT_ACCESS_SECRET` is not, the app will fail to start. Set the secret first.

## What changed that's deploy-relevant

- **Logging is transport-free JSON.** The logger does not use a `pino-pretty`
  transport, so it never depends on a devDependency at runtime — safe on
  Railway. Pretty output is a local-dev-only shell pipe (`npm run dev`).
- **New migration `20260713000000_reservation_overlap_exclusion`** runs on
  deploy. It executes `CREATE EXTENSION IF NOT EXISTS btree_gist` and adds a
  GiST exclusion constraint. Railway's default Postgres role is a superuser and
  the image ships `btree_gist`, so this succeeds; if a first deploy fails on the
  extension, confirm the DB role can `CREATE EXTENSION`. The constraint will
  fail to apply only if the DB already contains overlapping barber
  reservations — none should exist, since the app has always prevented them.
- **Graceful shutdown** on `SIGTERM` (which Railway sends on redeploy) drains
  in-flight requests and closes the DB pool, so redeploys don't drop live
  requests.
- **`engines.node` is `>=20`** so the builder selects a modern Node.

## Health checks

- Liveness: `GET /api/health` (no DB).
- Readiness: `GET /api/health/ready` (runs `SELECT 1`; 503 if the DB is down).
  Point Railway's health check at `/api/health/ready` if configuring one.
