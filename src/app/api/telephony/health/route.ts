import { isHalted } from "@/lib/telephony/pacing/haltState";

/** Health check. Reports the global pacing halt flag so ops can see circuit state. */
export async function GET(): Promise<Response> {
  const halt = await isHalted();
  return Response.json({
    status: "ok",
    version: process.env.npm_package_version ?? "0.1.0",
    halted: halt.halted,
    ...(halt.reason ? { haltReason: halt.reason } : {}),
  });
}
