// Brief 50 PR 5 — the lead page's Edit mode, the parts that need no page:
// what the form starts from, what it sends to PUT /api/leads/[id], and its
// keys. The API's rules are in src/lib/core-data/leads/edit.ts.

/** What the page hands the form: the five editable things, as stored. */
export interface LeadEditInitial {
  leadId: string
  displayName: string
  statusLabel: string | null
  primaryAddressFull: string | null
  contacts: {
    id: string
    displayName: string
    /** `locked`: an opt-out lives on the row ("texts blocked"), so it can't be removed or changed here. */
    phones: { id: string; phone: string; locked: boolean }[]
    /** `locked`: the email opted out. */
    emails: { id: string; email: string; locked: boolean }[]
  }[]
}

/** One phone or email row in the form: a stored one has its id; a new one has only a key. */
export interface DraftRow {
  key: string
  id?: string
  value: string
  locked: boolean
}

export interface DraftContact {
  id: string
  displayName: string
  phones: DraftRow[]
  emails: DraftRow[]
}

export interface LeadEditDraft {
  displayName: string
  statusLabel: string
  primaryAddressFull: string
  contacts: DraftContact[]
}

export function draftFromInitial(initial: LeadEditInitial): LeadEditDraft {
  return {
    displayName: initial.displayName,
    statusLabel: initial.statusLabel ?? '',
    primaryAddressFull: initial.primaryAddressFull ?? '',
    contacts: initial.contacts.map((c) => ({
      id: c.id,
      displayName: c.displayName,
      phones: c.phones.map((p) => ({ key: p.id, id: p.id, value: p.phone, locked: p.locked })),
      emails: c.emails.map((e) => ({ key: e.id, id: e.id, value: e.email, locked: e.locked })),
    })),
  }
}

type PhoneItem = { id?: string; phone?: string; remove?: true }
type EmailItem = { id?: string; email?: string; remove?: true }

/** The body of PUT /api/leads/[id]. */
export interface LeadEditPayload {
  displayName?: string
  statusLabel?: string | null
  primaryAddressFull?: string | null
  contacts?: { id: string; phones: PhoneItem[]; emails: EmailItem[] }[]
}

/**
 * What to send: only what changed. A contact's list is sent whole once any of
 * it changed: a stored row the user didn't touch goes as `{ id }` (kept as it
 * is), an edited one as `{ id, phone }`, a new one as `{ phone }`, and a
 * removed or emptied one as `{ id, remove: true }` (a number the form never
 * showed is never removed). `initial` is what the form was opened from.
 * `payload` is null when nothing changed. `fieldKeys` maps the API's `field`
 * (e.g. "contacts.c1.phones.2") to the form row it came from, so a refusal
 * shows next to that row.
 */
export function buildLeadEditPayload(
  initial: LeadEditInitial,
  draft: LeadEditDraft,
): { payload: LeadEditPayload | null; fieldKeys: Record<string, string> } {
  const payload: LeadEditPayload = {}
  const fieldKeys: Record<string, string> = {
    displayName: 'displayName',
    statusLabel: 'statusLabel',
    primaryAddressFull: 'primaryAddressFull',
  }

  const name = draft.displayName.trim()
  if (name !== initial.displayName.trim()) payload.displayName = name
  const status = draft.statusLabel.trim()
  if (status !== (initial.statusLabel ?? '').trim()) payload.statusLabel = status || null
  const address = draft.primaryAddressFull.trim()
  if (address !== (initial.primaryAddressFull ?? '').trim()) payload.primaryAddressFull = address || null

  const contacts: NonNullable<LeadEditPayload['contacts']> = []
  for (const c of draft.contacts) {
    const before = initial.contacts.find((x) => x.id === c.id)
    if (!before) continue
    const phoneBefore = new Map(before.phones.map((p) => [p.id, p.phone]))
    const emailBefore = new Map(before.emails.map((e) => [e.id, e.email]))
    const phones = items(c.phones, phoneBefore, (i): PhoneItem => ({
      ...(i.id && { id: i.id }),
      ...(i.value !== undefined && { phone: i.value }),
      ...(i.remove && { remove: true as const }),
    }))
    const emails = items(c.emails, emailBefore, (i): EmailItem => ({
      ...(i.id && { id: i.id }),
      ...(i.value !== undefined && { email: i.value }),
      ...(i.remove && { remove: true as const }),
    }))
    const changed = (list: { item: object }[], count: number) =>
      list.length !== count || list.some(({ item }) => Object.keys(item).some((k) => k !== 'id'))
    if (!changed(phones, before.phones.length) && !changed(emails, before.emails.length)) continue
    phones.forEach(({ key }, i) => (fieldKeys[`contacts.${c.id}.phones.${i}`] = key))
    emails.forEach(({ key }, i) => (fieldKeys[`contacts.${c.id}.emails.${i}`] = key))
    contacts.push({ id: c.id, phones: phones.map((p) => p.item), emails: emails.map((e) => e.item) })
  }
  if (contacts.length) payload.contacts = contacts

  return { payload: Object.keys(payload).length ? payload : null, fieldKeys }
}

function items<T extends object>(
  rows: DraftRow[],
  before: Map<string, string>,
  make: (item: { id?: string; value?: string; remove?: boolean }) => T,
): { key: string; item: T }[] {
  const out: { key: string; item: T }[] = []
  const shown = new Set<string>()
  for (const r of rows) {
    if (r.id !== undefined) {
      shown.add(r.id)
      if (r.locked || r.value === before.get(r.id)) out.push({ key: r.key, item: make({ id: r.id }) })
      else if (r.value.trim()) out.push({ key: r.key, item: make({ id: r.id, value: r.value }) })
      else out.push({ key: r.key, item: make({ id: r.id, remove: true }) }) // emptied
    } else if (r.value.trim()) {
      out.push({ key: r.key, item: make({ value: r.value }) })
    }
  }
  // Removed with ×: named, so the API removes exactly these.
  for (const id of before.keys()) if (!shown.has(id)) out.push({ key: id, item: make({ id, remove: true }) })
  return out
}

// ─── Keys ───────────────────────────────────────────────────────────────────
// "e" opens the editor while you're not typing (anywhere on the lead page, or
// with nothing focused). While it's open, Esc cancels and ⌘/Ctrl+Enter saves,
// even from a text field. Nothing fires inside a dialog or menu, so Esc there
// closes the dialog only. "e" isn't bound anywhere a lead page can have focus
// (the Inbox's "e" lives on /inbox).

export interface EditKeyInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented?: boolean
}

export interface EditKeyContext {
  editing: boolean
  /** Focus is in a text field. */
  editable: boolean
  /** Focus is in a dialog or menu. */
  inDialog: boolean
  /** Focus is on the lead page (or nowhere). */
  onPage: boolean
}

export type EditKeyAction = 'edit' | 'save' | 'cancel'

export function leadEditKeyAction(e: EditKeyInput, ctx: EditKeyContext): EditKeyAction | null {
  if (e.isComposing || e.defaultPrevented || ctx.inDialog) return null
  if (ctx.editing) {
    if (e.key === 'Escape') return 'cancel'
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey) return 'save'
    return null
  }
  if (e.repeat || ctx.editable || !ctx.onPage) return null
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  return e.key === 'e' ? 'edit' : null
}
