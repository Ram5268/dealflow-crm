import Link from 'next/link'
import { BarChart3 } from 'lucide-react'
import { EmptyState } from '@/components/ui'

/**
 * Explicitly not built (M6 §6). There is no reporting backend — no lib, no API
 * route, and no model that aggregates pipeline or activity — so this says so
 * and points at the three surfaces that answer the same questions today, rather
 * than rendering an empty chart that implies data is merely missing.
 */
export default function ReportsPage() {
  return (
    <EmptyState
      icon={<BarChart3 aria-hidden />}
      title="Reports are not built yet"
      description="Pipeline and activity reporting needs an aggregation layer that does not exist. In the meantime these answer most of the same questions:"
      action={
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
          <Link href="/" className="text-accent hover:underline">
            Focus — today&rsquo;s priorities
          </Link>
          <Link href="/settings/usage" className="text-accent hover:underline">
            Usage — calls and spend
          </Link>
          <Link href="/leads" className="text-accent hover:underline">
            Leads — saved views
          </Link>
        </div>
      }
    />
  )
}
