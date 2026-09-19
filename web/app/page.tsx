import { Suspense } from "react";
import { SmoothScroll } from "@/components/brand/SmoothScroll";
import { EngravedBook } from "@/components/landing/EngravedBook";
import { ForAgents } from "@/components/landing/ForAgents";
import { TheBooks, TheBooksFallback } from "@/components/landing/TheBooks";
import { TheDesk } from "@/components/landing/TheDesk";
import { YourLedger } from "@/components/landing/YourLedger";
import "@/components/landing/landing.css";

// The landing. The Study that used to live here is at /study.
// The hero and the five acts render as HTML first (the headline is the LCP); the relief and three.js load after, on
// the client, and only here. The relief reads native scroll events (Lenis fires them), so no gsap loads on this page.
// The study's numbers stream in from the engine API.
export default function Home() {
  return (
    <main>
      <SmoothScroll />
      <EngravedBook />
      <Suspense fallback={<TheBooksFallback />}>
        <TheBooks />
      </Suspense>
      <YourLedger />
      <TheDesk />
      <ForAgents />
    </main>
  );
}
