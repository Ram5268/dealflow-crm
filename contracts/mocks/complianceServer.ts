import { createServer, type Server } from "node:http";

/**
 * Faithful mock of Agent C's `POST /api/compliance/callable-now`
 * (contracts/http/compliance-callable-now.json). Enforces the 100-id batch cap
 * (413) and returns both contactPhoneId + phone with REASON_CODES-drawn reasons.
 *
 * Callable rules by id substring (for deterministic tests):
 *   contains "dnc"   → callable:false reasons:["internal_dnc"]
 *   contains "notz"  → callable:false reasons:["timezone_unresolved"]
 *   contains "nophone" → result omits `phone` (contract-drift simulation)
 *   contains "unkreason" → callable:false reasons:["totally_unknown_code"]
 *   otherwise        → callable:true reasons:[]
 */
export function complianceMockResult(id: string): Record<string, unknown> {
  if (id.includes("nophone")) {
    return { contactPhoneId: id, callable: false, reasons: ["internal_error"] }; // no `phone`
  }
  if (id.includes("dnc")) {
    return { contactPhoneId: id, phone: "+15555550000", callable: false, reasons: ["internal_dnc"] };
  }
  if (id.includes("notz")) {
    return { contactPhoneId: id, phone: "+15555550000", callable: false, reasons: ["timezone_unresolved"] };
  }
  if (id.includes("unkreason")) {
    return { contactPhoneId: id, phone: "+15555550000", callable: false, reasons: ["totally_unknown_code"] };
  }
  return { contactPhoneId: id, phone: "+15555550000", callable: true, reasons: [] };
}

export function createComplianceServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/compliance/callable-now") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let ids: string[] = [];
        try {
          ids = JSON.parse(body).contactPhoneIds ?? [];
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad_json" }));
          return;
        }
        if (ids.length > 100) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "too_many_contact_phone_ids" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ results: ids.map(complianceMockResult) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
}
