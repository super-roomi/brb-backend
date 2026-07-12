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

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  accessSecret: accessSecret(),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  // Admin tokens have no refresh path, so a short TTL means being logged out
  // mid-edit. An internal panel tolerates a longer-lived token.
  adminAccessTtl: process.env.ADMIN_ACCESS_TOKEN_TTL ?? "8h",
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  smsProvider: process.env.SMS_PROVIDER ?? "console",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  isProd,
  isTest: process.env.NODE_ENV === "test",
};
