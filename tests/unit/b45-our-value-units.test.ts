import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { OUR_VALUE_LABEL, ourValueParts } from '@/components/lists/OurValue'
import { parseDollars } from '@/app/pipeline/value-range'
import { PIPELINE_CSV_COLUMNS, pipelineRowsToCsv } from '@/app/pipeline/csv'
import { canonicalDollars, VALUE_FILTER_MAX } from '@/lib/core-data/lists/rules'
import { makeTable } from './helpers/pipeline-fixtures'

// Brief 45 PR G — the pure pieces behind "our value and range": the words
// (the lead page's card wording), the dollar box of the value-range filter,
// the Pipeline table's CSV (no value in it), and a guard that no message or
// template code can read our estimates [Ryan, 2026-10-17: our value estimates
// never reach anything a buyer or homeowner sees]. Made-up values only.

describe('the words', () => {
  it('"$1.83M" and "likely $1.54M–$2.12M", like the lead page\'s card; labelled as ours', () => {
    expect(ourValueParts({ value: 1_830_000, low: 1_540_000, high: 2_120_000 })).toEqual({ value: '$1.83M', range: 'likely $1.54M–$2.12M' })
    expect(ourValueParts({ value: 875_000, low: 790_000, high: 1_020_000 })).toEqual({ value: '$875K', range: 'likely $790K–$1.02M' })
    expect(OUR_VALUE_LABEL).toBe('DealFlow estimate · only you see this')
  })
})

describe('the value-range boxes: dollars as people type them', () => {
  it.each<[string, number | null]>([
    ['', null],
    ['   ', null],
    ['1500000', 1_500_000],
    ['1,500,000', 1_500_000],
    ['$1,500,000', 1_500_000],
    ['1.5M', 1_500_000],
    ['1.5m', 1_500_000],
    ['$ 2 m', 2_000_000],
    ['900k', 900_000],
    ['900K', 900_000],
    ['1.25M', 1_250_000],
    ['0', 0],
    ['1000000000', 1_000_000_000],
    ['1B', 1_000_000_000],
  ])('%j → %s', (input, dollars) => {
    expect(parseDollars(input)).toEqual({ ok: true, dollars })
  })

  it.each(['lots', '-5', '1.5', '1,50,0000x', '1000000001', '2B', '$', '1.2.3M', 'Infinity', '1e9'])('%j is refused in plain English', (input) => {
    const r = parseDollars(input)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/dollar|\$1,000,000,000/)
  })
})

describe('the API and saved workflows: whole dollars, written one way', () => {
  it('canonicalDollars: digits only, at most $1,000,000,000, leading zeros dropped', () => {
    expect(VALUE_FILTER_MAX).toBe(1_000_000_000)
    expect(canonicalDollars('1500000')).toBe('1500000')
    expect(canonicalDollars(' 0900000 ')).toBe('900000')
    expect(canonicalDollars('0')).toBe('0')
    expect(canonicalDollars('1000000000')).toBe('1000000000')
    for (const bad of ['1000000001', '12345678901', '-1', '1.5', '1,500,000', '1.5M', '', 'abc', '0x10']) expect([bad, canonicalDollars(bad)]).toEqual([bad, null])
  })
})

describe("the Pipeline table's CSV of selected rows", () => {
  it('has the same columns as before and never a value [engineering precaution: exports can be forwarded]', () => {
    const table = makeTable()
    const rows = table.rows.map((r, i) => ({ ...r, value: { value: 1_830_000 + i, low: 1_540_000, high: 2_120_000 } }))
    const csv = pipelineRowsToCsv(rows)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('Rank,Name,Address,Groups,Best buyer,Last contact,Next task,Task due,In group since')
    expect([...PIPELINE_CSV_COLUMNS]).toEqual(lines[0].split(','))
    expect(lines).toHaveLength(rows.length + 1)
    expect(csv).not.toMatch(/183000|154000|212000|1\.83M|likely|\$/)
  })
})

describe('no message or template can read our estimates [Ryan, 2026-10-17]', () => {
  // Our estimates live only on the DealFlow signal (dealflowRawJson.property),
  // read by the lead page's card and Brief 45's list / Pipeline queries. The
  // code that writes or sends messages (templates, sequences, email, texts)
  // must never read the signal or those queries.
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f)
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : []
    })

  it('src/lib/comms never touches the signal, the property lookup, or the list and Pipeline queries', () => {
    const comms = files(join(process.cwd(), 'src/lib/comms'))
    expect(comms.length).toBeGreaterThan(10)
    const hits = comms.filter((f) =>
      /DealFlowDerivedSignal|dealFlowDerivedSignal|dealflowRawJson|property-lookup|dealflow-sync\/property|lists\/(ranked|pipeline)|OurValue/.test(readFileSync(f, 'utf8')),
    )
    expect(hits).toEqual([])
  })
})
