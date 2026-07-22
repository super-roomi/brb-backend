import "dotenv/config";

const isProd = (process.env.NODE_ENV ?? "development") === "production";

// Known placeholder from .env.example — must never authenticate real traffic.
const DEV_ACCESS_SECRET = "dev-access-secret-change-me";

// The JWT signing secret is the single credential protecting every session and
// admin action. In production it must be set to a real, non-placeholder value;
// falling back to the checked-in dev default would let anyone forge tokens.
function accessSecret(): string {
  const v = process.env.JWT_ACCESS_SECRET;
  if (isProd) {
    if (!v || v === DEV_ACCESS_SECRET) {
      throw new Error(
        "JWT_ACCESS_SECRET must be set to a strong, non-default value in production " +
          "(generate one with `openssl rand -hex 32`).",
      );
    }
    return v;
  }
  return v ?? DEV_ACCESS_SECRET;
}

// Placeholder until real Google Cloud Console credentials exist. Login via
// Google fails against this value; the test-login endpoint covers development.
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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  accessSecret: accessSecret(),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  // Admin tokens have no refresh path, so a short TTL means being logged out
  // mid-edit. An internal panel tolerates a longer-lived token.
  adminAccessTtl: process.env.ADMIN_ACCESS_TOKEN_TTL ?? "8h",
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  googleClientIds,
  googleConfigured: !googleClientIds.includes(GOOGLE_CLIENT_ID_PLACEHOLDER),
  appleClientIds,
  // Password-less developer login. Never enabled in production unless the
  // operator opts in explicitly (e.g. a staging deploy behind other controls).
  // Forgiving parse (true/1/yes, any case) — a "True" typed into a dashboard
  // env-var field shouldn't silently keep the gate closed.
  testLoginEnabled: !isProd || /^(true|1|yes)$/i.test((process.env.ENABLE_TEST_LOGIN ?? "").trim()),
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  isProd,
  isTest: process.env.NODE_ENV === "test",
};
