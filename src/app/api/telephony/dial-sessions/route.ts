import { prisma } from "@/lib/prisma";
import { createDialSession, type CreateDialSessionBody } from "@/lib/telephony/dial-sessions/create";
import { dialingEnabled, dialingDisabledResponse } from "@/lib/telephony/dialingSwitch";

/**
 * Create a dial session. Enforces the predictive loser-TwiML gate and the
 * circuit-breaker halt before inserting. MVP derives org/user from headers
 * (single seat).
 */
export async function POST(req: Request): Promise<Response> {
  if (!dialingEnabled()) return dialingDisabledResponse(); // Brief 37 calling switch
  const body = (await req.json()) as CreateDialSessionBody;
  const organizationId = req.headers.get("x-org-id") ?? "org_default";
  const userId = req.headers.get("x-user-id") ?? "user_default";

  const result = await createDialSession(prisma, body, { organizationId, userId });
  if (!result.ok) {
    return Response.json(result.body, { status: result.status });
  }
  return Response.json({ sessionId: result.sessionId, startedAt: result.startedAt }, { status: 201 });
}
