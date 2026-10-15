import { PublicBudgetError } from "./security/public-budget";

type HealthCache = Pick<Cache, "match" | "put">;
const headers = { "Cache-Control": "no-store" };

/** Only anonymous readiness status is cached; no cookies, query parameters or
 * client headers enter the key. Cache failure never bypasses query admission. */
export async function healthResponse(
  key: Request,
  check: () => Promise<void>,
  reserve: () => Promise<void>,
  cache?: HealthCache,
) {
  try {
    const hit = await cache?.match(key).catch(() => undefined);
    if (hit)
      return new Response(hit.body, {
        status: hit.headers.get("X-Tidy-Health-Status") === "503" ? 503 : 200,
        headers,
      });
    await reserve();
    let healthy = false;
    try {
      await check();
      healthy = true;
    } catch {
      console.error(JSON.stringify({ event: "database_health_failed" }));
    }
    const result = { status: healthy ? "ok" : "unavailable" };
    const status = healthy ? 200 : 503;
    // A 200 envelope gives healthy and unhealthy results the same explicit
    // cache policy. Its internal status header never reaches the caller.
    await cache
      ?.put(
        key,
        Response.json(result, {
          headers: { "Cache-Control": "public, max-age=5", "X-Tidy-Health-Status": String(status) },
        }),
      )
      .catch(() => {});
    return Response.json(result, { status, headers });
  } catch (error) {
    return Response.json(
      { status: "unavailable" },
      {
        status: error instanceof PublicBudgetError ? 429 : 503,
        headers: {
          ...headers,
          "Retry-After": String(error instanceof PublicBudgetError ? error.retryAfter : 5),
        },
      },
    );
  }
}
