/**
 * Template merge-field renderer (brief §3.2).
 *
 * Syntax: `{{path}}` where path is one of:
 *   - {{contact.firstName}}          → Contact.name.split(' ')[0]
 *   - {{contact.displayName}}
 *   - {{lead.displayName}}
 *   - {{lead.primaryAddressSummary}}
 *   - {{lead.addresses.[0].address_1}}   array indexing into the Json array
 *   - {{lead.custom.est_value}}          CustomFieldValue by definition name
 *   - {{signature}} / {{anyAdHocVar}}    from send-time mergeContext (`extra`)
 *
 * Rules:
 *   - A field that resolves to nothing renders as "" — NEVER the literal {{...}}.
 *   - Prototype access is refused ({{__proto__}}, {{constructor}} → "").
 *   - HTML mode escapes merge VALUES (for bodyHtml); text mode does not.
 *
 * The pure functions below take an in-memory `MergeSources` and touch no DB, so
 * they unit-test fully. `render()` composes the DB fetch (lazy-imported) with
 * `renderTemplate`.
 */

/** Matches the documented field syntax: word chars, dots, and [n] indexes. */
const MERGE_RE = /\{\{\s*([\w.[\]]+)\s*\}\}/g

/** Segments that must never be traversed — prototype-pollution guard. */
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor'])

export interface MergeSources {
  contact?: { name?: string | null; displayName?: string | null } | null
  lead?: {
    displayName?: string | null
    primaryAddressSummary?: string | null
    addresses?: unknown // Json array of address objects
  } | null
  /** Resolved custom field values keyed by CustomFieldDefinition.name. */
  custom?: Record<string, unknown>
  /** Send-time mergeContext: signature + any ad-hoc vars. */
  extra?: Record<string, unknown>
}

function toStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  return '' // objects/arrays are not renderable scalars
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * Walk `root` following `segments`. Supports `[n]` array indexes and own-property
 * object keys only (never the prototype chain). Any miss returns undefined.
 */
function navigate(root: unknown, segments: string[]): unknown {
  let cur: unknown = root
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined
    const idx = seg.match(/^\[(\d+)\]$/)
    if (idx) {
      if (!Array.isArray(cur)) return undefined
      cur = cur[Number(idx[1])]
      continue
    }
    if (UNSAFE.has(seg)) return undefined
    if (typeof cur !== 'object') return undefined
    cur = Object.prototype.hasOwnProperty.call(cur, seg)
      ? (cur as Record<string, unknown>)[seg]
      : undefined
  }
  return cur
}

/** Resolve a single `path` against `sources`. Always returns a string ("" on miss). */
export function resolveMergePath(path: string, sources: MergeSources): string {
  const segments = path
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length === 0) return ''

  // Refuse any prototype-ish segment up front.
  for (const seg of segments) {
    if (!/^\[\d+\]$/.test(seg) && UNSAFE.has(seg)) return ''
  }

  const [root, ...rest] = segments
  switch (root) {
    case 'contact': {
      if (rest[0] === 'firstName') {
        const name = (sources.contact?.name ?? '').trim()
        return name ? name.split(/\s+/)[0] : ''
      }
      return toStr(navigate(sources.contact ?? undefined, rest))
    }
    case 'lead': {
      if (rest[0] === 'custom') {
        const field = rest[1]
        return field ? toStr(sources.custom?.[field]) : ''
      }
      return toStr(navigate(sources.lead ?? undefined, rest))
    }
    case 'signature':
      return toStr(sources.extra?.['signature'])
    default: {
      // A bare {{var}} resolves from ad-hoc send-time mergeContext.
      if (rest.length === 0) return toStr(sources.extra?.[root])
      return ''
    }
  }
}

/** Substitute every `{{path}}` in `template`. HTML mode escapes merged values. */
export function renderTemplate(
  template: string,
  sources: MergeSources,
  opts?: { html?: boolean },
): string {
  return template.replace(MERGE_RE, (_full, path: string) => {
    const value = resolveMergePath(path, sources)
    return opts?.html ? escapeHtml(value) : value
  })
}

/** The distinct merge fields referenced by a template (for MessageTemplate.mergeFields). */
export function extractMergeFields(template: string): string[] {
  const found = new Set<string>()
  for (const m of template.matchAll(MERGE_RE)) found.add(m[1])
  return [...found]
}

export interface RenderContext {
  orgId: string
  leadId?: string
  contactId?: string
  extra?: Record<string, unknown>
  html?: boolean
}

/**
 * DB-backed render: gathers contact/lead/custom-field sources for the given ids,
 * then renders. Prisma is lazy-imported so the pure exports above stay free of
 * import-time side effects (keeps unit tests hermetic).
 */
export async function render(
  template: string,
  ctx: RenderContext,
): Promise<string> {
  const sources = await buildMergeSources(ctx)
  return renderTemplate(template, sources, { html: ctx.html })
}

async function buildMergeSources(ctx: RenderContext): Promise<MergeSources> {
  const { prisma } = await import('../../prisma')

  const [contact, lead] = await Promise.all([
    ctx.contactId
      ? prisma.contact.findUnique({
          where: { id: ctx.contactId },
          select: { name: true, displayName: true },
        })
      : Promise.resolve(null),
    ctx.leadId
      ? prisma.lead.findUnique({
          where: { id: ctx.leadId },
          select: {
            displayName: true,
            primaryAddressSummary: true,
            addresses: true,
          },
        })
      : Promise.resolve(null),
  ])

  const custom: Record<string, unknown> = {}
  if (ctx.leadId) {
    const values = await prisma.customFieldValue.findMany({
      where: {
        organizationId: ctx.orgId,
        objectType: 'lead',
        objectId: ctx.leadId,
      },
      select: {
        valueText: true,
        valueNumber: true,
        valueDate: true,
        definition: { select: { name: true } },
      },
    })
    for (const v of values) {
      const name = v.definition?.name
      if (!name) continue
      custom[name] = v.valueText ?? v.valueNumber ?? v.valueDate ?? undefined
    }
  }

  return { contact, lead: lead ?? undefined, custom, extra: ctx.extra }
}
