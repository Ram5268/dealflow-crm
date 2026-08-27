import { NextResponse } from 'next/server'
import { healthReport } from '@/lib/comms/health'

export const dynamic = 'force-dynamic'

export function GET() {
  const report = healthReport()
  return NextResponse.json(report, { status: report.status === 'ok' ? 200 : 503 })
}
