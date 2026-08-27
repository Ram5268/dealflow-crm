// Railway-Postgres helper for Milestone 1b (and later DB-backed tests).
//
// Per Ryan's directive we skip Docker/Testcontainers entirely and point at
// DATABASE_URL_PERF — a throwaway perf DB (`dealflow_crm_perf`) on the same
// Railway PG server as MAIN, isolated for exactly this kind of property test.
//
// `import 'dotenv/config'` is FIRST so DATABASE_URL_PERF is loaded from .env
// before anything reads it (the standing "don't silently default Prisma to
// localhost" rule).
import "dotenv/config";
import pg from "pg";
import { PrismaClient } from "@prisma/client";

export function perfConnectionString(): string {
  const url = process.env.DATABASE_URL_PERF;
  if (!url) {
    throw new Error(
      "DATABASE_URL_PERF is not set — expected in agent-b/.env (Railway dealflow_crm_perf).",
    );
  }
  return url;
}

/**
 * A node-postgres Pool against the perf DB. `max` defaults to 55 so the
 * 50-concurrent property test can hold every transaction open simultaneously.
 * Railway's default server-wide max_connections is 100, so 55 leaves headroom.
 */
export function makePerfPool(max = 55): pg.Pool {
  return new pg.Pool({
    connectionString: perfConnectionString(),
    max,
    connectionTimeoutMillis: 15_000,
  });
}

/**
 * A one-shot barrier: `arrive()` blocks each caller until `n` callers have
 * arrived, then releases them all at once. This is what makes the advisory lock
 * GENUINELY contended — every transaction holds its attempt result open until
 * all contenders have tried. Without it, a late attempt could acquire the lock
 * after the winner already released it (locks are transaction-scoped).
 */
export function makeBarrier(n: number): () => Promise<void> {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async function arrive(): Promise<void> {
    count += 1;
    if (count === n) release();
    await gate;
  };
}

/**
 * PrismaClient bound to the perf DB with a small pool. Used by the helper
 * wrapper coverage test and the markLoser DB test (low concurrency).
 */
export function prismaPerf(connectionLimit = 5): PrismaClient {
  const u = new URL(perfConnectionString());
  u.searchParams.set("connection_limit", String(connectionLimit));
  return new PrismaClient({ datasourceUrl: u.toString() });
}

/**
 * A dedicated LISTEN client on the `crm_call` channel. Captures every emitted
 * event payload (parsed JSON) so tests can assert emission count + wire shape.
 */
export interface CrmCallListener {
  events: Array<Record<string, unknown>>;
  waitFor: (predicate: (e: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}

export async function listenCrmCall(): Promise<CrmCallListener> {
  const client = new pg.Client({ connectionString: perfConnectionString() });
  await client.connect();
  const events: Array<Record<string, unknown>> = [];
  client.on("notification", (msg) => {
    if (msg.channel === "crm_call" && msg.payload) {
      try {
        events.push(JSON.parse(msg.payload));
      } catch {
        /* ignore non-JSON */
      }
    }
  });
  await client.query("LISTEN crm_call");
  return {
    events,
    async waitFor(predicate, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      // Poll the buffer; notifications arrive on the client's socket callbacks.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const hit = events.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for crm_call event");
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async close() {
      await client.end();
    },
  };
}
