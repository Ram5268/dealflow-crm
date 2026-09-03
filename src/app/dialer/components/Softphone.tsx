"use client";

import { useEffect, useRef, useState } from "react";
import { Device } from "@twilio/voice-sdk";
import { SoftphoneController, type VoiceDeviceLike } from "@/lib/telephony/softphone/controller";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";

/**
 * Browser softphone shell. The testable logic lives in SoftphoneController
 * (unit-tested with a mocked transport); this component only wires the real
 * Twilio Device + buttons. Device audio is verified in the deferred device smoke.
 */
export function Softphone({ activeCallId }: { activeCallId: string | null }) {
  const controllerRef = useRef<SoftphoneController | null>(null);
  const [ready, setReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const [onCall, setOnCall] = useState(false);

  useEffect(() => {
    let device: Device | null = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/telephony/calls/token", { method: "POST" });
        const { token } = await res.json();
        device = new Device(token, { logLevel: "error" });
        await device.register();
        if (cancelled) return;
        controllerRef.current = new SoftphoneController(device as unknown as VoiceDeviceLike);
        setReady(true);
      } catch (err) {
        console.error("softphone init failed", err);
      }
    })();
    return () => {
      cancelled = true;
      device?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!ready || !activeCallId || !controllerRef.current) return;
    controllerRef.current.joinConference(activeCallId).then(() => setOnCall(true)).catch(console.error);
  }, [ready, activeCallId]);

  function toggleMute() {
    setMuted(controllerRef.current?.toggleMute() ?? false);
  }
  function hangup() {
    controllerRef.current?.hangup();
    setOnCall(false);
    setMuted(false);
  }

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-elevated">
      <h2 className="flex items-center gap-2 bg-active px-3 py-2 text-xs font-medium text-muted">
        Softphone {ready ? "· ready" : "· connecting…"}
        <span className="rounded-full bg-warning-subtle px-2 py-0.5 text-warning">read-only email</span>
      </h2>
      <div className="flex flex-wrap items-center gap-2 p-3">
        {/* Chrome only: every handler, and the !onCall guard on each control,
            is exactly as Agent B wrote it. */}
        <Button variant="secondary" onClick={toggleMute} disabled={!onCall}>
          {muted ? "Unmute" : "Mute"}
        </Button>
        <Button variant="danger" onClick={hangup} disabled={!onCall}>
          Hang up
        </Button>
        <div className="ml-auto flex gap-1">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((d) => (
            <button
              key={d}
              onClick={() => controllerRef.current?.sendDigit(d)}
              disabled={!onCall}
              className={cn(
                "h-8 w-8 rounded-md border border-line bg-elevated text-base text-fg",
                "transition-colors hover:bg-hover disabled:opacity-50 disabled:hover:bg-elevated",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
