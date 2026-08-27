import type { PrismaClient } from "@prisma/client";
import { monthToDateSpendUsd } from "../pacing/metrics";

/**
 * Monthly Twilio spend vs the soft cap. `sum(Call.cost)` counts the outbound
 * (Leg A) PSTN cost only — the operator's client-to-Twilio leg (Leg B) is not
 * summed (see docs/pacing-control-law.md); acceptable for MVP with the buffer.
 * Feeds the pacing worker's spend-halt input.
 */
export interface MonthlyCapStatus {
  spendUsd: number;
  capUsd: number;
  exceeded: boolean;
}

export async function monthlyCapStatus(prisma: PrismaClient): Promise<MonthlyCapStatus> {
  const spendUsd = await monthToDateSpendUsd(prisma);
  const capUsd = parseInt(process.env.TWILIO_MONTHLY_SPEND_CAP_USD ?? "200", 10);
  return { spendUsd, capUsd, exceeded: spendUsd >= capUsd };
}
