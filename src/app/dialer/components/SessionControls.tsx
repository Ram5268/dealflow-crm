"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

/** Start/pause/end a dial session. Surfaces the 403/503 guard errors inline. */
// Brief 37: `disabled` while calling is off (the route answers 403 regardless).
export function SessionControls({ disabled = false }: { disabled?: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(method: "power" | "predictive") {
    if (disabled) return;
    setError(null);
    const res = await fetch("/api/telephony/dial-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        viewId: "save_default",
        method,
        lineCount: 1,
        callerId: process.env.NEXT_PUBLIC_CALLER_ID ?? "+10000000000",
      }),
    });
    if (res.ok) {
      const j = await res.json();
      setSessionId(j.sessionId);
    } else {
      const e = await res.json().catch(() => ({ error: "unknown" }));
      setError(e.error ?? "failed");
    }
  }

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-elevated">
      <h2 className="bg-active px-3 py-2 text-xs font-medium text-muted">Session</h2>
      <div className="p-3">
        {/* One primary per group: Close never sits two filled buttons side by
            side. Which session each starts, and every guard behind them, is
            unchanged. */}
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => start("power")} disabled={disabled}>
            Start power session
          </Button>
          <Button variant="secondary" onClick={() => start("predictive")} disabled={disabled}>
            Start predictive session
          </Button>
        </div>
        {sessionId && <div className="mt-2 text-base text-muted">Session: {sessionId}</div>}
        {error && (
          <div className="mt-2 text-base text-danger">
            {error === "loser_twiml_unapproved"
              ? "Predictive blocked: loser message not yet approved."
              : error === "pacing_halted"
                ? "Halted: abandonment circuit breaker tripped."
                : error === "spend_cap_reached"
                  ? "Halted: monthly spend cap reached."
                  : error === "dialing_disabled"
                    ? "Calling is off."
                    : `Error: ${error}`}
          </div>
        )}
      </div>
    </section>
  );
}
