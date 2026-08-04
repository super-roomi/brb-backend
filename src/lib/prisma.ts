import { PrismaClient } from "@prisma/client";
import { env } from "../env.js";
import { logger } from "./logger.js";

// Prisma's default pool size is `physicalCpuCount * 2 + 1`, and inside a
// container `physicalCpuCount` reports the HOST's cores — not the fraction of a
// core the instance actually gets. On a small managed Postgres with no
// PgBouncer in front (Render ships none), that silently opens far more backends
// than the database can afford, and each one costs several MB of its RAM.
//
// So pin the pool explicitly, and give every query a statement timeout so one
// pathological plan can't hold a connection until the request times out.
// Anything already present in DATABASE_URL wins, so an operator can still
// override per-environment without a code change.
function datasourceUrl(): string | undefined {
  const raw = process.env.DATABASE_URL;
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not parseable as a URL (unusual driver syntax) — hand it through
    // untouched rather than breaking a connection string that already works.
    return raw;
  }

  const setIfAbsent = (key: string, value: string) => {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  };

  setIfAbsent("connection_limit", String(env.dbConnectionLimit));
  setIfAbsent("pool_timeout", String(env.dbPoolTimeoutSec));
  // Fail fast when the database is unreachable instead of hanging the request.
  setIfAbsent("connect_timeout", "10");
  // Server-side cap. `options` is passed straight through to Postgres.
  setIfAbsent("options", `-c statement_timeout=${env.dbStatementTimeoutMs}`);

  return url.toString();
}

const url = datasourceUrl();

export const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);

// Readiness probe helper. Wrapped in its own timeout because a connection stuck
// in the pool would otherwise make the health check hang for as long as the
// request timeout — and a health check that hangs reads as "healthy" to some
// load balancers right up until it doesn't.
export async function pingDatabase(timeoutMs = 3_000): Promise<boolean> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db ping timed out")), timeoutMs).unref(),
      ),
    ]);
    return true;
  } catch (err) {
    logger.warn({ err }, "database ping failed");
    return false;
  }
}
