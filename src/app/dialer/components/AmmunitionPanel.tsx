"use client";

import { useEffect, useState } from "react";
import type { AmmunitionPayload } from "@/lib/telephony/ammunition/hydrate";
import { captureLabel, reasonText } from "@/lib/core-data/dealflow-sync/labels";

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

  if (!activeCallId) return <Shell><p className="text-base text-subtle">No active call</p></Shell>;
  if (!data) return <Shell><p className="text-base text-subtle">Loading ammunition…</p></Shell>;

  return (
    <Shell>
      <h3 className="mb-2 text-base font-semibold text-fg-strong">{data.lead?.displayName ?? "Lead"}</h3>
      {data.lead && (
        <dl className="grid grid-cols-2 gap-1 text-base">
          <dt className="text-muted">Priority</dt>
          <dd>{data.lead.priorityScore ?? "—"}</dd>
          <dt className="text-muted">Top match fit</dt>
          <dd>{data.lead.topMatchFit ?? "—"}</dd>
          <dt className="text-muted">Capture</dt>
          <dd>{captureLabel(data.lead.captureStatus) ?? "—"}</dd>
          <dt className="text-muted">Why</dt>
          <dd>{reasonText(data.lead.matchReason) ?? "—"}</dd>
          <dt className="text-muted">Address</dt>
          <dd>{data.lead.primaryAddressSummary ?? "—"}</dd>
        </dl>
      )}
      {data.contact && (
        <div className="mt-2 text-base">
          <div className="text-muted">Phones</div>
          {data.contact.phones.map((p) => (
            <div key={p.id}>
              {p.phoneFormatted ?? p.phone} <span className="text-subtle">({p.type})</span>
            </div>
          ))}
        </div>
      )}
      {data.lead?.dealflowDeepLink && (
        <a href={data.lead.dealflowDeepLink} className="mt-2 block text-base text-link hover:underline">
          Open in DealFlow
        </a>
      )}
    </Shell>
  );
}

/** Panel chrome shared by the three render states, so they cannot drift. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <aside className="overflow-hidden rounded-lg border border-line bg-elevated">
      <h2 className="bg-active px-3 py-2 text-xs font-medium text-muted">Ammunition</h2>
      <div className="p-3">{children}</div>
    </aside>
  );
}
