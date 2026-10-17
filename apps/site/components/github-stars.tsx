"use client";

import { useEffect, useState } from "react";

const refreshInterval = 5 * 60 * 1000;
// Keep the last result across client-side page navigation, including failed refreshes.
const starCache = new Map<string, { stars: number; refreshedAt: number }>();

export function GitHubStars({ repositoryUrl }: { repositoryUrl: string }) {
  const [stars, setStars] = useState<number | null>(
    () => starCache.get(repositoryUrl)?.stars ?? null,
  );

  useEffect(() => {
    const repository = repositoryUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)\/?$/i);
    if (!repository) return;

    const [, owner, name] = repository;
    const controller = new AbortController();
    let requestInFlight = false;
    let lastSuccessfulRefresh = starCache.get(repositoryUrl)?.refreshedAt ?? null;
    let refreshTimeout: number | undefined;

    function scheduleRefresh() {
      window.clearTimeout(refreshTimeout);
      if (controller.signal.aborted) return;

      const remainingFreshTime =
        lastSuccessfulRefresh === null
          ? refreshInterval
          : refreshInterval - (Date.now() - lastSuccessfulRefresh);
      refreshTimeout = window.setTimeout(
        refreshStars,
        remainingFreshTime > 0 ? remainingFreshTime : refreshInterval,
      );
    }

    async function refreshStars() {
      if (controller.signal.aborted || requestInFlight) return;
      if (
        document.visibilityState === "hidden" ||
        (lastSuccessfulRefresh !== null && Date.now() - lastSuccessfulRefresh < refreshInterval)
      ) {
        scheduleRefresh();
        return;
      }

      requestInFlight = true;
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
          lastSuccessfulRefresh = Date.now();
          starCache.set(repositoryUrl, {
            stars: data.stargazers_count,
            refreshedAt: lastSuccessfulRefresh,
          });
          setStars(data.stargazers_count);
        }
      } catch {
        // Keep the link and any last known count usable if GitHub is unavailable.
      } finally {
        requestInFlight = false;
        scheduleRefresh();
      }
    }

    void refreshStars();
    document.addEventListener("visibilitychange", refreshStars);
    window.addEventListener("online", refreshStars);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", refreshStars);
      window.removeEventListener("online", refreshStars);
      window.clearTimeout(refreshTimeout);
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
