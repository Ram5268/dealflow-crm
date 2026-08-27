import Link from 'next/link'

// Minimal top nav shared across the CRM surfaces.
export function Nav() {
  const links = [
    { href: '/leads', label: 'Leads' },
    { href: '/queue', label: 'Queue' },
    { href: '/imports', label: 'Import' },
  ]
  return (
    <header className="border-b border-neutral-200 bg-white">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
        <span className="font-semibold text-neutral-900">DealFlow CRM</span>
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="text-sm text-neutral-600 hover:text-neutral-900">
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
