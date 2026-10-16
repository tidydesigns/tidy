"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useTransition,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

type Recovery = { available: () => boolean; claim: () => boolean };
const RecoveryContext = createContext<Recovery | null>(null);
function recoveryFor(pathname: string): Recovery {
  let attempted = false;
  const enabled = pathname === "/mcp" || pathname === "/settings";
  return {
    available: () => enabled && !attempted,
    claim: () => {
      if (!enabled || attempted) return false;
      attempted = true;
      return true;
    },
  };
}

// Lives above route error boundaries so refreshes cannot reset the retry budget.
// All failed sections share one fresh request per visit, including Strict Mode.
export function NavigationRecoveryProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const recovery = useMemo(() => recoveryFor(pathname), [pathname]);
  return <RecoveryContext value={recovery}>{children}</RecoveryContext>;
}

export function useNavigationRecovery(retry: () => void) {
  const recovery = useContext(RecoveryContext);
  const [pending, startTransition] = useTransition();
  const available = recovery?.available();
  useEffect(() => {
    if (!recovery?.claim()) return;
    // Next's retry invalidates failed RSC data as well as resetting the boundary.
    // Never retry a guard RPC here; the fresh render performs authorization anew.
    startTransition(retry);
  }, [recovery, retry]);
  return pending || available;
}
