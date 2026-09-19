import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { StampProvider } from "@/components/brand/StampToast";
import { SiteFooter } from "@/components/nav/SiteFooter";
import { SiteNav } from "@/components/nav/SiteNav";
import "./globals.css";

// Display: Bodoni Moda (opsz 6–96, italic) for hero and section titles only; it is what certificates were engraved in.
const display = Bodoni_Moda({ subsets: ["latin"], style: ["normal", "italic"], axes: ["opsz"], variable: "--font-bodoni", display: "swap" });
// Body: Instrument Sans with its width axis (75–100) for condensed, engraved-style small caps.
const body = Instrument_Sans({ subsets: ["latin"], axes: ["wdth"], variable: "--font-instrument", display: "swap" });
// Utility: IBM Plex Mono for tickers, serials, addresses and every number.
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex", display: "swap" });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://web-production-10951.up.railway.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // Pages set full titles themselves ("Live desk · DeltaDesk"), so there is no title template.
  title: "DeltaDesk · the open market-making desk for tokenized stocks",
  description:
    "Market making stocks was a closed club. We published its books: every swap in Robinhood Chain's stock pools, marked against Hyperliquid's 24/7 price, and a desk of your own.",
  applicationName: "DeltaDesk",
  openGraph: { type: "website", siteName: "DeltaDesk" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#0A0D0C",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable} h-full`}>
      <body className="flex min-h-full flex-col bg-vault text-paper">
        <a href="#content" className="skip-link">
          Skip to content
        </a>
        <StampProvider>
          <SiteNav />
          <div id="content" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </div>
          <SiteFooter />
        </StampProvider>
        <div aria-hidden="true" className="grain" />
      </body>
    </html>
  );
}
