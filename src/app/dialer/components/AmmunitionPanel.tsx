"use client";

import { useEffect, useState } from "react";
import type { AmmunitionPayload } from "@/lib/telephony/ammunition/hydrate";

/**
 * Ammunition panel. Fetches server-hydrated ammo for the active call. The
 * DialerShell feeds `activeCallId` from the `call.connected` SSE event; this
 * component fetches `/api/telephony/calls/:id/ammunition` (target <200ms after
 * the event).
 */
export function AmmunitionPanel({ activeCallId }: { activeCallId: string | null }) {
  const [data, setData] = useState<AmmunitionPayload | null>(null);

  useEffect(() => {
    if (!activeCallId) {
      setData(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/telephony/calls/${activeCallId}/ammunition`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCallId]);

  if (!activeCallId) return <aside className="rounded-lg border p-4 text-gray-400">No active call</aside>;
  if (!data) return <aside className="rounded-lg border p-4 text-gray-400">Loading ammunition…</aside>;

  return (
    <aside className="rounded-lg border p-4">
      <h2 className="mb-2 font-semibold">{data.lead?.displayName ?? "Lead"}</h2>
      {data.lead && (
        <dl className="grid grid-cols-2 gap-1 text-sm">
          <dt className="text-gray-500">Priority</dt>
          <dd>{data.lead.priorityScore ?? "—"}</dd>
          <dt className="text-gray-500">Top match fit</dt>
          <dd>{data.lead.topMatchFit ?? "—"}</dd>
          <dt className="text-gray-500">Capture</dt>
          <dd>{data.lead.captureStatus ?? "—"}</dd>
          <dt className="text-gray-500">Why</dt>
          <dd>{data.lead.matchReason ?? "—"}</dd>
          <dt className="text-gray-500">Address</dt>
          <dd>{data.lead.primaryAddressSummary ?? "—"}</dd>
        </dl>
      )}
      {data.contact && (
        <div className="mt-2 text-sm">
          <div className="text-gray-500">Phones</div>
          {data.contact.phones.map((p) => (
            <div key={p.id}>
              {p.phoneFormatted ?? p.phone} <span className="text-gray-400">({p.type})</span>
            </div>
          ))}
        </div>
      )}
      {data.lead?.dealflowDeepLink && (
        <a href={data.lead.dealflowDeepLink} className="mt-2 block text-sm text-blue-600 underline">
          Open in DealFlow
        </a>
      )}
    </aside>
  );
}
