// Brief 38 — plain-English labels for the keys DealFlow stores. Mapped at
// display time only; the stored values stay exactly as DealFlow wrote them.

// Match reasons: DealFlow stores a match's top scoring features as "a + b + c".
const REASON_LABELS: Record<string, string> = {
  neighborhood: 'right neighborhood',
  price: 'price fits budget',
  beds: 'bedrooms fit',
  baths: 'bathrooms fit',
  propertyType: 'right building type',
  carryingReasonableness: 'reasonable carrying costs',
  outdoorSpace: 'outdoor space fits',
  buildingAmenity: 'amenities fit',
  highEquity: 'high equity',
  freeAndClear: 'no mortgage',
  goldenHandcuff: 'not locked into a low rate',
  absenteeOwner: 'owner lives elsewhere',
  vacancy: 'vacant property',
  preForeclosure: 'pre-foreclosure',
  foreclosureUrgency: 'foreclosure auction soon',
  tenure: 'long-time owner',
  sourceListMotivation: 'motivated-seller list',
  substitutionScarcity: 'few other options for this buyer',
  buyerArchetypeSituation: 'buyer type suits the situation',
  recency: 'recent buyer request',
  // Call-list ranking keys, seen in queue reasons like "Match: cooldownPenalty + freshnessBoost".
  matchFitLift: 'strong match',
  matchFitConfidenceLift: 'confident match',
  captureBonus: 'you hold a side',
  motivationSummary: 'motivated seller',
  freshnessBoost: 'new match',
  cooldownPenalty: 'not called recently',
  reachabilityBonus: 'easy to reach',
}

const CAPTURE_LABELS: Record<string, string> = {
  OWN_BOTH_SIDES: 'Both sides yours',
  OWN_BUYER_ONLY: 'Your buyer',
  OWN_LISTING_ONLY: 'Your listing',
  EXTERNAL_BOTH: 'Neither side yours yet',
}

const ZONE_LABELS: Record<string, string> = {
  'America/New_York': 'Eastern',
  'America/Chicago': 'Central',
  'America/Denver': 'Mountain',
  'America/Phoenix': 'Arizona',
  'America/Los_Angeles': 'Pacific',
  'America/Anchorage': 'Alaska',
  'Pacific/Honolulu': 'Hawaii',
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// Unknown keys: split the camelCase ("someNewFeature" → "some new feature").
export function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

export function reasonList(keys: string[]): string {
  return capitalize(keys.map(reasonLabel).join(', '))
}

// "neighborhood + beds" or "Match: a + b" → "Right neighborhood, bedrooms fit".
// Text that is already a sentence ("Never contacted") comes back unchanged.
export function reasonText(text: string | null | undefined): string | null {
  const keys = text?.trim().match(/^(?:Match: )?([A-Za-z]+(?: \+ [A-Za-z]+)*)$/)
  return keys ? reasonList(keys[1].split(' + ')) : (text ?? null)
}

export function captureLabel(status: string | null | undefined): string | null {
  if (!status) return null
  return CAPTURE_LABELS[status] ?? capitalize(status.toLowerCase().replace(/_/g, ' '))
}

export function timezoneLabel(tz: string | null | undefined): string | null {
  return tz ? (ZONE_LABELS[tz] ?? tz) : null
}
