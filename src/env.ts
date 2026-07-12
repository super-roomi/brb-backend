import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  accessSecret: req("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  refreshSecret: req("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? "15m",
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  smsProvider: process.env.SMS_PROVIDER ?? "console",
  corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  isProd: (process.env.NODE_ENV ?? "development") === "production",
  isTest: process.env.NODE_ENV === "test",
};
