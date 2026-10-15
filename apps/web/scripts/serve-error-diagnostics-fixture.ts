// Local-only real SDK fixture. No credentials, database or external collector.
// Run with bun apps/web/scripts/serve-error-diagnostics-fixture.ts, then open the
// printed URL in a visible browser and use the diagnostics/activity buttons.
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(root, ".artifacts/error-diagnostics");
await Bun.write(
  `${directory}/entry.ts`,
  `
import posthog, {startPostHogConsent, appErrorReporter} from "../../lib/posthog-client";
import {chooseConsent, ESSENTIAL_ONLY} from "../../lib/privacy/consent";
const wait = () => new Promise(r => setTimeout(r, 700));
const events = () => fetch('/events').then(r => r.json());
const assert = (ok, message) => { if(!ok) throw new Error(message); };
startPostHogConsent();
window.runDiagnostics = async () => {
  chooseConsent(ESSENTIAL_ONLY); await wait();
  await fetch('/reset', {method:'POST'});
  posthog.captureException(new Error('Failed to fetch')); await wait();
  assert((await events()).length === 0, 'No collection before diagnostics consent');
  chooseConsent({analytics:false,replay:false,diagnostics:true}); await wait();
  try { const missing = undefined; missing['private-secret']; } catch(error) {posthog.captureException(error);}
  appErrorReporter('file_save')(new Error('private@example.test token=private-secret'));
  posthog.capture('$pageview');
  const extension = new Error('private-secret'); extension.stack='Error: private-secret\\n    at chrome-extension://private/content.js:12:3';
  posthog.captureException(extension);
  await wait();
  let sent=await events(), errors=sent.filter(e=>e.event==='$exception');
  assert(errors.length===2, 'Only app errors survive');
  assert(errors.some(e=>e.properties.$exception_list[0].value==='Cannot read a property of null or undefined'), 'Readable runtime diagnosis');
  assert(errors[0].properties.$exception_list[0].stacktrace.frames.length>0, 'Application stack preserved');
  assert(!JSON.stringify(sent).includes('private-secret'), 'Private values excluded');
  assert(!sent.some(e=>e.event==='$snapshot'||e.event==='$pageview'), 'Replay and analytics remain off');
  chooseConsent({analytics:false,replay:true,diagnostics:true}); await wait();
  window.replayReady=true;
  document.querySelector('#result').textContent='Click Generate activity to validate replay correlation';
  await new Promise(resolve => document.querySelector('#activity').addEventListener('click', resolve, {once:true}));
  appErrorReporter('file_save')(new Error('Failed to fetch')); await wait();
  // Allow the recorder batch to flush.
  await new Promise(r=>setTimeout(r,12000));
  sent=await events(); errors=sent.filter(e=>e.event==='$exception');
  const last=errors.at(-1), snapshots=sent.filter(e=>e.event==='$snapshot');
  assert(last.properties.$session_id, 'Error carries session correlation');
  assert(snapshots.some(e=>e.properties.$session_id===last.properties.$session_id), 'Error links to the consented replay session');
  chooseConsent({analytics:false,replay:true,diagnostics:false}); await wait();
  posthog.captureException(new Error('Failed to fetch')); await wait();
  assert((await events()).filter(e=>e.event==='$exception').length===errors.length, 'Replay alone never enables errors');
  chooseConsent(ESSENTIAL_ONLY); await wait();
  return {passed:true, exceptions:errors.length, snapshots:snapshots.length, linkedSession:true};
};
document.body.innerHTML='<p>Local diagnostics fixture</p><button id="run">Run diagnostics checks</button><button id="activity">Generate activity</button><pre id="result"></pre>';
document.querySelector('#run').onclick=()=>window.runDiagnostics().then(r=>document.querySelector('#result').textContent=JSON.stringify(r)).catch(e=>document.querySelector('#result').textContent=e.message);
`,
);
const build = await Bun.build({
  entrypoints: [`${directory}/entry.ts`],
  outdir: directory,
  target: "browser",
  sourcemap: "external",
  define: {
    "process.env.NEXT_PUBLIC_POSTHOG_ENABLED": '"1"',
    "process.env.NEXT_PUBLIC_POSTHOG_KEY": '"synthetic-project"',
    "process.env.NEXT_PUBLIC_POSTHOG_HOST": '"https://eu.i.posthog.com"',
    "process.env.NEXT_PUBLIC_APP_VERSION": '"local-diagnostics-check"',
    "process.env.NODE_ENV": '"production"',
  },
});
if (!build.success) throw new AggregateError(build.logs, "Fixture build failed");
const captured: unknown[] = [];
const receipt = {
  id: crypto.randomUUID(),
  browserId: crypto.randomUUID(),
  user: { id: "synthetic-account", email: "support@example.test" },
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3197,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/privacy/consent") return Response.json(receipt);
    if (url.pathname === "/reset" && request.method === "POST") {
      captured.length = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/events") return Response.json(captured);
    if (url.pathname.startsWith("/_next/static/chunks/"))
      return new Response(Bun.file(`${directory}/entry.js`), {
        headers: { "Content-Type": "application/javascript" },
      });
    if (url.pathname.includes("/config"))
      return Response.json({
        autocapture_opt_out: true,
        sessionRecording: {
          endpoint: "/s/",
          consoleLogRecordingEnabled: false,
          sampleRate: "1",
          minimumDurationMilliseconds: 0,
        },
        capturePerformance: false,
        supportedCompression: [],
      });
    if (url.pathname.startsWith("/api/t/")) {
      if (request.method === "POST") {
        const bytes = Buffer.from(await request.arrayBuffer());
        const body =
          bytes[0] === 0x1f && bytes[1] === 0x8b
            ? gunzipSync(bytes).toString()
            : url.searchParams.get("compression") === "base64"
              ? Buffer.from(
                  new URLSearchParams(bytes.toString()).get("data") ?? "",
                  "base64",
                ).toString()
              : bytes.toString();
        const data = JSON.parse(body);
        captured.push(...(Array.isArray(data) ? data : (data.batch ?? [data])));
      }
      return Response.json({ status: 1 });
    }
    return new Response(
      '<!doctype html><html><body><script type="module" src="/_next/static/chunks/entry.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
console.log(`Local diagnostics fixture: ${server.url}`);
