import { prisma } from "@/lib/prisma";
import { hydrateAmmunition } from "@/lib/telephony/ammunition/hydrate";

/** Server-hydrate the ammunition panel for a call. SELECT-only across A tables. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const data = await hydrateAmmunition(prisma, id);
  if (!data) return new Response("call not found", { status: 404 });
  return Response.json(data);
}
