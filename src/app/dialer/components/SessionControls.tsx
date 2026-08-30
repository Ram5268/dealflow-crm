"use client";

import { useState } from "react";

/** Start/pause/end a dial session. Surfaces the 403/503 guard errors inline. */
export function SessionControls() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(method: "power" | "predictive") {
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
    <div className="rounded-lg border border-line bg-elevated p-4">
      <div className="flex gap-2">
        <button onClick={() => start("power")} className="rounded bg-accent px-3 py-2 text-accent-fg">
          Start power session
        </button>
        <button
          onClick={() => start("predictive")}
          className="rounded bg-accent-hover px-3 py-2 text-accent-fg"
        >
          Start predictive session
        </button>
      </div>
      {sessionId && <div className="mt-2 text-sm text-muted">Session: {sessionId}</div>}
      {error && (
        <div className="mt-2 text-sm text-danger">
          {error === "loser_twiml_unapproved"
            ? "Predictive blocked: loser message not yet approved."
            : error === "pacing_halted"
              ? "Halted: abandonment circuit breaker tripped."
              : error === "spend_cap_reached"
                ? "Halted: monthly spend cap reached."
                : `Error: ${error}`}
        </div>
      )}
    </div>
  );
}
