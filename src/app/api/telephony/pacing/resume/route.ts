import { prisma } from "@/lib/prisma";
import { clearHalt } from "@/lib/telephony/pacing/haltState";

/**
 * Un-halt the circuit breaker. Bearer-authed with CRON_SECRET (system/admin
 * endpoint). Brief §3 path. After resume, new dial sessions are accepted again.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET ?? ""}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return new Response("unauthorized", { status: 401 });
  }
  await clearHalt(prisma);
  return Response.json({ resumedAt: new Date().toISOString() });
}
