import type { IncomingMessage, ServerResponse } from 'node:http'

/** Minimal helpers shared by the Agent-D mock servers (node:http, no deps). */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

export function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
