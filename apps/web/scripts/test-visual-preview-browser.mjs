import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import pg from "pg";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";

const base = process.env.VISUAL_PREVIEW_TEST_BASE_URL;
const database = process.env.MULTIPLAYER_TEST_DATABASE_URL;
const output = process.env.VISUAL_PREVIEW_TEST_ARTIFACT_DIR;
if (
  !base ||
  !database ||
  !output ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !["localhost", "127.0.0.1"].includes(new URL(database).hostname)
)
  throw new Error("Use the disposable localhost acceptance runner.");
const web = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const client = new pg.Client({ connectionString: database });
await client.connect();
const browser = await chromium.launch({ headless: true });
try {
  const userId = await verifiedTestAccount(client, {
    name: "Visual export tester",
    email: "echo@example.test",
    password: "local-only-visual-test",
  });
  const outsider = await verifiedTestAccount(client, {
    name: "Outside",
    email: "outside-visual@example.test",
    password: "local-only-visual-test",
  });
  const organization = `visual-${crypto.randomUUID()}`,
    fileId = crypto.randomUUID(),
    assetId = crypto.randomUUID();
  const clientId = `client-${crypto.randomUUID()}`;
  await client.query(
    `insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,'Visual review',$1,now(),$2)`,
    [organization, userId],
  );
  await client.query(
    `insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,'owner',now())`,
    [crypto.randomUUID(), organization, userId],
  );
  await client.query(
    `insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,'Checkout',$3)`,
    [fileId, organization, userId],
  );
  const image = await sharp({
    create: { width: 80, height: 80, channels: 4, background: "#4c88bb" },
  })
    .png()
    .toBuffer();
  await client.query(
    `insert into "designAsset" ("id","organizationId","mimeType","body","sha256","byteSize") values ($1,$2,'image/png',$3,$4,$5)`,
    [assetId, organization, image, "0".repeat(64), image.length],
  );
  const node = (id, parentId, type, box, extra = {}) => ({
    id,
    parentId,
    type,
    name: id,
    box,
    layout: "absolute",
    style: {},
    visible: true,
    locked: false,
    ...extra,
  });
  const content = {
    schemaVersion: 1,
    legacyConverted: true,
    pages: [{ id: "page-1", name: "Checkout" }],
    tokens: {},
    warnings: [],
    editedNodeIds: [],
    deletedSourceKeys: [],
    nodes: [
      node(
        "screen",
        null,
        "artboard",
        { x: 80, y: 100, width: 640, height: 320 },
        { widthMode: "fixed", heightMode: "fixed", style: { fill: "#f3f1ef" } },
      ),
      node(
        "heading",
        "screen",
        "text",
        { x: 24, y: 20, width: 580, height: 52 },
        {
          text: "Review your checkout",
          widthMode: "fixed",
          heightMode: "fixed",
          style: {
            fontFamily: "Instrument Sans",
            fontSource: "web",
            fontWeight: 400,
            fontSize: 32,
            lineHeight: 1.2,
            color: "#282a28",
          },
        },
      ),
      node(
        "reference",
        "screen",
        "image",
        { x: 24, y: 92, width: 80, height: 80 },
        { assetId, widthMode: "fixed", heightMode: "fixed", style: { objectFit: "contain" } },
      ),
      node(
        "button",
        "screen",
        "container",
        { x: 24, y: 220, width: 180, height: 44 },
        {
          isComponent: true,
          widthMode: "fixed",
          heightMode: "fixed",
          layout: "flex-row",
          align: "center",
          justify: "center",
          semantics: { element: "button", buttonType: "submit" },
          style: { fill: "#282a28", radius: 8 },
          states: {
            hover: { fill: "#324c3e" },
            pressed: { fill: "#293e33" },
            focus: { outlineColor: "#90b7a1", outlineWidth: 2 },
            disabled: { opacity: 0.5 },
          },
          variants: {
            default: "primary",
            options: {
              primary: {},
              secondary: {
                root: { style: { fill: "#eeeeec", borderColor: "#c8cbc8", borderWidth: 1 } },
                children: { label: { text: "Continue instead", style: { color: "#282a28" } } },
              },
            },
          },
        },
      ),
      node(
        "label",
        "button",
        "text",
        { x: 0, y: 0, width: 1, height: 1 },
        {
          text: "Pay now",
          widthMode: "hug",
          heightMode: "hug",
          positionMode: "auto",
          style: {
            fontFamily: "Instrument Sans",
            fontSource: "web",
            fontSize: 14,
            lineHeight: 1.4,
            color: "#ffffff",
          },
        },
      ),
    ],
  };
  await client.query(`insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)`, [
    fileId,
    JSON.stringify(content),
  ]);
  await client.query(
    `insert into "oauthClient" ("id","clientId","name","redirectUris","tokenEndpointAuthMethod","userId") values ($1,$1,'Local visual export','[]','none',$2)`,
    [clientId, userId],
  );
  await client.query(
    `insert into "oauthResource" ("id","identifier","name","allowedScopes") values ($1,$2,'Local visual export','["mcp:read","mcp:write"]') on conflict ("identifier") do update set "allowedScopes"=excluded."allowedScopes"`,
    [crypto.randomUUID(), `${base}/api/mcp`],
  );
  await client.query(
    `insert into "oauthClientResource" ("id","clientId","resourceId") values ($1,$2,$3)`,
    [crypto.randomUUID(), clientId, `${base}/api/mcp`],
  );
  const sessions = new Map();
  for (const subject of [userId, outsider]) {
    const sid = crypto.randomUUID();
    sessions.set(subject, sid);
    await client.query(
      `insert into "session" ("id","token","userId","expiresAt","updatedAt") values ($1,$2,$3,now()+interval '1 hour',now())`,
      [sid, crypto.randomUUID(), subject],
    );
  }
  for (const id of [userId, outsider])
    await client.query(
      `insert into "oauthConsent" ("id","clientId","userId","resources","scopes","createdAt","updatedAt") values ($1,$2,$3,$4::jsonb,'["mcp:read","mcp:write"]',now(),now())`,
      [crypto.randomUUID(), clientId, id, JSON.stringify([`${base}/api/mcp`])],
    );
  const token = (subject, scope) =>
    JSON.parse(
      execFileSync(
        "bun",
        [
          "--conditions",
          "react-server",
          "-e",
          `const {auth}=await import('./lib/auth');const ctx=await auth.$context;const signed=await auth.api.signJWT({body:{payload:{sub:${JSON.stringify(subject)},sid:${JSON.stringify(sessions.get(subject))},client_id:${JSON.stringify(clientId)},scope:${JSON.stringify(scope)},aud:${JSON.stringify(`${base}/api/mcp`)},iss:ctx.baseURL,bella_grant_version:'0',exp:Math.floor(Date.now()/1000)+1800}}});console.log(JSON.stringify(signed));process.exit(0);`,
        ],
        {
          cwd: web,
          env: { ...process.env, DATABASE_URL: database, BETTER_AUTH_URL: base },
          encoding: "utf8",
        },
      ),
    ).token;
  const readToken = token(userId, "mcp:read"),
    writeToken = token(userId, "mcp:read mcp:write"),
    outsideToken = token(outsider, "mcp:read");
  let requestId = 0;
  const call = async (name, args, credential = readToken) => {
    const response = await fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, `MCP status ${response.status}: ${body.slice(0, 300)}`);
    const event = body.split("\n").find((line) => line.startsWith("data: "));
    const message = JSON.parse(event ? event.slice(6) : body);
    assert.ok(message.result, JSON.stringify(message).slice(0, 300));
    return message.result;
  };
  const args = {
    file_id: fileId,
    selections: [
      { node_id: "screen", label: "Checkout" },
      { node_id: "button", label: "Payment button" },
      { node_id: "reference", label: "Inspiration" },
    ],
  };
  const result = await call("export_visual_preview", args);
  assert.equal(result.isError, undefined, result.content[0].text.slice(0, 500));
  const artifact = result.structuredContent;
  assert.ok(artifact.byteSize < 512000);
  assert.deepEqual(artifact.warnings, []);
  assert.ok(artifact.html.includes("data:image/png;base64,"));
  assert.ok(artifact.html.includes("data:font/"));
  await writeFile(join(output, "preview.html"), artifact.html);
  const context = await browser.newContext({ viewport: { width: 728, height: 800 } });
  assert.deepEqual(await context.cookies(), []);
  await context.setOffline(true);
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setContent(artifact.html);
  await page.locator("[data-tidy-design] > *").waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() =>
      document.fonts.check('32px "Instrument Sans"', "Review your checkout"),
    ),
    true,
  );
  assert.equal(
    await page
      .locator('img[alt="reference"]')
      .evaluate((image) => image.complete && image.naturalWidth === 80),
    true,
  );
  const pixels = await page.locator("[data-tidy-design] > *").screenshot();
  await writeFile(join(output, "export-pixels.png"), pixels);
  // Independently mount the source document in the same shared renderer, outside the exported UI.
  const sourceEntry = join(output, "source-renderer.js"),
    sourceBundle = join(output, "source-renderer.bundle.js");
  const assets = { [assetId]: `data:image/png;base64,${image.toString("base64")}` };
  await writeFile(
    sourceEntry,
    `import {createElement} from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {TidyDesign} from ${JSON.stringify(join(root, "packages/design-renderer/design.tsx"))};createRoot(document.getElementById('source')).render(createElement(TidyDesign,{document:${JSON.stringify(content)},rootId:'screen',assets:${JSON.stringify(assets)},frameWidth:640,state:'default'}));`,
  );
  execFileSync(
    "bun",
    [
      "-e",
      `const result=await Bun.build({entrypoints:[${JSON.stringify(sourceEntry)}],target:'browser',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});if(!result.success)throw new Error(result.logs.join('; '));await Bun.write(${JSON.stringify(sourceBundle)},await result.outputs[0].text());`,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const baseline = await context.newPage();
  baseline.on("pageerror", (error) => console.error(`Source renderer fixture: ${error.message}`));
  const style = artifact.html.match(/<style>([\s\S]*?)<\/style>/)[1];
  await baseline.setContent(
    `<!doctype html><html><head><style>${style}</style></head><body><div id="source" data-tidy-design style="width:640px"></div><script>${(await readFile(sourceBundle, "utf8")).replace(/<\/script/gi, "<\\/script")}</script></body></html>`,
  );
  await baseline.locator("#source > *").waitFor();
  await baseline.evaluate(() => document.fonts.ready);
  const expectedPixels = await baseline.locator("#source > *").screenshot();
  const actualRaw = await sharp(pixels).raw().toBuffer(),
    expectedRaw = await sharp(expectedPixels).raw().toBuffer();
  assert.deepEqual(
    actualRaw,
    expectedRaw,
    "Exported frame pixels differ from the source renderer.",
  );
  await page.getByRole("button", { name: "Payment button", exact: true }).click();
  await page.getByRole("button", { name: "secondary", exact: true }).click();
  await page.getByText("Continue instead", { exact: true }).waitFor();
  await page.getByRole("button", { name: "hover", exact: true }).click();
  assert.equal(
    await page
      .locator("[data-tidy-design] > *")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(50, 76, 62)",
  );
  await page.getByRole("button", { name: "disabled", exact: true }).click();
  assert.equal(await page.locator("[data-tidy-design] > button").isDisabled(), true);
  await page.getByRole("button", { name: "Inspiration", exact: true }).click();
  assert.equal(
    await page
      .locator('img[alt="reference"]')
      .evaluate((node) => node.complete && node.naturalWidth > 0),
    true,
  );
  await page.getByRole("button", { name: "Checkout", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= 390);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  const unchanged = (
    await client.query('select "revision","content" from "designDocument" where "fileId"=$1', [
      fileId,
    ])
  ).rows[0];
  assert.equal(unchanged.revision, artifact.revision);
  assert.equal(unchanged.content.nodes[3].variant, undefined);
  const patch = await call(
    "patch_document",
    {
      file_id: fileId,
      node_id: "heading",
      expected_revision: artifact.revision,
      changes: { text: "Checkout updated" },
    },
    writeToken,
  );
  assert.equal(patch.isError, undefined, patch.content[0].text);
  const fresh = await call("export_visual_preview", args);
  assert.equal(fresh.structuredContent.revision, artifact.revision + 1);
  assert.ok(fresh.structuredContent.html.includes("Checkout updated"));
  assert.equal((await call("export_visual_preview", args, outsideToken)).isError, true);
  // Preserve version-history pins while simulating an unavailable stored image.
  await client.query('update "designAsset" set "body"=null,"objectKey"=$2 where "id"=$1', [
    assetId,
    `missing-preview/${assetId}`,
  ]);
  const missing = await call("export_visual_preview", args);
  assert.ok(
    missing.structuredContent.warnings.some((warning) =>
      warning.includes("missing or inaccessible"),
    ),
  );
  await client.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
    organization,
    userId,
  ]);
  assert.equal((await call("export_visual_preview", args)).isError, true);
  console.log(
    "PASS: read-only Bearer export without cookies, embedded images/fonts, exact source pixel parity, variants/states/views, narrow layout, revision refresh, missing assets, denied/revoked access",
  );
} finally {
  await browser.close();
  await client.end();
}
