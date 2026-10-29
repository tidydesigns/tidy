import { createContext } from "react";
import type { BrowserScope } from "../../../../shared/contracts/browser";

export const BrowserNavigationContext = createContext<((url: string) => void) | null>(null);
export type BrowserNavigationRequest = BrowserScope & { id: string; url: string };
