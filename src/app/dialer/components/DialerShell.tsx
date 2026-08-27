"use client";

import { useEffect, useState } from "react";
import { Softphone } from "./Softphone";
import { AmmunitionPanel } from "./AmmunitionPanel";
import { SessionControls } from "./SessionControls";

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
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === "call.connected") setActiveCallId(evt.callId);
        if (evt.type === "call.completed" && evt.callId === activeCallId) setActiveCallId(null);
      } catch {
        /* ignore non-JSON keepalives */
      }
    };
    es.onerror = () => {
      /* browser auto-reconnects */
    };
    return () => es.close();
    // activeCallId intentionally excluded — we only want one long-lived stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
