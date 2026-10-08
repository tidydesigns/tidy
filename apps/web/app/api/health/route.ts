import { checkDatabaseHealth } from "@/lib/database-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await checkDatabaseHealth();
    return Response.json({ status: "ok" }, { headers });
  } catch {
    console.error(JSON.stringify({ event: "database_health_failed" }));
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}
