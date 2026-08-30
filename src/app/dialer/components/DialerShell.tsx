"use client";

import { useEffect, useState } from "react";
import { Softphone } from "./Softphone";
import { AmmunitionPanel } from "./AmmunitionPanel";
import { SessionControls } from "./SessionControls";
import { nextActiveCallId, type CallStreamEvent } from "@/lib/telephony/softphone/activeCall";

/**
 * Client shell that coordinates the active call across the softphone and
 * ammunition panel. Subscribes to the `crm_call` SSE bridge; on `call.connected`
 * it lifts the callId so the Softphone joins the conference and the panel
 * hydrates.
 */
export function DialerShell() {
  const [activeCallId, setActiveCallId] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/telephony/stream");
    es.onmessage = (e) => {
      let evt: CallStreamEvent;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return; // keepalive or non-JSON frame
      }
      // Functional updater, not a captured value: the stream is opened once
      // (deps []), so reading `activeCallId` directly here would read the
      // mount-time null forever and `call.completed` could never clear the
      // panel. `prev` is always the live value.
      setActiveCallId((prev) => nextActiveCallId(prev, evt));
    };
    es.onerror = () => {
      /* browser auto-reconnects */
    };
    return () => es.close();
  }, []);

  return (
    <div className="mx-auto grid max-w-4xl gap-4 p-4 md:grid-cols-2">
      <div className="space-y-4">
        <SessionControls />
        <Softphone activeCallId={activeCallId} />
      </div>
      <AmmunitionPanel activeCallId={activeCallId} />
    </div>
  );
}
