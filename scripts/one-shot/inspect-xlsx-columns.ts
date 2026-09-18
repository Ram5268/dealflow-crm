import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { parseFile, sampleValues } from '../../src/lib/core-data/importer/parser'

// ─────────────────────────────────────────────────────────────────────────────
// Read-only discovery helper (FIX-1 PR B). Pulls an ImportBatch.sourceBlob out
// of Postgres and prints its column inventory + sample values, so we can tell
// whether a column (e.g. "Phone 5") was present in the source export at all.
//
// Usage: pnpm exec tsx scripts/one-shot/inspect-xlsx-columns.ts <importBatchId>
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const batchId = process.argv[2]
  if (!batchId) throw new Error('usage: inspect-xlsx-columns.ts <importBatchId>')
  const prisma = new PrismaClient()
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { id: true, filename: true, sourceBlob: true, totalRows: true },
  })
  if (!batch) throw new Error(`no ImportBatch ${batchId}`)
  if (!batch.sourceBlob) throw new Error(`ImportBatch ${batchId} has no sourceBlob (swept)`)

  const parsed = parseFile(Buffer.from(batch.sourceBlob), batch.filename)
  console.log(`file: ${batch.filename}`)
  console.log(`rows parsed: ${parsed.totalRowsDetected} (batch.totalRows=${batch.totalRows})`)
  console.log(`columns: ${parsed.headerRow.length}\n`)

  for (const col of parsed.headerRow) {
    const vals = sampleValues(parsed.allRows, col, 3)
    const filled = parsed.allRows.filter((r) => (r[col] ?? '').trim() !== '').length
    console.log(
      `${col.padEnd(34)} filled=${String(filled).padStart(5)}  ${JSON.stringify(vals).slice(0, 90)}`
    )
  }
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
