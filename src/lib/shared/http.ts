import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  CORRELATION_HEADER,
  newCorrelationId,
  runWithCorrelationId,
} from '@/lib/shell/correlationId'
import { captureException } from '@/lib/shared/sentry'

// ─────────────────────────────────────────────────────────────────────────────
// Route plumbing shared by every A endpoint:
//  - reads/echoes x-correlation-id and binds it into async-local-storage so
//    logger + Sentry pick it up without threading;
//  - catches unhandled errors → 500 + Sentry;
//  - json()/error() helpers stamp the correlation header on the response.
// ─────────────────────────────────────────────────────────────────────────────

export function getCorrelation(req: NextRequest | Request): string {
  return req.headers.get(CORRELATION_HEADER) ?? newCorrelationId()
}

export function json<T>(
  data: T,
  correlationId: string,
  init?: { status?: number; headers?: Record<string, string> }
): NextResponse {
  const res = NextResponse.json(data, { status: init?.status ?? 200 })
  res.headers.set(CORRELATION_HEADER, correlationId)
  for (const [k, v] of Object.entries(init?.headers ?? {})) res.headers.set(k, v)
  return res
}

export function errorResponse(
  message: string,
  status: number,
  correlationId: string,
  extra?: Record<string, unknown>
): NextResponse {
  return json({ error: message, ...extra }, correlationId, { status })
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

type Handler = (
  req: NextRequest,
  ctx: { correlationId: string; params?: Record<string, string> }
) => Promise<NextResponse> | NextResponse

// Wraps a route handler with correlation binding + uniform error handling.
export function withRoute(handler: Handler) {
  return async (
    req: NextRequest,
    routeCtx?: { params?: Promise<Record<string, string>> | Record<string, string> }
  ): Promise<NextResponse> => {
    const correlationId = getCorrelation(req)
    const params = routeCtx?.params ? await routeCtx.params : undefined
    return runWithCorrelationId(correlationId, async () => {
      try {
        return await handler(req, { correlationId, params })
      } catch (err) {
        if (err instanceof HttpError) {
          return errorResponse(err.message, err.status, correlationId, err.extra)
        }
        if (err instanceof z.ZodError) {
          return errorResponse('Invalid request body', 400, correlationId, {
            issues: err.issues,
          })
        }
        captureException(err, { route: req.nextUrl?.pathname })
        return errorResponse('Internal error', 500, correlationId)
      }
    })
  }
}

// Parse + validate a JSON body against a zod schema, throwing HttpError(400).
export async function parseBody<S extends z.ZodType>(
  req: NextRequest,
  schema: S
): Promise<z.infer<S>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new HttpError(400, 'Invalid request body', { issues: result.error.issues })
  }
  return result.data
}
