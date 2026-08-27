import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { PrismaClient } from "@prisma/client";
import { makePerfPool, makeBarrier, prismaPerf } from "./setup/pg";
import { tryAcquireCallWinner } from "@/lib/telephony/race-resolver/acquireWinner";
import {
  buildLoserTwiml,
  markLoserAndBuildTwiml,
} from "@/lib/telephony/race-resolver/droppedLoser";

// The exact SQL the helper (acquireWinner.ts) runs — used by the raw-pg
// concurrency test so we prove atomicity at scale against real Postgres.
const LOCK_SQL = `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) as won`;

const N = 50; // reduced from 100 per Ryan: 50 leaves Railway headroom and the
// invariant is deterministic at any concurrency ≥ 2.

// ────────────────────────────────────────────────────────────────────────────
// Advisory-lock atomicity — raw pg Pool, BEGIN/ROLLBACK per attempt.
// ────────────────────────────────────────────────────────────────────────────
describe("race-resolver — advisory-lock atomicity (Railway Postgres)", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = makePerfPool(N + 5);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Attempt the lock inside a tx, hold at the barrier, then ROLLBACK. */
  async function attempt(callId: string, barrier: () => Promise<void>): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ won: boolean }>(LOCK_SQL, [callId]);
      const won = r.rows[0].won;
      await barrier(); // keep tx open until all contenders have attempted
      await client.query("ROLLBACK");
      return won;
    } finally {
      client.release();
    }
  }

  it(`exactly ONE winner among ${N} concurrent attempts for the same callId`, async () => {
    const callId = "call_sameid_0000000001";
    const barrier = makeBarrier(N);

    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: N }, () => attempt(callId, barrier)),
    );
    const elapsed = performance.now() - started;

    expect(results.filter(Boolean).length).toBe(1);
    expect(elapsed).toBeLessThan(3_000); // brief timing budget
  });

  it(`${N} concurrent across 10 callIds → exactly 1 winner PER callId`, async () => {
    const callIds = Array.from({ length: 10 }, (_, i) => `call_multi_${i}`);
    const barrier = makeBarrier(N);

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const callId = callIds[i % callIds.length];
        return attempt(callId, barrier).then((won) => ({ callId, won }));
      }),
    );

    for (const callId of callIds) {
      const winners = results.filter((r) => r.callId === callId && r.won).length;
      expect(winners).toBe(1);
    }
  });

  it("ROLLBACK releases the lock → a fresh attempt succeeds", async () => {
    const callId = "call_rollback_001";
    const c1 = await pool.connect();
    try {
      await c1.query("BEGIN");
      const first = await c1.query<{ won: boolean }>(LOCK_SQL, [callId]);
      expect(first.rows[0].won).toBe(true);
      await c1.query("ROLLBACK"); // releases
    } finally {
      c1.release();
    }
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      const again = await c2.query<{ won: boolean }>(LOCK_SQL, [callId]);
      expect(again.rows[0].won).toBe(true);
      await c2.query("ROLLBACK");
    } finally {
      c2.release();
    }
  });

  it("COMMIT releases the lock → a subsequent attempt also succeeds", async () => {
    const callId = "call_commit_001";
    const c1 = await pool.connect();
    try {
      await c1.query("BEGIN");
      const first = await c1.query<{ won: boolean }>(LOCK_SQL, [callId]);
      expect(first.rows[0].won).toBe(true);
      await c1.query("COMMIT"); // xact lock releases on commit too
    } finally {
      c1.release();
    }
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      const second = await c2.query<{ won: boolean }>(LOCK_SQL, [callId]);
      expect(second.rows[0].won).toBe(true);
      await c2.query("ROLLBACK");
    } finally {
      c2.release();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The exported helper wrapper — Prisma transaction path (low concurrency).
// ────────────────────────────────────────────────────────────────────────────
describe("race-resolver — tryAcquireCallWinner helper (Prisma)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = prismaPerf(4);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("two concurrent Prisma transactions → exactly one wins via the helper", async () => {
    const callId = "call_helper_prisma_001";
    const barrier = makeBarrier(2);
    const runOne = () =>
      prisma.$transaction(async (tx) => {
        const won = await tryAcquireCallWinner(tx, callId);
        await barrier();
        return won;
      });
    const results = await Promise.all([runOne(), runOne()]);
    expect(results.filter(Boolean).length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dropped-loser TwiML — pure builder + DB update.
// ────────────────────────────────────────────────────────────────────────────
describe("race-resolver — dropped-loser TwiML (env seam)", () => {
  it("say mode returns a <Say> element with the configured text", () => {
    const twiml = buildLoserTwiml({ mode: "say", text: "We will call you back." });
    expect(twiml).toContain("<Say");
    expect(twiml).toContain("We will call you back.");
    expect(twiml).toContain("<Hangup/>");
    expect(twiml).not.toContain("<Play>");
  });

  it("play mode returns a <Play> element pointing at the MP3 URL", () => {
    const twiml = buildLoserTwiml({ mode: "play", mp3Url: "https://r2.example.com/loser.mp3" });
    expect(twiml).toContain("<Play>https://r2.example.com/loser.mp3</Play>");
    expect(twiml).toContain("<Hangup/>");
    expect(twiml).not.toContain("<Say");
  });

  it("say mode escapes XML-sensitive characters in the text", () => {
    const twiml = buildLoserTwiml({ mode: "say", text: `A & B < C > "D"` });
    expect(twiml).toContain("A &amp; B &lt; C &gt; &quot;D&quot;");
  });

  it("defaults to say mode with the placeholder text when env is empty", () => {
    const twiml = buildLoserTwiml({});
    expect(twiml).toContain("<Say");
    expect(twiml).toContain("stepped away");
  });

  describe("process.env seam (Ryan flips without a code change)", () => {
    const saved = {
      mode: process.env.RACE_LOSER_TWIML_MODE,
      text: process.env.RACE_LOSER_TWIML_TEXT,
      mp3: process.env.RACE_LOSER_TWIML_MP3_URL,
    };
    afterAll(() => {
      process.env.RACE_LOSER_TWIML_MODE = saved.mode;
      process.env.RACE_LOSER_TWIML_TEXT = saved.text;
      process.env.RACE_LOSER_TWIML_MP3_URL = saved.mp3;
    });

    it("reads mode + text entirely from process.env", () => {
      process.env.RACE_LOSER_TWIML_MODE = "say";
      process.env.RACE_LOSER_TWIML_TEXT = "Env-driven text.";
      const twiml = buildLoserTwiml();
      expect(twiml).toContain("<Say");
      expect(twiml).toContain("Env-driven text.");
    });

    it("reads play mode + mp3 URL entirely from process.env", () => {
      process.env.RACE_LOSER_TWIML_MODE = "play";
      process.env.RACE_LOSER_TWIML_MP3_URL = "https://r2.example.com/env.mp3";
      const twiml = buildLoserTwiml();
      expect(twiml).toContain("<Play>https://r2.example.com/env.mp3</Play>");
    });

    it("play mode with no mp3 anywhere yields an empty <Play>", () => {
      process.env.RACE_LOSER_TWIML_MODE = "play";
      delete process.env.RACE_LOSER_TWIML_MP3_URL;
      const twiml = buildLoserTwiml();
      expect(twiml).toContain("<Play></Play>");
    });
  });

  describe("markLoserAndBuildTwiml (DB update)", () => {
    let prisma: PrismaClient;
    const SID_CALL = "CA_loser_test_001";
    const SID_LEG = "CA_leg_loser_001";

    beforeAll(async () => {
          prisma = prismaPerf(4);
      await prisma.$connect();
      // Clean any leftovers from a prior run (cascade removes legs).
      await prisma.call.deleteMany({ where: { providerCallSid: SID_CALL } });
    });

    afterAll(async () => {
      await prisma.call.deleteMany({ where: { providerCallSid: SID_CALL } });
      await prisma?.$disconnect();
    });

    it("marks the CallLeg dropped-loser and returns TwiML", async () => {
      const call = await prisma.call.create({
        data: {
          organizationId: "org_test",
          direction: "outbound",
          callMethod: "predictive",
          localPhone: "+15555550100",
          remotePhone: "+15555550111",
          providerCallSid: SID_CALL,
          source: "dealflow-crm",
        },
      });
      const leg = await prisma.callLeg.create({
        data: { callId: call.id, contactPhoneId: "cph_test_001", providerLegSid: SID_LEG },
      });

      const twiml = await markLoserAndBuildTwiml(prisma, leg.providerLegSid, {
        mode: "say",
        text: "Loser message.",
      });
      expect(twiml).toContain("<Say");
      expect(twiml).toContain("Loser message.");

      const updated = await prisma.callLeg.findUnique({ where: { id: leg.id } });
      expect(updated?.disposition).toBe("dropped-loser");
      expect(updated?.droppedLoserMessage).toBe(true);
    });
  });
});
