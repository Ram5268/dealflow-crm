// Brief 45 (PR A): CI's migration check. Reads the output of
//   prisma migrate diff --from-url <db migrated from zero> --to-schema-datamodel prisma/schema.prisma --script
// and exits 1 unless the only differences are the four cosmetic `id` defaults
// in docs/known-drift.md.
//   tsx scripts/check-known-drift.ts <diff.sql>
import { readFileSync } from 'node:fs'
import { unexpectedDrift } from '../src/lib/shared/known-drift'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('usage: check-known-drift.ts <diff.sql>')
  process.exit(1)
}
const unexpected = unexpectedDrift(readFileSync(file, 'utf8'))
if (unexpected.length > 0) {
  console.error('The migrations do not build prisma/schema.prisma. Unexpected differences:')
  for (const line of unexpected) console.error(`  ${line}`)
  process.exit(1)
}
console.log('Migrations from zero match prisma/schema.prisma (only the known cosmetic id defaults differ).')
