import 'dotenv/config'
import { Client } from 'pg'

// One-off setup script, already run once (Aug 2026): create the two new logical
// DBs (dealflow_crm, dealflow_crm_perf) on Ryan's Railway server. It needs an
// admin login (CREATE DATABASE) and touches no table, only issuing CREATE
// DATABASE.
//
// Brief 41.2 (PR F), engineering precaution: it used to borrow the DealFlow
// read-only setting (DATABASE_URL_DEALFLOW_RO) as its admin login. That setting
// is now read only by the read-only client, where every query runs in a READ
// ONLY transaction (CREATE DATABASE can't). If this is ever needed again, pass
// the server's admin address as DATABASE_URL_ADMIN for that one run, in the
// shell only; it belongs in no Vercel setting.
//
// CREATE DATABASE cannot run inside a transaction; the pg client issues each
// statement autocommit by default, so this is fine. Idempotent: existing DBs
// are skipped.

async function main() {
  const adminUrl = process.env.DATABASE_URL_ADMIN
  if (!adminUrl) throw new Error('DATABASE_URL_ADMIN not set (the Railway server admin address, for this one-off run)')

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
