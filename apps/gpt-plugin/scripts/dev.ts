import { buildPlugin } from "./build";

await buildPlugin();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.GPT_PLUGIN_PORT ?? 3102),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/widget")
      return new Response(await buildPlugin(), { headers: { "Content-Type": "text/html" } });
    if (path === "/")
      return new Response(await Bun.file(new URL("../dev/host.html", import.meta.url)).text(), {
        headers: { "Content-Type": "text/html" },
      });
    if (path === "/fixture") return Response.json((await import("../dev/fixture")).fixture);
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Plugin preview: ${server.url}`);
