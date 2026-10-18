// Brief 45 (PR A): CI's migration check. Reads the output of
//   prisma migrate diff --from-url <db migrated from zero> --to-schema-datamodel prisma/schema.prisma --script
// and exits 1 unless the only differences are the four cosmetic `id` defaults
// in docs/known-drift.md, all four of them (an empty diff doesn't pass).
//   tsx scripts/check-known-drift.ts <diff.sql>
import { readFileSync } from 'node:fs'
import { checkKnownDrift } from '../src/lib/shared/known-drift'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: check-known-drift.ts <diff.sql>')
  process.exit(1)
}
const { unexpected, missing } = checkKnownDrift(readFileSync(file, 'utf8'))
if (unexpected.length > 0) {
  console.error('The migrations do not build prisma/schema.prisma. Unexpected differences:')
  for (const line of unexpected) console.error(`  ${line}`)
  process.exit(1)
}
if (missing.length > 0) {
  console.error(
    `The diff is missing ${missing.length} of the 4 known cosmetic id defaults, so it did not compare a ` +
      'migrated database (empty or failed diff?). Missing:',
  )
  for (const line of missing) console.error(`  ${line}`)
  process.exit(1)
}
console.log('Migrations from zero match prisma/schema.prisma (only the 4 known cosmetic id defaults differ).')
