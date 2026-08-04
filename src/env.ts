import "dotenv/config";

const isProd = (process.env.NODE_ENV ?? "development") === "production";

// Known placeholder from .env.example — must never authenticate real traffic.
const DEV_ACCESS_SECRET = "dev-access-secret-change-me";
const DEV_ADMIN_SECRET = "dev-admin-secret-change-me";

// The JWT signing secret is the single credential protecting every session and
// admin action. In production it must be set to a real, non-placeholder value;
// falling back to the checked-in dev default would let anyone forge tokens.
function requireSecret(name: string, placeholder: string): string {
  const v = process.env[name];
  if (isProd) {
    if (!v || v === placeholder) {
      throw new Error(
        `${name} must be set to a strong, non-default value in production ` +
          "(generate one with `openssl rand -hex 32`).",
      );
    }
    return v;
  }
  return v ?? placeholder;
}

const accessSecret = requireSecret("JWT_ACCESS_SECRET", DEV_ACCESS_SECRET);

// Admin tokens are signed with their OWN secret. Sharing one secret with
// customer tokens meant a single leak handed out platform admin, and it left
// only the `role` claim between a customer token and the admin panel. Two
// secrets make an admin token unforgeable even if the customer secret leaks.
// Falls back to the customer secret outside production so local dev and the
// test suite work without a second variable.
function adminSecretValue(): string {
  const v = process.env.JWT_ADMIN_SECRET;
  if (isProd) {
    if (!v || v === DEV_ADMIN_SECRET) {
      throw new Error(
        "JWT_ADMIN_SECRET must be set to a strong, non-default value in production " +
          "(generate one with `openssl rand -hex 32`).",
      );
    }
    if (v === accessSecret) {
      throw new Error(
        "JWT_ADMIN_SECRET must differ from JWT_ACCESS_SECRET — sharing one secret " +
          "defeats the point of separating admin and customer tokens.",
      );
    }
    return v;
  }
  return v ?? accessSecret;
}

// Placeholder until real Google Cloud Console credentials exist. Login via
// Google fails against this value.
const GOOGLE_CLIENT_ID_PLACEHOLDER =
  "YOUR_WEB_CLIENT_ID.apps.googleusercontent.com";

// Accepted `aud` values for Google ID tokens. Comma-separated so the web,
// Android and iOS OAuth client ids can all be listed once they exist.
const googleClientIds = (process.env.GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID_PLACEHOLDER)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Accepted `aud` values for Apple identity tokens. For the native iOS flow the
// audience is the app's bundle id, which is fixed and public — unlike Google,
// verifying an Apple token needs no secret, so this defaults to the shipping
// bundle id and works out of the box. Comma-separated to allow adding a future
// Service ID (the web flow's client id) without a code change.
const appleClientIds = (process.env.APPLE_CLIENT_ID ?? "com.barberapp.barberMobile")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  accessSecret,
  adminSecret: adminSecretValue(),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  // Admin tokens have no refresh path, so a short TTL means being logged out
  // mid-edit. An internal panel tolerates a longer-lived token.
  adminAccessTtl: process.env.ADMIN_ACCESS_TOKEN_TTL ?? "8h",
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  googleClientIds,
  googleConfigured: !googleClientIds.includes(GOOGLE_CLIENT_ID_PLACEHOLDER),
  appleClientIds,
  // Password-less developer login (POST /api/auth/test-login). It accepts an
  // ARBITRARY email and issues a full session for it, so exposing it in
  // production is account takeover for every user — including barbers, who are
  // matched by email. There is deliberately no env flag to turn it on: the
  // route is only registered when NODE_ENV is not "production".
  testLoginEnabled: !isProd,
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // --- Connection pool -----------------------------------------------------
  // Render Postgres ships no PgBouncer, and Prisma's default pool size is
  // `cpus * 2 + 1` where `cpus` is the HOST's core count, not the container's
  // share — so an unpinned pool can open far more connections than a 256 MB
  // database can afford. See lib/prisma.ts.
  dbConnectionLimit: intFromEnv("DB_CONNECTION_LIMIT", 5),
  dbPoolTimeoutSec: intFromEnv("DB_POOL_TIMEOUT", 10),
  // Backstop against one pathological query pinning a connection forever.
  dbStatementTimeoutMs: intFromEnv("DB_STATEMENT_TIMEOUT_MS", 15_000),

  // --- Retention -----------------------------------------------------------
  // Both tables are append-mostly and were never trimmed. See
  // services/maintenance.ts.
  notificationRetentionDays: intFromEnv("NOTIFICATION_RETENTION_DAYS", 90),
  auditRetentionDays: intFromEnv("AUDIT_RETENTION_DAYS", 365),

  isProd,
  isTest: process.env.NODE_ENV === "test",
};
