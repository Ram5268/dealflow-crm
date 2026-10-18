// Brief 44 (PR 5): an invented valuation, shaped like the newest published
// PropertyValuation that PROPERTY_SQL reads from DealFlow (Brief 44's valuation
// contract §3, §7). Every address, number and date here is made up.

type Over = Record<string, unknown>

// A nearby earlier sale. i = 0..11: dates count back from Sep 12, 2026.
export const comp = (i: number, over: Over = {}) => ({
  address: `${12 + 2 * i} Example St`,
  date: `2026-09-${String(12 - i).padStart(2, '0')}`,
  price: 1_750_000 - i * 50_000,
  pricePerSqft: 712 - i * 10,
  distanceMiles: Number((0.1 * (i + 1)).toFixed(2)),
  ...over,
})

export const facts = (over: Over = {}) => ({
  units: 2,
  buildingSqft: 2400,
  lotSqft: 2000,
  yearBuilt: 1910,
  floors: 3,
  zoning: 'R6B',
  buildingClass: 'B1',
  historicDistrict: false,
  lastSale: { date: '2015-06-03', price: 1_200_000 },
  dofMarketValue: { value: 1_410_000, fiscalYear: 2027 },
  permits7y: { count: 2, major: true },
  openViolations: { dob: 0, ecb: 1, hpd: 0 },
  subwayMiles: 0.3,
  leadVsCity: { units: { lead: 3, city: 2 }, buildingSqft: null },
  ...over,
})

export const sources = (over: Over = {}) => ({
  downloadedOn: '2026-10-18',
  salesThrough: '2026-09-30',
  plutoVersion: '26v2',
  rollFiscalYear: 2027,
  datasets: { 'abcd-1234': { updatedOn: '2026-10-15', rows: 1200 }, dof_annual: { updatedOn: null, rows: 50 } },
  ...over,
})

// The jsonb object the read-only query returns for one seller.
export const rawProperty = (over: Over = {}) => ({
  asOf: '2026-10-01',
  dataThrough: '2026-09-30',
  publishedAt: '2026-10-20T10:31:00.123Z',
  value: 1_830_000,
  low: 1_540_000,
  high: 2_120_000,
  reason: null,
  facts: facts(),
  comps: [comp(0), comp(1)],
  sources: sources(),
  ...over,
})
