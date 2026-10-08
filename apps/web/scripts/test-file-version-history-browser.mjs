import assert from "node:assert/strict";
import { chromium } from "playwright";
import pg from "pg";
import sharp from "sharp";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";
const base = process.env.VERSION_TEST_BASE_URL ?? "http://localhost:3041";
const database = process.env.VERSION_TEST_DATABASE_URL;
if (
  !database ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !["localhost", "127.0.0.1"].includes(new URL(database).hostname) ||
  new URL(database).pathname !== "/tidy_versions_test"
)
  throw new Error("Version browser tests require the disposable localhost versions database.");
const client = new pg.Client({ connectionString: database });
await client.connect();
const browser = await chromium.launch({ headless: true }),
  contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ viewport: { width: 1500, height: 1050 } })),
  );
for (const context of contexts) {
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(60_000);
}
const errors = [],
  fixture = crypto.randomUUID(),
  fileId = `versions-browser-${fixture}`,
  organization = `org-${fileId}`;
const users = [],
  password = "local-version-test-password-123";
const api = (context, path, method = "GET", data) =>
  context.request.fetch(`${base}${path}`, {
    method,
    data,
    headers: method === "GET" ? {} : { Origin: base },
  });
const current = async () => {
  const response = await api(contexts[0], `/api/files/${fileId}/changes`);
  assert.equal(response.status(), 200);
  return (await response.json()).snapshot;
};
const history = async () => {
  const response = await api(contexts[0], `/api/files/${fileId}/history`);
  assert.equal(response.status(), 200);
  return response.json();
};
const patch = async (changes, context = contexts[1]) => {
  const snapshot = await current();
  const fields = changes.map(([id, path, value]) => {
    let before = snapshot.content.nodes.find((node) => node.id === id);
    for (const key of path) before = before?.[key];
    return {
      collection: "nodes",
      id,
      path,
      before: before === undefined ? { exists: false } : { exists: true, value: before },
      after: { exists: true, value },
    };
  });
  const response = await api(context, `/api/files/${fileId}/changes`, "POST", {
    operationId: crypto.randomUUID(),
    baseRevision: snapshot.revision,
    patch: fields,
  });
  assert.equal(response.status(), 200, await response.text());
};
const open = async (page) => {
  await page.getByRole("button", { name: "Version history", exact: true }).click();
  await page.getByRole("dialog", { name: "Version history", exact: true }).waitFor();
};
const close = (page) => page.getByRole("button", { name: "Close history", exact: true }).click();
const choose = async (page, name) => {
  await page.getByRole("button", { name: /^Version: / }).click();
  await page.getByRole("menuitemradio", { name: new RegExp(`^${name} ·`) }).click();
  await page.getByRole("button", { name: "Restore version", exact: true }).waitFor();
};
const checkpoint = async (page, name) => {
  await page.getByLabel("Version name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create version", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^Version: ${name} ·`) }).waitFor();
  await page.getByRole("button", { name: "Restore version", exact: true }).waitFor();
};
try {
  for (const [index, account] of [
    { name: "Version Echo", email: "echo@example.test" },
    { name: "Version Drift", email: "drift@example.test" },
    { name: "Outside", email: `version-outsider-${fixture}@example.invalid` },
  ].entries()) {
    const id = await verifiedTestAccount(client, { ...account, password });
    users.push(id);
    const response = await api(contexts[index], "/api/auth/sign-in/email", "POST", {
      email: account.email,
      password,
    });
    assert.equal(response.status(), 200, await response.text());
  }
  await client.query(
    'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,\'Version fixture\',$1,now(),$2)',
    [organization, users[0]],
  );
  await client.query(
    'insert into "billingPlanPrice" ("priceId") values (\'price_multiplayer_fixture\') on conflict do nothing',
  );
  await client.query(
    'insert into "organization_billing" ("organizationId","stripeStatus","stripePriceId") values ($1,\'active\',\'price_multiplayer_fixture\')',
    [organization],
  );
  for (const user of users.slice(0, 2))
    await client.query(
      'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,\'owner\',now())',
      [`member-${user}`, organization, user],
    );
  await client.query(
    'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'History fixture\',$3)',
    [fileId, organization, users[0]],
  );
  const originals = await Promise.all(
    ["#3388bb", "#ee8844"].map((background) =>
      sharp({ create: { width: 400, height: 200, channels: 4, background } })
        .png()
        .toBuffer(),
    ),
  );
  const assets = [];
  for (const [index, buffer] of originals.entries()) {
    const response = await contexts[0].request.post(`${base}/api/files/${fileId}/assets`, {
      headers: { Origin: base },
      multipart: { image: { name: `version-${index}.png`, mimeType: "image/png", buffer } },
    });
    assert.equal(response.status(), 200);
    assets.push((await response.json()).assetId);
  }
  const crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8, sourceWidth: 400, sourceHeight: 200 };
  const node = (id, type, parentId, box, extra = {}) => ({
    id,
    type,
    parentId,
    name: id,
    box,
    style: {},
    visible: true,
    locked: false,
    layout: "absolute",
    positionMode: "absolute",
    ...extra,
  });
  const content = {
    schemaVersion: 1,
    legacyConverted: true,
    pages: [
      { id: "page-1", name: "Main" },
      { id: "page-two", name: "Other page" },
    ],
    tokens: {},
    warnings: [],
    editedNodeIds: [],
    deletedSourceKeys: [],
    nodes: [
      node(
        "frame",
        "artboard",
        null,
        { x: 50, y: 50, width: 500, height: 360 },
        { name: "Main frame", style: { fill: "#ffffff" } },
      ),
      node(
        "text",
        "text",
        "frame",
        { x: 30, y: 30, width: 300, height: 60 },
        {
          text: "Original document",
          style: { fontFamily: "monospace", fontSize: 24, color: "#111111" },
        },
      ),
      node(
        "image",
        "image",
        "frame",
        { x: 30, y: 130, width: 180, height: 100 },
        { assetId: assets[0], style: { imageCrop: crop, objectFit: "cover" } },
      ),
      node(
        "panel",
        "container",
        "frame",
        { x: 280, y: 130, width: 160, height: 100 },
        {
          style: {
            radius: 8,
            paints: [
              {
                id: "paint",
                type: "image",
                assetId: assets[0],
                crop,
                fit: "cover",
                visible: true,
                opacity: 1,
              },
            ],
          },
        },
      ),
      node(
        "other-frame",
        "artboard",
        null,
        { x: 700, y: 50, width: 320, height: 180 },
        { pageId: "page-two", name: "Other page frame", style: { fill: "#eeeeee" } },
      ),
    ],
  };
  await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
    fileId,
    JSON.stringify(content),
  ]);
  const [a, b] = await Promise.all(contexts.slice(0, 2).map((context) => context.newPage()));
  for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
  await Promise.all([a.goto(`${base}/files/${fileId}`), b.goto(`${base}/files/${fileId}`)]);
  await a.locator('[data-node-id="text"]').filter({ hasText: "Original document" }).waitFor();
  await open(a);
  await checkpoint(a, "Initial design");
  const initial = (await history()).versions.find((version) => version.name === "Initial design");
  assert.ok(initial);
  await close(a);
  await patch([
    ["text", ["text"], "Later document"],
    ["text", ["style", "fontFamily"], "Tidy Missing Font 41"],
    ["text", ["style", "fontSource"], "local"],
    ["image", ["assetId"], assets[1]],
    [
      "panel",
      ["style", "paints"],
      [
        {
          id: "paint",
          type: "image",
          assetId: assets[1],
          crop,
          fit: "cover",
          visible: true,
          opacity: 1,
        },
      ],
    ],
  ]);
  await Promise.all(
    [a, b].map((page) =>
      page.locator('[data-node-id="text"]').filter({ hasText: "Later document" }).waitFor(),
    ),
  );
  await open(a);
  await checkpoint(a, "Later design");
  await a
    .getByRole("dialog", { name: "Version history", exact: true })
    .getByText(/Unavailable fonts/)
    .waitFor();
  const later = (await history()).versions.find((version) => version.name === "Later design");
  assert.ok(later);
  const oldAsset = await api(
    contexts[1],
    `/api/files/${fileId}/history/${initial.id}/assets/${assets[0]}`,
  );
  assert.equal(oldAsset.status(), 200);
  assert.deepEqual(await oldAsset.body(), originals[0]);
  await expectDeletionBlocked();
  await choose(a, "Initial design");
  await a
    .getByLabel("Version preview", { exact: true })
    .getByText("Original document", { exact: true })
    .waitFor();
  await a.getByRole("button", { name: /^Version frame: / }).click();
  await a.getByRole("menuitemradio", { name: "Other page frame", exact: true }).click();
  await a.getByRole("button", { name: /^Version frame: Other page frame/ }).waitFor();
  await a.getByRole("button", { name: /^Version frame: / }).click();
  await a.getByRole("menuitemradio", { name: "Main frame", exact: true }).click();
  await patch([["text", ["text"], "Concurrent change"]]);
  await b.locator('[data-node-id="text"]').filter({ hasText: "Concurrent change" }).waitFor();
  await a.getByRole("button", { name: "Restore version", exact: true }).click();
  await a.getByRole("alert").filter({ hasText: "The file changed" }).waitFor();
  assert.equal(
    (await current()).content.nodes.find((node) => node.id === "text").text,
    "Concurrent change",
  );
  assert.equal(
    (
      await client.query(
        'select count(*)::int as count from "designFileRestore" where "fileId"=$1',
        [fileId],
      )
    ).rows[0].count,
    0,
  );
  await close(a);
  await open(a);
  await a.getByText(/Current r3/, { exact: false }).waitFor();
  await a.getByRole("button", { name: "Restore version", exact: true }).click();
  await a
    .getByRole("dialog", { name: "Version history", exact: true })
    .waitFor({ state: "hidden" });
  await Promise.all(
    [a, b].map((page) =>
      page.locator('[data-node-id="text"]').filter({ hasText: "Original document" }).waitFor(),
    ),
  );
  const restored = await current();
  assert.equal(restored.content.nodes.find((node) => node.id === "image").assetId, assets[0]);
  assert.equal(
    restored.content.nodes.find((node) => node.id === "text").style.fontFamily,
    "monospace",
  );
  const audit = (
    await client.query(
      'select * from "designFileRestore" where "fileId"=$1 order by "createdAt" desc',
      [fileId],
    )
  ).rows[0];
  assert.equal(audit.createdBy, users[0]);
  assert.equal(audit.restoredVersionId, initial.id);
  const checkpointBefore = (await history()).versions.find(
    (version) => version.id === audit.beforeVersionId,
  );
  assert.ok(checkpointBefore?.name.startsWith("Before restoring"));
  console.log(
    "PASS: named/history ordering, pinned assets/fonts, cross-page preview, stale-revision denial and live restoration in both sessions",
  );
  await patch([["panel", ["style", "radius"], 20]]);
  await a.waitForFunction(
    () => document.querySelector('[data-node-id="panel"]')?.style.borderRadius === "20px",
  );
  await a.getByLabel("Design canvas", { exact: true }).focus();
  await a.keyboard.press("Control+z");
  await Promise.all(
    [a, b].map((page) =>
      page.locator('[data-node-id="text"]').filter({ hasText: "Concurrent change" }).waitFor(),
    ),
  );
  assert.equal(
    (await current()).content.nodes.find((node) => node.id === "panel").style.radius,
    20,
  );
  await Promise.all([a.reload(), b.reload()]);
  await open(b);
  await choose(b, checkpointBefore.name);
  await b
    .getByLabel("Version preview", { exact: true })
    .getByText("Concurrent change", { exact: true })
    .waitFor();
  await b.getByRole("button", { name: "Restore version", exact: true }).click();
  await b
    .getByRole("dialog", { name: "Version history", exact: true })
    .waitFor({ state: "hidden" });
  await a.waitForFunction(
    () => document.querySelector('[data-node-id="panel"]')?.style.borderRadius === "8px",
  );
  const after = await current();
  assert.equal(after.content.nodes.find((node) => node.id === "text").text, "Concurrent change");
  assert.equal(after.content.nodes.find((node) => node.id === "image").assetId, assets[1]);
  const last = (
    await client.query(
      'select * from "designFileRestore" where "fileId"=$1 order by "createdAt" desc',
      [fileId],
    )
  ).rows[0];
  const before = await api(contexts[1], `/api/files/${fileId}/history/${last.beforeVersionId}`);
  const priorRevision = (await before.json()).version.revision;
  const replay = await api(
    contexts[1],
    `/api/files/${fileId}/history/${last.restoredVersionId}/restore`,
    "POST",
    { operationId: last.operationId, expectedRevision: priorRevision },
  );
  assert.equal(replay.status(), 200);
  assert.equal(
    (
      await client.query(
        'select count(*)::int as count from "designFileRestore" where "fileId"=$1',
        [fileId],
      )
    ).rows[0].count,
    2,
  );
  console.log(
    "PASS: one-step undo preserves an independent collaborator edit; pre-restore versions reverse changes after both browsers reopen; retries are idempotent",
  );
  const anonymous = await browser.newContext();
  assert.equal((await api(anonymous, `/api/files/${fileId}/history`)).status(), 401);
  assert.equal(
    (
      await api(anonymous, `/api/files/${fileId}/history/${initial.id}/assets/${assets[0]}`)
    ).status(),
    401,
  );
  await anonymous.close();
  for (const path of [
    `/api/files/${fileId}/history`,
    `/api/files/${fileId}/history/${initial.id}`,
    `/api/files/${fileId}/history/${initial.id}/assets/${assets[0]}`,
  ])
    assert.equal((await api(contexts[2], path)).status(), 404);
  await client.query(
    'update "member" set "role"=\'viewer\' where "organizationId"=$1 and "userId"=$2',
    [organization, users[1]],
  );
  assert.equal((await api(contexts[1], `/api/files/${fileId}/history`)).status(), 200);
  assert.equal(
    (
      await api(contexts[1], `/api/files/${fileId}/history`, "POST", {
        id: crypto.randomUUID(),
        name: "Denied",
        expectedRevision: after.revision,
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await api(contexts[1], `/api/files/${fileId}/history/${initial.id}/restore`, "POST", {
        operationId: crypto.randomUUID(),
        expectedRevision: after.revision,
      })
    ).status(),
    403,
  );
  await b.reload();
  await open(b);
  assert.equal(await b.getByLabel("Version name", { exact: true }).count(), 0);
  assert.equal(await b.getByRole("button", { name: "Restore version", exact: true }).count(), 0);
  assert.equal(
    (
      await contexts[0].request.post(`${base}/api/files/${fileId}/history`, {
        headers: { Origin: "https://untrusted.example" },
        data: {},
      })
    ).status(),
    403,
  );
  assert.equal(
    (await api(contexts[0], `/api/files/${fileId}/history?before=invalid`)).status(),
    400,
  );
  assert.equal(
    (await api(contexts[0], `/api/files/${fileId}/history?before=9223372036854775808`)).status(),
    400,
  );
  assert.equal(
    (
      await api(contexts[0], `/api/files/${fileId}/history`, "POST", { name: "x".repeat(5000) })
    ).status(),
    413,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: private history/assets, viewer-only preview, untrusted-origin/body/cursor rejection and no browser runtime errors",
  );
  async function expectDeletionBlocked() {
    await assert.rejects(client.query('delete from "designAsset" where "id"=$1', [assets[0]]));
  }
} catch (error) {
  console.error("Browser errors:", errors);
  throw error;
} finally {
  await browser.close();
  await client.query('delete from "organization" where "id"=$1', [organization]);
  for (const user of users) await client.query('delete from "user" where "id"=$1', [user]);
  await client.end();
}
