"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { communityEligible, communityKeys, dismissCommunity } from "./community-progress";

const CommunityDialog = lazy(() =>
  import("./community-dialog").catch(() => ({ default: () => <></> })),
);
const dismissedInSession = new Set<string>();

export function CommunityPrompt({ userId }: { userId: string }) {
  const pathname = usePathname();
  const [invitedUser, setInvitedUser] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      try {
        setInvitedUser(
          !dismissedInSession.has(userId) && communityEligible(window.localStorage, userId)
            ? userId
            : null,
        );
      } catch {
        setInvitedUser(null);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === communityKeys(userId).dismissed || event.key === null) {
        setInvitedUser(null);
      }
    };
    refresh();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [pathname, userId]);

  if (invitedUser !== userId) return null;
  return (
    <Suspense fallback={null}>
      <CommunityDialog
        onDismiss={() => {
          dismissedInSession.add(userId);
          setInvitedUser(null);
          try {
            dismissCommunity(window.localStorage, userId);
          } catch {
            // Accessing localStorage itself can be blocked by browser policy.
          }
        }}
      />
    </Suspense>
  );
}
