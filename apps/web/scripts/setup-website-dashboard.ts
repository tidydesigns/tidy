import { websiteDashboard } from "../lib/analytics/website-dashboard";
type Dashboard = {
  id: number;
  name?: string;
  deleted?: boolean;
  tiles?: { insight?: { name?: string }; error?: unknown }[];
};

// Preview is the default. Applying requires an explicit project and API origin;
// no production target is inferred from repository examples or local env files.
const args = process.argv.slice(2);
if (!args.includes("--apply")) {
  process.stdout.write(JSON.stringify(websiteDashboard, null, 2) + "\n");
} else {
  const project = args.find((arg) => arg.startsWith("--project="))?.slice(10);
  const host = args.find((arg) => arg.startsWith("--host="))?.slice(7);
  const key = process.env.POSTHOG_API_KEY;
  if (!project || !/^\d+$/.test(project) || !host || !key)
    throw new Error(
      "Provide --project=<id>, --host=https://eu.posthog.com (or US), and POSTHOG_API_KEY.",
    );
  const origin = new URL(host);
  if (
    !["https://eu.posthog.com", "https://us.posthog.com"].includes(origin.href.replace(/\/$/, ""))
  )
    throw new Error("Use an official PostHog Cloud API origin.");
  const base = `${origin.origin}/api/projects/${project}/`;
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `PostHog request failed (${response.status}); rerun to resume missing tiles.`,
      );
    return (await response.json()) as T;
  }
  const listed = await api<{ results: Dashboard[]; next?: string | null }>(
    `dashboards/?search=${encodeURIComponent(websiteDashboard.name)}&limit=100`,
  );
  const candidates = listed.results.filter(
    (item) => item.name === websiteDashboard.name && !item.deleted,
  );
  if (candidates.length > 1 || listed.next)
    throw new Error("Dashboard search is ambiguous; review existing dashboards before applying.");
  if (candidates[0] && (!Number.isSafeInteger(candidates[0].id) || candidates[0].id < 1))
    throw new Error("Invalid dashboard response.");
  const dashboard = candidates[0]
    ? await api<Dashboard>(`dashboards/${candidates[0].id}/`)
    : await api<Dashboard>("dashboards/", {
        name: websiteDashboard.name,
        description: websiteDashboard.description,
        tags: ["website"],
      });
  if (!Number.isSafeInteger(dashboard.id) || dashboard.id < 1)
    throw new Error("Invalid dashboard response.");
  if ((dashboard.tiles ?? []).some((tile) => tile.error && !tile.insight))
    throw new Error(
      "A dashboard tile failed to serialize; resolve its error in PostHog before adding insights.",
    );
  const present = new Set(
    (dashboard.tiles ?? []).map((tile: { insight?: { name?: string } }) => tile.insight?.name),
  );
  for (const insight of websiteDashboard.insights) {
    if (present.has(insight.name)) continue;
    await api("insights/", {
      ...insight,
      saved: true,
      dashboards: [dashboard.id],
      tags: ["website"],
    });
    process.stdout.write(`Added: ${insight.name}\n`);
  }
  process.stdout.write(`${origin.origin}/project/${project}/dashboard/${dashboard.id}\n`);
}
