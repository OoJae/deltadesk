"use client";

// The desk's Dynamic session, provided by DynamicShell. Kept apart from session.ts so that components can read it
// without importing the Dynamic SDK (see DeskProviders).
import { createContext, useContext } from "react";
import type { DeskSession } from "./session";

export const DeskSessionContext = createContext<DeskSession | null>(null);

/** The desk session, or null when Dynamic is not configured (NEXT_PUBLIC_DYNAMIC_ENV_ID unset). */
export const useDeskSession = () => useContext(DeskSessionContext);
