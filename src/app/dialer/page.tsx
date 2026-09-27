import { DialerShell } from "./components/DialerShell";
import { getCurrentOrgId } from "@/lib/shell/orgContext";
import { dialingEnabled } from "@/lib/telephony/dialingSwitch";
import { CallingOffBanner } from "@/components/CallingOffBanner";

export const dynamic = "force-dynamic";

// Shell integration only — AppShell already renders the <main> landmark and the
// "Dialer" title, so this page contributes neither. Every dial control, pacing
// rule and compliance gate stays exactly where Agent B put it. Brief 37: while
// calling is off the page shows the banner and every call control is disabled
// (the server refuses them anyway).
export default async function DialerPage() {
  const organizationId = await getCurrentOrgId();
  const enabled = dialingEnabled();
  return (
    <>
      {!enabled && (
        <div className="px-4 pt-4">
          <CallingOffBanner organizationId={organizationId} />
        </div>
      )}
      <DialerShell dialingEnabled={enabled} />
    </>
  );
}
