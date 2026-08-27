import 'dotenv/config'
import { Client } from 'pg'

// One-time bootstrap: create the two new logical DBs (dealflow_crm,
// dealflow_crm_perf) on Ryan's Railway server. Connects via the DEALFLOW_RO
// URL's server (default `railway` DB) purely as an admin bootstrap connection —
// we do NOT touch any DealFlow table here, only issue CREATE DATABASE.
//
// CREATE DATABASE cannot run inside a transaction; the pg client issues each
// statement autocommit by default, so this is fine. Idempotent: existing DBs
// are skipped.

async function main() {
  const adminUrl = process.env.DATABASE_URL_DEALFLOW_RO
  if (!adminUrl) throw new Error('DATABASE_URL_DEALFLOW_RO not set')

  const client = new Client({ connectionString: adminUrl })
  await client.connect()

  for (const db of ['dealflow_crm', 'dealflow_crm_perf']) {
    const exists = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [db]
    )
    if (exists.rowCount && exists.rowCount > 0) {
      console.log(`  = ${db} already exists`)
      continue
    }
    // Identifier is a fixed literal from this file, never user input.
    await client.query(`CREATE DATABASE "${db}"`)
    console.log(`  + created ${db}`)
  }

  await client.end()
  console.log('bootstrap-databases: done')
}

main().catch((err) => {
  console.error('bootstrap-databases failed:', err.message)
  process.exit(1)
})
