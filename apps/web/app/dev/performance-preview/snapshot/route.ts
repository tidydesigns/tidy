import { performanceDocument } from "@/lib/design/examples/performance";
export async function GET() {
  if (process.env.NODE_ENV !== "development") return new Response(null, { status: 404 });
  return Response.json({
    document: { content: performanceDocument(100), revision: 1 },
    frames: [],
    rectangles: [],
    updatedAt: "2026-10-03T12:00:00.000Z",
  });
}
