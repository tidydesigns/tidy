// Read-only smoke probe; no cookies, sign-ins, mutations, or load generation.
// node apps/web/scripts/check-runtime.mjs https://app.tidydesign.co
const origin = new URL(process.argv[2] ?? "http://127.0.0.1:8787");
if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password)
  throw new Error("Provide an HTTP(S) origin without credentials.");
const checks = [
  { path: "/login", status: 200 },
  { path: "/api/auth/get-session", status: 200, json: null },
  { path: "/api/auth/get-session?diagnostic=runtime", status: 200, json: null },
  { path: "/api/health", status: 200, json: { status: "ok" } },
];
let failures = 0;
for (let round = 1; round <= 3; round++) {
  for (const check of checks) {
    const start = performance.now();
    try {
      const response = await fetch(new URL(check.path, origin), {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      const elapsedMs = Math.round(performance.now() - start);
      const validBody =
        !("json" in check) || JSON.stringify(JSON.parse(body)) === JSON.stringify(check.json);
      const ok = response.status === check.status && validBody && elapsedMs < 2000;
      if (!ok) failures++;
      console.log(
        JSON.stringify({
          round,
          path: check.path,
          status: response.status,
          elapsedMs,
          ok,
          ray: response.headers.get("cf-ray"),
        }),
      );
    } catch (error) {
      failures++;
      console.log(
        JSON.stringify({
          round,
          path: check.path,
          elapsedMs: Math.round(performance.now() - start),
          ok: false,
          error: error.name,
        }),
      );
    }
  }
}
process.exitCode = failures ? 1 : 0;
