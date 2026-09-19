import Link from "next/link";
import { DeltaMark } from "@/components/brand/DeltaMark";
import { Guilloche } from "@/components/brand/Guilloche";
import { Label } from "@/components/brand/Label";
import { Serial } from "@/components/brand/Serial";
import { Wordmark } from "@/components/brand/Wordmark";
import { DESK_LINK, NAV_LINKS } from "./links";

const READ = NAV_LINKS.filter((l) => ["/study", "/live", "/tearsheet", "/league"].includes(l.href));
const RUN = [DESK_LINK, ...NAV_LINKS.filter((l) => ["/console", "/brand"].includes(l.href))];

/** Site footer: seal + thesis, the map, sources, the disclaimer, the chain serial. */
export function SiteFooter() {
  return (
    <footer className="mt-28 border-t border-rule" style={{ viewTransitionName: "site-footer" }}>
      <div className="mx-auto grid w-full max-w-[90rem] gap-12 px-4 pt-14 pb-12 md:grid-cols-12 md:px-8">
        <div className="space-y-7 md:col-span-6 lg:col-span-5">
          <Link href="/" className="inline-flex items-center gap-3" aria-label="DeltaDesk, home">
            <DeltaMark variant="seal" size={40} className="text-paper" />
            <Wordmark size="1.5rem" />
          </Link>
          <p className="font-display max-w-[20ch] text-[clamp(1.6rem,2.6vw,2.35rem)] leading-[1.06] tracking-[-0.02em] text-paper">
            Market making stocks was a closed club. We published its <em>books</em>.
          </p>
        </div>

        <nav aria-label="Footer" className="grid grid-cols-2 gap-8 md:col-span-6 lg:col-span-4">
          <FooterList title="Read the books" links={READ} />
          <FooterList title="Run a desk" links={RUN} />
        </nav>

        <div className="space-y-3 md:col-span-12 lg:col-span-3">
          <Label as="h2">Data</Label>
          <p className="max-w-[40ch] text-[0.9rem] leading-relaxed text-paper-dim">
            Swaps and positions from Robinhood Chain&apos;s stock pools, marked against Hyperliquid trade.xyz 24/7 prices and Chainlink feeds.
            Contracts and agent actions are on-chain and linked where they appear.
          </p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[90rem] px-4 md:px-8">
        <Guilloche variant="divider" opacity={0.35} />
      </div>
      <div className="mx-auto flex w-full max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-6 md:px-8">
        <p className="label text-paper-mute">Informational analytics, not investment advice</p>
        <p className="label text-paper-mute">
          <Serial n="4663" /> · Robinhood Chain
        </p>
      </div>
    </footer>
  );
}

function FooterList({ title, links }: { title: string; links: { href: string; label: string; prefetch?: false }[] }) {
  return (
    <div className="space-y-4">
      <Label as="h2">{title}</Label>
      <ul className="space-y-2.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} prefetch={l.prefetch} className="text-[0.95rem] text-paper-dim transition-colors hover:text-paper">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
