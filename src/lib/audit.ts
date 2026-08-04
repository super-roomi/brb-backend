import type { Request } from "express";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

// Append-only trail of state-changing admin actions.
//
// Best-effort by design: an audit write must never fail the operation it is
// recording. A failure is logged loudly (it means the trail has a hole) but
// swallowed — refusing an admin's subscription renewal because the log table
// was momentarily unavailable would be the worse outcome.
//
// Reads are deliberately absent: this records writes only. Adding every GET
// would bury the entries that matter under dashboard polling.
export interface AuditEntry {
  action: string; // dotted verb, e.g. "shop.visibility"
  targetType: string;
  targetId?: string | null;
  detail?: unknown; // JSON-encoded; keep it small and free of secrets
}

// The admin's identity comes from the verified token (req.auth) — never from
// the request body — so a caller can't attribute their action to someone else.
export function audit(req: Request, entry: AuditEntry): void {
  const actorId = req.auth?.userId;
  if (!actorId) return; // not an authenticated admin request; nothing to attribute

  void (async () => {
    try {
      const admin = await prisma.adminUser.findUnique({
        where: { id: actorId },
        select: { email: true },
      });
      await prisma.auditLog.create({
        data: {
          actorId,
          actorEmail: admin?.email ?? "unknown",
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          detail: entry.detail === undefined ? null : safeStringify(entry.detail),
          ip: req.ip ?? null,
        },
      });
    } catch (err) {
      logger.error({ err, action: entry.action }, "audit log write failed");
    }
  })();
}

// Detail is operator-facing context, not a payload to replay. Cap it so a
// pathological body can't write a megabyte per admin click.
const MAX_DETAIL_CHARS = 2_000;

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (s === undefined) return String(value);
    return s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}…[truncated]` : s;
  } catch {
    return "[unserializable]";
  }
}
