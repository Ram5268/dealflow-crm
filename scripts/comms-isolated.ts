import 'dotenv/config'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { start as startCompliance } from '../contracts/mocks/compliance/comms-mock'
import { start as startTwilio } from '../contracts/mocks/twilio/server'
import { start as startGmail } from '../contracts/mocks/gmail/server'
import { start as startGraph } from '../contracts/mocks/graph/server'

/**
 * Gate-1 isolation boot: starts the four mocks in-process, points the app env at
 * them, then runs `next dev` as a child (Agents A/B/C code entirely absent). One
 * process tree so Ctrl-C cleans everything up.
 */
const servers = [
  startCompliance(),
  startTwilio(),
  startGmail(),
  startGraph(),
]
console.log('[isolated] mocks up: compliance 4001, twilio 4002, gmail 4003, graph 4004')

process.env.COMPLIANCE_BASE_URL ??= 'http://localhost:4001'
process.env.TWILIO_API_BASE ??= 'http://localhost:4002'
process.env.GMAIL_MOCK_URL ??= 'http://localhost:4003'
process.env.GRAPH_MOCK_URL ??= 'http://localhost:4004'
// Twilio signs inbound webhooks; in isolation we skip verification so canned
// payloads work without a shared auth token.
process.env.TWILIO_MOCK_SKIP_SIGNATURE ??= 'true'

const nextBin = path.resolve('node_modules/.bin/next')
const port = process.env.PORT ?? '3000'
const child = spawn(nextBin, ['dev', '-p', port], { stdio: 'inherit', env: process.env })

function shutdown() {
  child.kill('SIGTERM')
  for (const s of servers) s.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
child.on('exit', (code) => {
  for (const s of servers) s.close()
  process.exit(code ?? 0)
})
