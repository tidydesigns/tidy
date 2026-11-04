import { useEffect, useState } from "react";
import type { CommunityAPI } from "../../../../shared/contracts/community";
import { lazyView } from "../../components/lazy-view";
import { communityProgress } from "./community-progress";

const CommunityDialog = lazyView(() => import("./community-dialog"), {
  label: "community invitation",
  fallback: () => null,
  errorFallback: null,
});

export function CommunityPrompt({ api }: { api?: CommunityAPI }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const progress = communityProgress();
    if (!api || !progress) return;
    let active = true;
    let checked = false;
    const check = () => {
      if (checked || !progress.eligible) return;
      checked = true;
      void api
        .status()
        .catch(() => "unavailable" as const)
        .then((status) => {
          if (!active) return;
          if (status === "starred") return progress.suppress();
          if (progress.eligible) setVisible(true);
        });
    };
    const storageChanged = () => {
      if (progress.suppressed) {
        setVisible(false);
      } else check();
    };
    const unsubscribe = progress.subscribe(check);
    window.addEventListener("storage", storageChanged);
    check();
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("storage", storageChanged);
    };
  }, [api]);

  return visible && api ? (
    <CommunityDialog
      api={api}
      onDismiss={() => {
        communityProgress()?.suppress();
        setVisible(false);
      }}
      onSuccess={() => communityProgress()?.suppress()}
    />
  ) : null;
}
