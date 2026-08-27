import { z } from 'zod'

// Zod-validated environment for the compliance slice. Secrets injected via
// Doppler at runtime; only .env.example is committed.
//
// Design notes:
// - DNC_VENDOR / LITIGATOR_VENDOR are OPTIONAL until Milestone 2 (Ryan picks
//   vendors). When unset, the vendor factory returns the `noop` fail-closed
//   client — NOT a clean pass.
// - Parsing is lenient so importing this module never crashes a unit test that
//   runs without Doppler. Endpoints that truly require a value (cron bearer,
//   DB) assert it at the point of use.
const schema = z.object({
  DATABASE_URL_MAIN: z.string().default(''),
  CRON_SECRET: z.string().default(''),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().default('local'),

  // Agent C vendors — TBD until M2.
  DNC_VENDOR: z.string().optional(),
  DNC_API_KEY: z.string().optional(),
  LITIGATOR_VENDOR: z.string().optional(),
  LITIGATOR_API_KEY: z.string().optional(),

  MOBILE_LINE_VENDOR: z.string().default('twilio_lookup'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),

  // Fixture/test fallback zone label ONLY. Runtime NEVER falls back to a
  // default timezone for a real contact (see tzResolve).
  NYC_TIMEZONE_DEFAULT: z.string().default('America/New_York'),
})

export type ComplianceEnv = z.infer<typeof schema>

let cached: ComplianceEnv | null = null

export function getEnv(): ComplianceEnv {
  if (cached) return cached
  cached = schema.parse(process.env)
  return cached
}

// Test seam: force re-read of process.env on next getEnv().
export function resetEnvCache(): void {
  cached = null
}

// True once Ryan has selected AND keyed a DNC vendor. Milestone 2 gate.
export function isDncVendorConfigured(env = getEnv()): boolean {
  return Boolean(env.DNC_VENDOR && env.DNC_API_KEY)
}

export function isLitigatorVendorConfigured(env = getEnv()): boolean {
  return Boolean(env.LITIGATOR_VENDOR && env.LITIGATOR_API_KEY)
}
