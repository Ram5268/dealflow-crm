import "dotenv/config";
import { createQueueServer } from "./queueServer";
import { createComplianceServer } from "./complianceServer";

/**
 * `pnpm mocks:up` — start both cross-slice mocks for Gate 1 isolation boot:
 *   queue (Agent A)      → :4101
 *   compliance (Agent C) → :4102
 * Point QUEUE_SERVICE_BASE_URL=http://localhost:4101 and
 * COMPLIANCE_BASE_URL=http://localhost:4102 at these during Milestones 1–3.
 */
const QUEUE_PORT = Number(process.env.QUEUE_MOCK_PORT ?? 4101);
const COMPLIANCE_PORT = Number(process.env.COMPLIANCE_MOCK_PORT ?? 4102);

createQueueServer().listen(QUEUE_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock] queue         → http://localhost:${QUEUE_PORT}/api/queue`);
});
createComplianceServer().listen(COMPLIANCE_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mock] compliance    → http://localhost:${COMPLIANCE_PORT}/api/compliance/callable-now`);
});
