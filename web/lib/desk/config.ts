// Public (browser-inlined) desk configuration. Server-only agent settings live in lib/desk/agent.ts.
//   NEXT_PUBLIC_DYNAMIC_ENV_ID  Dynamic environment id (sandbox for M2). Unset -> "Dynamic not configured".
//   NEXT_PUBLIC_DESK_FACTORY    DeskLaneFactory on 4663. Unset -> "not deployed yet".
//   NEXT_PUBLIC_DESK_GUARDIAN   optional watchdog (guardian) address written into new lanes; unset -> no guardian.
// NEXT_PUBLIC_ values are inlined at build time, so each must be read with a literal process.env.X access.
import { getAddress, isAddress, parseEther, zeroAddress, type Address } from "viem";

const addr = (v: string | undefined): Address | null => (v && isAddress(v.trim()) ? getAddress(v.trim()) : null);

export const DYNAMIC_ENV_ID = process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID?.trim() || null;
export const DESK_FACTORY = addr(process.env.NEXT_PUBLIC_DESK_FACTORY);
export const DESK_GUARDIAN: Address = addr(process.env.NEXT_PUBLIC_DESK_GUARDIAN) ?? zeroAddress;

/** Gas the user tops up before creating the desk (design: ~0.002 ETH Vault, ~0.005 ETH Operator). */
export const GAS_TARGET_WEI = { vault: parseEther("0.002"), operator: parseEther("0.005") } as const;
