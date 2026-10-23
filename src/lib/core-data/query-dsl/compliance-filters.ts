import type { Condition, SQuery } from './schema'

// ─────────────────────────────────────────────────────────────────────────────
// The two compliance filters a Smart View can name (`kind: 'compliance'`).
//
// Brief 50 PR 4 (open item 6.4, audit finding L15): both used to compile to
// TRUE, "for a later step to evaluate" that never existed, so a view using
// either silently showed everyone. Brief 50 (Ryan took the planner's
// recommendation, 2026-10-19): make them work if that's cheap, otherwise hide
// them so they don't quietly mislead. "Cheap" [engineering precaution]:
// answered in SQL from tables the CRM already has, with no vendor call, no
// network call and no per-lead loop at page load.
//
//  - "Do-not-call clean" (dnc_clean) is cheap: the data the compliance
//    engine's own do-not-call check reads first is in the CRM's database, so
//    it compiles to SQL (dncCleanSql below). It never calls a vendor.
//  - "Callable now" (callable_now) is not: the engine's answer needs a live,
//    paid federal/state do-not-call and litigator check for any number without
//    a fresh one, and its calling-window, holiday and policy rules live in
//    TypeScript (src/lib/compliance/scrub/callableNow.ts), which writes a scrub
//    log row per number each time it runs. So it is HIDDEN: the API refuses it
//    and a saved view that uses it says so instead of being applied.
//
// Neither is permission to call [Ryan: nothing may call, text or email a
// lead]. The dialer's queue keeps running the full callable-now check on
// every lead, whatever the view says (queue-service.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type CompliancePredicateName = 'callable_now' | 'dnc_clean'

/** The names Ryan sees. */
export const COMPLIANCE_FILTER_LABELS: Record<CompliancePredicateName, string> = {
  callable_now: 'Callable now',
  dnc_clean: 'Do-not-call clean',
}

/** Filters that are hidden: refused by the API, never applied to a saved view. */
export const UNAVAILABLE_FILTERS: ReadonlySet<CompliancePredicateName> = new Set(['callable_now'])

/** No trailing period: the Leads page adds ". Showing all leads." after it. */
export function unavailableFilterMessage(predicate: CompliancePredicateName): string {
  return `The "${COMPLIANCE_FILTER_LABELS[predicate]}" filter isn't available yet`
}

/** A saved view that uses a hidden filter. Its message is plain English. */
export class UnavailableFilterError extends Error {
  constructor(readonly predicate: CompliancePredicateName) {
    super(unavailableFilterMessage(predicate))
    this.name = 'UnavailableFilterError'
  }
}

/** Every compliance filter a query names, in the order they appear. */
export function compliancePredicatesIn(q: SQuery): CompliancePredicateName[] {
  switch (q.type) {
    case 'and':
    case 'or':
      return q.queries.flatMap(compliancePredicatesIn)
    case 'has_related':
      return compliancePredicatesIn(q.query)
    case 'field_condition':
      return q.field.kind === 'compliance' ? [q.field.predicate] : []
    default:
      return []
  }
}

/** The first hidden filter a query names, or null. */
export function firstUnavailableFilter(q: SQuery): CompliancePredicateName | null {
  return compliancePredicatesIn(q).find((p) => UNAVAILABLE_FILTERS.has(p)) ?? null
}

/**
 * The compliance filters that always narrow the result: reached from the top
 * through `and` / `has_related` (or an `or` with one branch), never as one
 * alternative of an `or`. The Leads page explains "Do-not-call clean" only
 * when it really narrows the list.
 */
export function narrowingPredicatesIn(q: SQuery): CompliancePredicateName[] {
  switch (q.type) {
    case 'and':
      return q.queries.flatMap(narrowingPredicatesIn)
    case 'or':
      return q.queries.length === 1 ? narrowingPredicatesIn(q.queries[0]) : []
    case 'has_related':
      return narrowingPredicatesIn(q.query)
    case 'field_condition':
      return q.field.kind === 'compliance' ? [q.field.predicate] : []
    default:
      return []
  }
}

// "Do-not-call clean" has one form: { type: 'term', op: 'in', values: ['true'] }.
// The DSL has no "not", so any other condition (say ['false'], meant as "not
// clean") is refused rather than quietly returning the clean people
// [engineering precaution].
export function isDncCleanTrue(c: Condition): boolean {
  return c.type === 'term' && c.op === 'in' && c.values.length === 1 && c.values[0] === 'true'
}

export const DNC_CLEAN_CONDITION_MESSAGE =
  `The "Do-not-call clean" filter only keeps people who are do-not-call clean; its condition must be "true"`

/** The first plain-English reason a query's compliance filters can't run, or null. */
export function complianceFilterProblem(q: SQuery): string | null {
  switch (q.type) {
    case 'and':
    case 'or':
      for (const sub of q.queries) {
        const problem = complianceFilterProblem(sub)
        if (problem) return problem
      }
      return null
    case 'has_related':
      return complianceFilterProblem(q.query)
    case 'field_condition':
      if (q.field.kind !== 'compliance') return null
      if (UNAVAILABLE_FILTERS.has(q.field.predicate)) return unavailableFilterMessage(q.field.predicate)
      return isDncCleanTrue(q.condition) ? null : DNC_CLEAN_CONDITION_MESSAGE
    default:
      return null
  }
}

