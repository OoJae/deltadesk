import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "DeltaDesk · the open market-making desk for tokenized stocks",
  description: "Can LPs beat informed flow on tokenized stocks? Every swap in Robinhood Chain's stock pools, marked against Hyperliquid's 24/7 price.",
};

const NAV = [
  { href: "/", label: "Study" },
  { href: "/live", label: "Live desk" },
  { href: "/tearsheet", label: "Tearsheet" },
  { href: "/league", label: "League" },
  { href: "/desk", label: "Desk" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <nav className="sticky top-0 z-10 border-b border-grid bg-page/90 backdrop-blur">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
            <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
              <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden><rect width="64" height="64" rx="14" fill="var(--surface-2)" /><path d="M14 44 L26 30 L34 38 L50 20" stroke="var(--accent)" strokeWidth="6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              DeltaDesk
            </Link>
            <div className="-mx-2 flex text-sm sm:mx-0 sm:gap-1">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-lg px-2 py-1.5 text-ink-2 hover:bg-surface-2 hover:text-ink sm:px-3">{n.label}</Link>
              ))}
            </div>
          </div>
        </nav>
        <div className="flex-1">{children}</div>
        <footer className="border-t border-grid py-6 text-center text-xs text-muted">Informational analytics, not investment advice · data: Robinhood Chain, Hyperliquid trade.xyz, Chainlink</footer>
      </body>
    </html>
  );
}
