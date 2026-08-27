import { createServer, type Server } from "node:http";

/**
 * Faithful mock of Agent A's `GET /api/queue` (contracts/http/queue.json + brief
 * §8.2). Returns primaryPhoneE164 + primaryPhoneId, nullable timezone, and the
 * passthrough telemetry fields. Used by Gate 1 isolation boot and Gate 2 consume
 * contract tests.
 */
export interface QueueMockOpts {
  stale?: boolean;
  timezoneNullFirst?: boolean;
  count?: number;
}

export function queueMockBody(viewId: string, opts: QueueMockOpts = {}) {
  const count = opts.count ?? 2;
  const leads = Array.from({ length: count }, (_, i) => ({
    leadId: `lead_${i}`,
    contactId: `contact_${i}`,
    primaryPhoneId: `cph_${i}`,
    primaryPhoneE164: `+1555555${String(1000 + i).slice(1)}`,
    displayName: `Lead ${i}`,
    timezone: opts.timezoneNullFirst && i === 0 ? null : "America/New_York",
    ammunition: {
      priorityScore: 90 - i,
      topMatchFit: 80,
      captureStatus: "hot",
      matchReason: "3BR buyer ISO",
      dealflowDeepLink: "https://dealflow.app/opp/x",
    },
  }));
  return {
    view: { id: viewId, name: "Mock Smart View" },
    leads,
    stale: opts.stale ?? false,
    staleReason: opts.stale ? "ranker 20m late" : null,
    excludedNoPhone: 0,
    excludedCompliance: 0,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function createQueueServer(opts: QueueMockOpts = {}): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/queue") {
      const viewId = url.searchParams.get("viewId") ?? "save_unknown";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(queueMockBody(viewId, opts)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
