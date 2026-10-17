"use client";

import { useEffect, useState } from "react";

const refreshInterval = 5 * 60 * 1000;

export function GitHubStars({ repositoryUrl }: { repositoryUrl: string }) {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const repository = repositoryUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/i);
    if (!repository) return;

    const [, owner, name] = repository;
    const controller = new AbortController();

    async function refreshStars() {
      if (document.visibilityState === "hidden") return;

      try {
        const response = await fetch(
          `https://api.github.com/repos/${owner}/${name.replace(/\.git$/, "")}`,
          {
            headers: { Accept: "application/vnd.github+json" },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (!response.ok) return;

        const data = await response.json();
        if (
          !controller.signal.aborted &&
          Number.isSafeInteger(data?.stargazers_count) &&
          data.stargazers_count >= 0
        ) {
          setStars(data.stargazers_count);
        }
      } catch {
        // Keep the link and any last known count usable if GitHub is unavailable.
      }
    }

    void refreshStars();
    const interval = window.setInterval(refreshStars, refreshInterval);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [repositoryUrl]);

  return (
    <span
      className="github-stars"
      role="img"
      style={{ visibility: stars === null ? "hidden" : undefined }}
      aria-label={stars === null ? undefined : `${stars.toLocaleString("en-US")} stars`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="m12 3 2.78 5.63L21 9.54l-4.5 4.39L17.56 20 12 17.08 6.44 20l1.06-6.07L3 9.54l6.22-.91L12 3Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      <span aria-hidden="true">{stars === null ? "" : stars.toLocaleString("en-US")}</span>
    </span>
  );
}
