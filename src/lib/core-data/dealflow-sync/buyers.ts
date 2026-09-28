import { capitalize } from './labels'

// Brief 38 — the buyers DealFlow matched to a ranked seller: its CallQueueEntry's
// primary + contributing matches (max 5, best first), stored on the seller's
// signal as dealflowRawJson.buyers. Buyer facts are read the way DealFlow's
// matcher reads them (lib/matching/adapters.ts). Never a phone number or email.
export interface DealflowBuyer {
  matchId: string
  score: number | null
  tier: string | null
  reasonKeys: string[]
  captureStatus: string | null
  type: 'opportunity' | 'mojo' // an inbox buyer request | a Mojo buyer contact
  name: string | null // the request's agent, or the Mojo buyer's own name
  brokerage: string | null
  neighborhoods: string[]
  propertyTypes: string[]
  bedsMin: number | null
  bedsMax: number | null
  priceMin: number | null
  priceMax: number | null
  buyerArchetype: string | null
  isTestData: boolean
}

export const MAX_BUYERS = 5

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => str(x) !== null) : [])

// Keeps only the fields above, so nothing else (a contact detail, say) can ride
// along into the CRM. Order is kept (DealFlow's best first); at most MAX_BUYERS.
export function toBuyers(raw: unknown): DealflowBuyer[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && str((b as { matchId?: unknown }).matchId) !== null)
    .slice(0, MAX_BUYERS)
    .map((b) => ({
      matchId: b.matchId as string, score: num(b.score), tier: str(b.tier), reasonKeys: strs(b.reasonKeys),
      captureStatus: str(b.captureStatus), type: b.type === 'mojo' ? 'mojo' : 'opportunity',
      name: str(b.name), brokerage: str(b.brokerage), neighborhoods: strs(b.neighborhoods),
      propertyTypes: strs(b.propertyTypes), bedsMin: num(b.bedsMin), bedsMax: num(b.bedsMax),
      priceMin: num(b.priceMin), priceMax: num(b.priceMax), buyerArchetype: str(b.buyerArchetype),
      isTestData: b.isTestData === true,
    }))
}

// An inbox request is its agent and brokerage; a Mojo buyer is their own name.
export function buyerName(b: DealflowBuyer): string {
  if (b.type === 'mojo') return b.name ?? 'Mojo buyer'
  return [b.name, b.brokerage].filter(Boolean).join(' · ') || 'Inbox buyer request'
}

// DealFlow spells building types several ways ("2-Family", "Two-Family", "Duplex").
const FAMILY_SIZE: Record<string, number> = {
  '2-family': 2, 'two-family': 2, duplex: 2, '3-family': 3, 'three-family': 3, triplex: 3,
  '4-family': 4, 'four-family': 4, fourplex: 4, quadplex: 4,
}
const TYPE_WORD: Record<string, string> = {
  sfh: 'single-family', 'single-family': 'single-family', multifamily: 'multifamily',
  'multi-family': 'multifamily', coop: 'co-op', 'co-op': 'co-op',
}
const ARCHETYPE: Record<string, string> = {
  CASH_BUYER: 'cash', EXCHANGE_1031: '1031 exchange', TRADITIONAL_FINANCING: 'financed',
  INVESTOR_LANDLORD: 'investor', FIRST_TIME_FHA: 'first-time buyer (FHA)',
  LUXURY_ALL_CASH: 'luxury, all cash', LUXURY_FINANCED: 'luxury, financed',
}

function typesText(types: string[]): string | null {
  const sizes = new Set<number>()
  const words = new Set<string>()
  for (const t of types) {
    const k = t.trim().toLowerCase()
    if (FAMILY_SIZE[k]) sizes.add(FAMILY_SIZE[k])
    else words.add(TYPE_WORD[k] ?? k)
  }
  const s = [...sizes].sort((a, b) => a - b)
  const run = s.length > 1 && s[s.length - 1] - s[0] === s.length - 1
  const family = run ? [`${s[0]}–${s[s.length - 1]} family`] : s.map((n) => `${n}-family`)
  return [...family, ...words].join(', ') || null
}

const money = (n: number) =>
  n >= 1e6 ? `$${Number((n / 1e6).toFixed(2))}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`

function range(min: number | null, max: number | null, fmt: (n: number) => string): string | null {
  if (min != null && max != null) return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`
  if (min != null) return `${fmt(min)}+`
  return max != null ? `up to ${fmt(max)}` : null
}

// One line of what the buyer wants: "2–4 family · Bed-Stuy, Crown Heights · 3+ BR · $1.35M–$2.6M".
export function buyerWants(b: DealflowBuyer): string {
  const hoods = b.neighborhoods.length > 3 ? [...b.neighborhoods.slice(0, 3), `+${b.neighborhoods.length - 3}`] : b.neighborhoods
  const parts = [
    typesText(b.propertyTypes),
    hoods.join(', ') || null,
    range(b.bedsMin, b.bedsMax, String)?.concat(' BR'),
    range(b.priceMin, b.priceMax, money),
    b.buyerArchetype ? (ARCHETYPE[b.buyerArchetype] ?? b.buyerArchetype.toLowerCase().replace(/_/g, ' ')) : null,
  ]
  return capitalize(parts.filter(Boolean).join(' · '))
}
