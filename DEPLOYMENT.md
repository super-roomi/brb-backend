# Deployment (Render)

This backend deploys on **Render**, described by [`render.yaml`](./render.yaml)
(a Render Blueprint). Connect the repo once via *Dashboard → New → Blueprint*;
Render then creates the web service and Postgres and prompts for every variable
marked `sync: false`.

> Earlier revisions of this file documented Railway. The service now runs on
> Render (`brb-backend-*.onrender.com`); Railway is no longer used.

The deploy sequence is:

```
npm ci --include=dev && npm run build   # build
npm run db:deploy                       # preDeploy: prisma migrate deploy
npm start                               # node dist/server.js
```

**Migrations run in `preDeployCommand`, not at process start.** They apply
exactly once per deploy, before any new instance boots, and a failed migration
aborts the deploy instead of crash-looping every instance. (Running them inside
`npm start` meant concurrent `migrate deploy` runs contending for Prisma's
advisory lock as soon as there was more than one instance.)

## Required environment variables

| Variable | Required? | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Injected automatically by the linked Render Postgres. |
| `NODE_ENV` | **yes → `production`** | Turns on the hardening below. Without it the server runs in dev mode, which includes the password-less test login. |
| `JWT_ACCESS_SECRET` | **yes** | Customer sessions. `openssl rand -hex 32`. **The server refuses to boot in production if this is missing or still the dev placeholder.** |
| `JWT_ADMIN_SECRET` | **yes** | Admin panel sessions, signed with a **separate** secret and audience. The server refuses to boot in production if it is missing, the placeholder, or equal to `JWT_ACCESS_SECRET`. |
| `CORS_ORIGINS` | yes | Comma-separated; must include the deployed admin panel's origin. Defaults to `http://localhost:5173`, so an unset value fails closed — the panel simply can't reach the API. |
| `GOOGLE_CLIENT_ID` | required for login | Comma-separated Google OAuth client id(s) accepted as ID-token audience (at minimum the WEB client id the app uses as `serverClientId`). While it is the checked-in placeholder, `/api/auth/google` returns 503 `GOOGLE_NOT_CONFIGURED`. |
| `APPLE_CLIENT_ID` | optional | Defaults to the shipping bundle id. Only needs setting to add a Service ID for a web flow, or if the bundle id changes. |
| `FIREBASE_SERVICE_ACCOUNT` | optional | Whole service-account JSON as one value. Unset ⇒ push is a silent no-op and the in-app feed is the only channel. |
| `ADMIN_ACCESS_TOKEN_TTL` | optional | Defaults to `8h`. |
| `DB_CONNECTION_LIMIT` | optional | Prisma pool size, default `5`. See "Connection pool" below. |
| `DB_POOL_TIMEOUT` | optional | Seconds to wait for a pooled connection, default `10`. |
| `DB_STATEMENT_TIMEOUT_MS` | optional | Server-side statement cap, default `15000`. |
| `NOTIFICATION_RETENTION_DAYS` | optional | Default `90`. |
| `AUDIT_RETENTION_DAYS` | optional | Default `365`. |
| `LOG_LEVEL` | optional | Defaults to `info`. JSON on stdout — Render captures it. |

> **Most important:** with `NODE_ENV=production` set, the app will not start
> until **both** JWT secrets are present, non-placeholder, and different from
> each other. Set them before the first deploy.

### `ENABLE_TEST_LOGIN` has been removed

`POST /api/auth/test-login` signs in as **any email with no credential**, which
is account takeover for every user — including barbers, whose dashboard unlocks
on an email match alone. It is now registered only when `NODE_ENV !==
"production"`, and there is deliberately **no environment flag to enable it**: a
flag puts "production has password-less login for every account" one mistyped
dashboard value away. A staging environment that wants it must not run as
production. If `ENABLE_TEST_LOGIN` is still set on the service, delete it — it
does nothing now.

## Connection pool

Prisma's default pool size is `physicalCpuCount * 2 + 1`, and inside a container
that CPU count is the **host's**, not the fraction of a core the instance gets.
Render Postgres ships no PgBouncer, so an unpinned pool can open far more
backends than a small database can afford (each costs it several MB of RAM).

`src/lib/prisma.ts` therefore appends `connection_limit`, `pool_timeout`,
`connect_timeout` and a `statement_timeout` to `DATABASE_URL` — but only for
keys not already present, so anything set explicitly in the URL still wins.

Raise `DB_CONNECTION_LIMIT` in step with the database plan, never past what the
plan allows, and remember the ceiling is *per instance*.

## Health checks

- **Liveness** `GET /api/health` — process is up. Never touches the database: a
  liveness probe that depends on the DB restarts a healthy process during a
  database blip, turning a partial outage into a crash loop.
- **Readiness** `GET /api/health/ready` — should this instance receive traffic?
  Reports 503 when the database is unreachable **or** when the process is
  draining. This is the one Render is pointed at.

## Graceful shutdown

On `SIGTERM` (what Render sends on redeploy) the process:

1. fails readiness immediately, so the load balancer stops routing to it;
2. stops the reminder sweep, the retention sweep, and any in-flight broadcast;
3. waits a short grace period for the load balancer to notice;
4. closes the listener and drains in-flight requests;
5. disconnects Prisma and exits.

A 25s deadline forces exit if anything refuses to close. An uncaught exception
or unhandled rejection runs the same path and exits non-zero, so the platform
starts a clean instance rather than serving from a process in unknown state.

`keepAliveTimeout` (65s) is set deliberately longer than the upstream proxy's
idle timeout. If the proxy reuses a connection at the same instant Node closes
it, the client gets a 502 that nothing in the application logs explains.

## Background work

Both run in-process and are safe with more than one instance:

- **Appointment reminders** (every 60s) claim each row with a compare-and-swap
  on `reminderSentAt`, so concurrent sweeps can't double-send.
- **Retention sweep** (every 6h, first run 5 min after boot) trims expired
  `RefreshToken` rows and `Notification`/`AuditLog` rows past their window, in
  bounded chunks so it can never monopolise the instance.

Announcement broadcasts (Barber of the Week) write feed rows in batches, then
meter the push wave out over several minutes so recipients don't all open the
app in the same second. A redeploy mid-broadcast ends the push phase early by
design — the feed rows are already committed, and push has always been
best-effort.

## Audit trail

Every state-changing admin action writes an `AuditLog` row (actor, action,
target, a small JSON detail, IP). Readable at `GET /api/admin/audit-logs`;
there is no write or delete route. Entries are trimmed only by the retention
sweep at `AUDIT_RETENTION_DAYS`.

## Scaling checklist

Before running more than one instance:

- [ ] Move rate limiting to a shared store (`rate-limit-redis`). The in-memory
      store means N instances allow N x the configured limit.
- [ ] Re-check `DB_CONNECTION_LIMIT` — the pool ceiling is per instance, so
      total connections are `instances x DB_CONNECTION_LIMIT`.
- [ ] Autoscaling needs a `pro` instance type **and** a Professional workspace;
      it is a step change in cost, not a toggle.