// ── "Do-not-call clean" ──────────────────────────────────────────────────────

/**
 * How recent a clean registry check must be. The compliance engine's own
 * do-not-call check trusts a clean result for 24 hours before asking the
 * vendor again (DAY_MS in src/lib/compliance/dnc/check.ts); the filter uses
 * the same window and, having no vendor to ask, treats anything older as
 * "not known to be clean".
 */
export const DNC_CLEAN_FRESH_HOURS = 24

/** What the Leads page says under a view that uses the filter. */
export const DNC_CLEAN_NOTE =
  `"Do-not-call clean" lists people whose every phone had a clean do-not-call check ` +
  `in the last ${DNC_CLEAN_FRESH_HOURS} hours and is on no opt-out or do-not-call list. ` +
  `A number that hasn't been checked is left out. This doesn't turn calling on.`

const digits = (col: string) => `regexp_replace(${col}, '[^0-9]', '', 'g')`
// The part every stored form of one US number shares ("+19175550147",
// "19175550147", "9175550147", "(917) 555-0147"): its last 10 digits. Matching
// opt-outs on it is deliberately broad; a wrong match can only leave someone
// out [engineering precaution: fail safe].
const key = (col: string) => `right(${digits(col)}, 10)`

// A federal or state registry check, as the engine's vendor step logs it
// (dnc/check.ts and the nightly dnc/refresh.ts).
const REGISTRY_CHECK = `operation IN ('check-federal', 'check-state')`
// "checkedAt" is timestamp without time zone holding UTC, so the window is
// measured from (now() AT TIME ZONE 'UTC'), never a bare now(), which Postgres
// would compare in the session's time zone (in New York time a 28-hour-old
// clean check would count as fresh). Same rule as nightly-notice.ts.
const FRESH = `"checkedAt" >= (now() AT TIME ZONE 'UTC') - interval '${DNC_CLEAN_FRESH_HOURS} hours'`

const LEAD_PHONES =
  `"ContactPhone" dnc_p JOIN "Contact" dnc_c ON dnc_p."contactId" = dnc_c.id ` +
  `WHERE dnc_c."leadId" = lead.id`

/**
 * SQL for "Do-not-call clean": the lead has at least one phone, and EVERY one
 * of its phones (on every contact)
 *  1. is a readable US number (10 digits, or 11 starting with 1);
 *  2. isn't on any suppression list stored here: the internal opt-out list
 *     (Settings → Do not contact, a texted STOP) and the federal/state
 *     registry hits, in any stored form;
 *  3. isn't a known TCPA litigator;
 *  4. isn't marked as having texted STOP;
 *  5. wasn't found on a registry by a check in the last 24 hours (even if the
 *     suppression row has since gone); and
 *  6. HAS a clean federal or state check in the last 24 hours (one is enough,
 *     as for the engine), for this exact number in this organization, from a
 *     real vendor: a "clean" row the mock vendor wrote never counts
 *     [engineering precaution; Brief 40 audit H16].
 * Anything the CRM can't vouch for leaves the lead out [engineering
 * precaution: fail safe]. Each list lookup is uncorrelated, so Postgres hashes
 * it once per query rather than once per lead (about 0.2 s for 25,000 leads
 * and 30,000 phones on a laptop).
 *
 * Lead-level wherever it sits (inside has_related too): it never narrows to
 * one contact's phones, so it can only show fewer people, not more.
 *
 * `org` is the organization's bound placeholder ($N). The query has no other
 * input: every other part is a fixed string.
 */
export function dncCleanSql(org: string): string {
  const notClean = [
    `${digits('dnc_p.phone')} !~ '^1?[0-9]{10}$'`,
    `${key('dnc_p.phone')} IN (SELECT ${key('dnc_s.phone')} FROM "DncSuppression" dnc_s WHERE dnc_s."organizationId" = ${org})`,
    `${key('dnc_p.phone')} IN (SELECT ${key('dnc_t.phone')} FROM "LitigatorSuppression" dnc_t WHERE dnc_t."organizationId" = ${org})`,
    `dnc_p."outboundSmsBlocked"`,
    `${key('dnc_p.phone')} IN (SELECT ${key('dnc_b.phone')} FROM "ScrubLog" dnc_b ` +
      `WHERE dnc_b."organizationId" = ${org} AND dnc_b.${REGISTRY_CHECK} AND dnc_b.result = 'blocked' AND dnc_b.${FRESH})`,
    `dnc_p.phone NOT IN (SELECT dnc_k.phone FROM "ScrubLog" dnc_k ` +
      `WHERE dnc_k."organizationId" = ${org} AND dnc_k.${REGISTRY_CHECK} AND dnc_k.result = 'clean' AND dnc_k.${FRESH} ` +
      `AND coalesce(dnc_k.detail->>'vendor', '') <> 'mock')`,
  ]
  return (
    `(EXISTS (SELECT 1 FROM ${LEAD_PHONES}) ` +
    `AND NOT EXISTS (SELECT 1 FROM ${LEAD_PHONES} AND (${notClean.map((c) => `(${c})`).join(' OR ')})))`
  )
}
