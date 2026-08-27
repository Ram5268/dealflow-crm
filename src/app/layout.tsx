import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'DealFlow CRM',
  description: 'Private single-seat CRM + dialer for a solo NYC broker.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
