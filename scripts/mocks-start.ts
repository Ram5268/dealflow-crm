import { start as startCompliance } from '../contracts/mocks/compliance/comms-mock'
import { start as startTwilio } from '../contracts/mocks/twilio/server'
import { start as startGmail } from '../contracts/mocks/gmail/server'
import { start as startGraph } from '../contracts/mocks/graph/server'

// Starts the four Agent-D mocks on their env-configured ports (defaults
// 4001-4004) and stays alive until signalled.
const servers = [
  { name: 'compliance', server: startCompliance() },
  { name: 'twilio', server: startTwilio() },
  { name: 'gmail', server: startGmail() },
  { name: 'graph', server: startGraph() },
]

for (const { name, server } of servers) {
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : addr
  console.log(`[mock] ${name} listening on ${port}`)
}

function shutdown() {
  for (const { server } of servers) server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
