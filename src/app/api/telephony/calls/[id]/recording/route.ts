import { prisma } from "@/lib/prisma";
import { presignRecording } from "@/lib/telephony/twilio/recording";

/**
 * 302-redirect to a short-lived (300s) presigned R2 URL for the call recording.
 * The R2 URL is NEVER exposed directly. 404 if there is no stored recording.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const call = await prisma.call.findUnique({
    where: { id },
    select: { recordingUrl: true },
  });
  if (!call?.recordingUrl) return new Response("no recording", { status: 404 });

  const signed = await presignRecording(call.recordingUrl);
  return Response.redirect(signed, 302);
}
