import { prisma } from "@/lib/prisma";
import { pacingStatus } from "@/lib/telephony/pacing/status";

/** Current lineCount + rolling abandonment/AMD-FP + halt flag (brief §8.1). */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const dialSessionId = url.searchParams.get("dialSessionId") ?? undefined;
  const status = await pacingStatus(prisma, dialSessionId);
  return Response.json(status);
}
