import "server-only";
import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { db } from "@/lib/db";
import { activityReport, retentionReport, accountRetentionReport } from "./reports";
import { analyticsSetting } from "./config";

const releases = z
  .array(
    z.object({
      tag_name: z.string().max(100),
      draft: z.boolean(),
      assets: z
        .array(
          z.object({
            id: z.number().int().positive(),
            name: z.string().max(200),
            download_count: z.number().int().nonnegative(),
          }),
        )
        .max(20),
    }),
  )
  .max(100);
/** Counters are file requests, including CI verification, never people or confirmed installs. */
export async function snapshotDownloads(fetcher: typeof fetch = fetch) {
  if (
    (
      await db.query(
        `select 1 from "productAnalyticsExport" where day=(clock_timestamp() at time zone 'UTC')::date and "downloadsAt" is not null`,
      )
    ).rowCount
  )
    return;
  // Fixed public repository; no credentials and no user-supplied network target.
  for (let page = 1; page <= 3; page++) {
    const response = await fetcher(
      `https://api.github.com/repos/tidydesigns/tidy/releases?per_page=100&page=${page}`,
      {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Tidy-release-counter" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error("Download counters unavailable.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No release metadata.");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const value = await reader.read();
        if (value.done) break;
        bytes += value.value.byteLength;
        if (bytes > 2_000_000) throw new Error("Release metadata too large.");
        chunks.push(value.value);
      }
    } finally {
      await reader.cancel();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    const rows = releases.parse(JSON.parse(new TextDecoder().decode(body)));
    for (const release of rows) {
      if (release.draft || !/^desktop-v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(release.tag_name))
        continue;
      for (const asset of release.assets) {
        const kind = /^Tidy-\d+\.\d+\.\d+(?:-beta\.\d+)?-mac-(arm64|x64)\.dmg$/.test(asset.name)
          ? "installer"
          : /^Tidy-\d+\.\d+\.\d+(?:-beta\.\d+)?-mac-(arm64|x64)\.zip$/.test(asset.name)
            ? "update"
            : null;
        if (kind)
          await db.query(
            `insert into "desktopDownloadSnapshot" (day,asset,release,kind,downloads) values ((clock_timestamp() at time zone 'UTC')::date,$1,$2,$3,$4) on conflict(day,asset) do nothing`,
            [asset.id, release.tag_name, kind, asset.download_count],
          );
      }
    }
    if (rows.length < 100) break;
  }
  await db.query(
    `insert into "productAnalyticsExport" (day,"downloadsAt") values ((clock_timestamp() at time zone 'UTC')::date,clock_timestamp()) on conflict(day) do update set "downloadsAt"=excluded."downloadsAt"`,
  );
}

/** Provider exports contain no installation/account IDs, raw events or error details. */
export async function exportProductAggregates() {
  if (analyticsSetting("DESKTOP_ANALYTICS_POSTHOG_AGGREGATES") !== "1") return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (
    !key ||
    !host ||
    new URL(host).hostname !== "eu.i.posthog.com" ||
    new URL(host).protocol !== "https:"
  )
    throw new Error("EU aggregate export is not configured.");
  const day = new Date().toISOString().slice(0, 10);
  if (
    (
      await db.query(
        'select 1 from "productAnalyticsExport" where day=$1 and "exportedAt" is not null',
        [day],
      )
    ).rowCount
  )
    return;
  const activity = (
    await db.query<{
      surface: string;
      name: string;
      harness: string | null;
      events: number;
      installations: number;
    }>(activityReport)
  ).rows;
  const retention = (
    await db.query<{
      day: string;
      surface: string;
      size: number;
      d1: number;
      d7: number;
      d30: number;
    }>(retentionReport)
  ).rows;
  retention.push(
    ...(
      await db.query<{
        day: string;
        surface: string;
        size: number;
        d1: number;
        d7: number;
        d30: number;
      }>(accountRetentionReport)
    ).rows,
  );
  const downloads = (
    await db.query<{ day: string; release: string; kind: string; cumulative: string }>(
      `select day::text,release,kind,sum(downloads)::text as cumulative from "desktopDownloadSnapshot" where day=(clock_timestamp() at time zone 'UTC')::date group by day,release,kind`,
    )
  ).rows;
  const client = new PostHog(key, {
    host,
    flushAt: 1000,
    flushInterval: 0,
    disableGeoip: true,
    fetchRetryCount: 0,
    requestTimeout: 2000,
    enableExceptionAutocapture: false,
  });
  let failed = false;
  client.on("error", () => {
    failed = true;
  });
  try {
    for (const row of activity) {
      // Suppress sparse product breakdowns. Private first-party reports retain exact counts.
      if (row.installations < 10) continue;
      const properties = {
        surface: row.surface,
        metric: row.name,
        harness: row.harness ?? "none",
        events: row.events,
        installations: row.installations,
        window_days: 90,
      };
      client.capture({
        distinctId: `product-aggregate:${day}`,
        event: "product_usage_aggregate",
        properties: {
          ...properties,
          $process_person_profile: false,
          $geoip_disable: true,
          $insert_id: createHash("sha256")
            .update(`${day}:${row.surface}:${row.name}:${row.harness ?? "none"}`)
            .digest("hex"),
        },
      });
    }
    for (const row of retention) {
      if (row.size < 10) continue;
      const age = Math.floor((Date.parse(day) - Date.parse(row.day)) / 86_400_000);
      const visible = (count: number, mature: number) =>
        age >= mature && (count === 0 || count >= 10) ? count : null;
      const properties = {
        surface: row.surface,
        cohort_day: row.day,
        cohort_size: row.size,
        d1: visible(row.d1, 1),
        d7: visible(row.d7, 7),
        d30: visible(row.d30, 30),
        $process_person_profile: false,
        $geoip_disable: true,
        $insert_id: `retention:${day}:${row.day}:${row.surface}`,
      };
      client.capture({
        distinctId: `product-aggregate:${day}`,
        event: "product_retention_aggregate",
        properties,
      });
    }
    for (const row of downloads)
      client.capture({
        distinctId: `release-aggregate:${day}`,
        event: "desktop_download_aggregate",
        properties: {
          snapshot_day: row.day,
          release: row.release,
          kind: row.kind,
          cumulative: Number(row.cumulative),
          includes_automation: true,
          $process_person_profile: false,
          $geoip_disable: true,
          $insert_id: `downloads:${day}:${row.release}:${row.kind}`,
        },
      });
    await client.flush();
    if (failed) throw new Error("Aggregate export needs retry.");
    await db.query(
      'insert into "productAnalyticsExport" (day,"exportedAt") values ($1,clock_timestamp()) on conflict(day) do update set "exportedAt"=excluded."exportedAt"',
      [day],
    );
  } finally {
    await client.shutdown(1000);
  }
}

export async function runProductAnalyticsMaintenance() {
  // Raw expiry runs independently through the existing privacy cleanup endpoint.
  // Finish the snapshot before exporting it; otherwise the daily marker could freeze partial counters.
  await snapshotDownloads();
  await exportProductAggregates();
}
