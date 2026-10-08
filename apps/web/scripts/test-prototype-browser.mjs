import assert from "node:assert/strict";
import { chromium } from "playwright";
import pg from "pg";
import sharp from "sharp";
import { verifiedTestAccount } from "./fixtures/verified-test-account.mjs";

const base = process.env.PROTOTYPE_TEST_BASE_URL ?? "http://localhost:3042";
const database = process.env.PROTOTYPE_TEST_DATABASE_URL;
if (
  !database ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname) ||
  !["localhost", "127.0.0.1"].includes(new URL(database).hostname) ||
  new URL(database).pathname !== "/tidy_prototypes_test"
)
  throw new Error("Prototype acceptance requires its disposable localhost database.");
const client = new pg.Client({ connectionString: database });
await client.connect();
const browser = await chromium.launch({ headless: true });
const contexts = await Promise.all(
  [0, 1, 2].map(() =>
    browser.newContext({
      viewport: { width: 1400, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
    }),
  ),
);
for (const context of contexts) {
  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(60000);
}
const fixture = crypto.randomUUID(),
  file = `prototype-${fixture}`,
  org = `org-${file}`,
  users = [],
  errors = [];
const api = (context, path, method = "GET", data) =>
  context.request.fetch(`${base}${path}`, {
    method,
    data,
    headers: method === "GET" ? {} : { Origin: base },
  });
const snapshot = async () => {
  const response = await api(contexts[0], `/api/files/${file}/changes`);
  assert.equal(response.status(), 200);
  return (await response.json()).snapshot;
};
const waitFor = async (condition) => {
  const deadline = Date.now() + 20000;
  for (;;) {
    const current = await snapshot();
    if (condition(current)) return current;
    if (Date.now() > deadline)
      throw new Error("The expected prototype document change did not persist.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const choice = async (page, label, value) => {
  await page.getByRole("button", { name: new RegExp(`^${label}: `) }).click();
  await page.getByRole("menuitemradio", { name: value, exact: true }).click();
};
const openPanels = async (page) => {
  await page.getByRole("button", { name: /^(Expand|Minimize) editor panels$/ }).waitFor();
  const expand = page.getByRole("button", { name: "Expand editor panels", exact: true });
  if (await expand.count()) await expand.click();
};
const interaction = (
  action,
  trigger = { type: "click" },
  transition = { type: "instant", duration: 0 },
) => ({ id: crypto.randomUUID(), action, trigger, transition });
const node = (id, type, parentId, name, x, y, width, height, extra = {}) => ({
  id,
  type,
  parentId,
  name,
  box: { x, y, width, height },
  style: {},
  visible: true,
  locked: false,
  layout: "absolute",
  ...extra,
});
try {
  for (const [index, account] of [
    { name: "Prototype Echo", email: "echo@example.test" },
    { name: "Prototype Viewer", email: "drift@example.test" },
    { name: "Outside", email: `prototype-${fixture}@example.invalid` },
  ].entries()) {
    const user = await verifiedTestAccount(client, {
      ...account,
      password: "local-prototype-test-password-123",
    });
    users.push(user);
    const response = await api(contexts[index], "/api/auth/sign-in/email", "POST", {
      email: account.email,
      password: "local-prototype-test-password-123",
    });
    assert.equal(response.status(), 200, await response.text());
  }
  await client.query(
    'insert into "organization" ("id","name","slug","createdAt","createdByUserId") values ($1,\'Prototype fixture\',$1,now(),$2)',
    [org, users[0]],
  );
  for (const [index, user] of users.slice(0, 2).entries())
    await client.query(
      'insert into "member" ("id","organizationId","userId","role","createdAt") values ($1,$2,$3,$4,now())',
      [`member-${user}`, org, user, index ? "viewer" : "owner"],
    );
  await client.query(
    'insert into "designFile" ("id","organizationId","name","createdBy") values ($1,$2,\'Prototype acceptance\',$3)',
    [file, org, users[0]],
  );
  const image = await sharp({
    create: { width: 100, height: 60, channels: 4, background: "#2244ff" },
  })
    .png()
    .toBuffer();
  const upload = await contexts[0].request.post(`${base}/api/files/${file}/assets`, {
    headers: { Origin: base },
    multipart: { image: { name: "prototype.png", mimeType: "image/png", buffer: image } },
  });
  assert.equal(upload.status(), 200, await upload.text());
  const asset = (await upload.json()).assetId;
  const content = {
    schemaVersion: 1,
    legacyConverted: true,
    pages: [
      { id: "page-1", name: "Start page" },
      { id: "page-two", name: "Second page" },
    ],
    tokens: {},
    warnings: [],
    editedNodeIds: [],
    deletedSourceKeys: [],
    nodes: [
      node("first", "artboard", null, "Start screen", 50, 50, 500, 420, {
        style: { fill: "#ffffff" },
      }),
      node("next", "container", "first", "Next screen", 30, 30, 160, 45, {
        style: { fill: "#dddddd" },
        interactions: [
          interaction(
            { type: "navigate", target: "second" },
            { type: "click" },
            { type: "fade", duration: 400 },
          ),
        ],
      }),
      node("hover", "container", "first", "Hover state", 30, 100, 160, 45, {
        style: { fill: "#777777" },
        states: { focus: { fill: "#11aa22" } },
        interactions: [
          interaction({ type: "setState", target: "hover", state: "focus" }, { type: "hover" }),
        ],
      }),
      node("key", "container", "first", "Keyboard overlay", 30, 170, 160, 45, {
        style: { fill: "#aaaaaa" },
        interactions: [
          interaction(
            { type: "openOverlay", target: "overlay", position: "center", dismissOutside: false },
            { type: "key", key: "o" },
            { type: "slide", duration: 300 },
          ),
        ],
      }),
      node("variant", "container", "first", "Switch variant", 30, 230, 160, 45, {
        style: { fill: "#aaaaaa" },
        interactions: [
          interaction({ type: "setVariant", target: "component", variant: "alternate" }),
        ],
      }),
      node("component", "container", "first", "Component", 230, 30, 200, 60, {
        isComponent: true,
        variants: {
          default: "primary",
          options: {
            primary: {},
            alternate: {
              root: { style: { fill: "#6633cc" } },
              children: { "component-text": { text: "Alternate variant" } },
            },
          },
        },
      }),
      node("component-text", "text", "component", "Component text", 8, 8, 180, 40, {
        text: "Primary variant",
        style: { fontFamily: "monospace", fontSize: 16, color: "#222222" },
      }),
      node("image", "image", "first", "Original image", 230, 120, 100, 60, { assetId: asset }),
      node("second", "artboard", null, "Second screen", 700, 50, 400, 300, {
        pageId: "page-two",
        style: { fill: "#eeeeee" },
        interactions: [
          interaction(
            { type: "setState", target: "second-text", state: "focus" },
            { type: "afterDelay", delay: 400 },
          ),
        ],
      }),
      node("second-text", "text", "second", "Delayed text", 30, 30, 300, 50, {
        pageId: "page-two",
        text: "Second page content",
        style: { fontFamily: "monospace", fontSize: 20 },
        states: { focus: { color: "#aa22bb" } },
      }),
      node("return", "container", "second", "Return to start", 30, 110, 200, 50, {
        pageId: "page-two",
        linkTo: "first",
        style: { fill: "#dddddd" },
      }),
      node("overlay", "artboard", null, "Overlay screen", 1200, 50, 300, 180, {
        pageId: "page-two",
        style: { fill: "#fafafa" },
      }),
      node("overlay-text", "text", "overlay", "Overlay title", 20, 20, 260, 40, {
        pageId: "page-two",
        text: "Overlay content",
        style: { fontFamily: "monospace", fontSize: 20 },
      }),
      node("close", "container", "overlay", "Close authored overlay", 20, 80, 220, 50, {
        pageId: "page-two",
        style: { fill: "#dddddd" },
        interactions: [interaction({ type: "closeOverlay" })],
      }),
    ],
  };
  await client.query('insert into "designDocument" ("fileId","content") values ($1,$2::jsonb)', [
    file,
    JSON.stringify(content),
  ]);
  const editor = await contexts[0].newPage();
  editor.on("pageerror", (error) => errors.push(error.message));
  await editor.goto(`${base}/files/${file}`);
  await openPanels(editor);
  await editor.getByRole("button", { name: "Select Next screen", exact: true }).click();
  assert.equal(await editor.getByRole("button", { name: /^Trigger: / }).count(), 0);
  await editor.getByRole("button", { name: "Prototype", exact: true }).click();
  await editor.getByRole("button", { name: "Trigger: click", exact: true }).waitFor();
  await choice(editor, "Trigger", "key");
  await waitFor(
    (snapshot) =>
      snapshot.content.nodes.find((node) => node.id === "next").interactions[0].trigger.type ===
      "key",
  );
  await editor.getByLabel("Design canvas", { exact: true }).focus();
  await editor.keyboard.press("Control+z");
  await waitFor(
    (snapshot) =>
      snapshot.content.nodes.find((node) => node.id === "next").interactions[0].trigger.type ===
      "click",
  );
  await editor.keyboard.press("Control+Shift+z");
  await waitFor(
    (snapshot) =>
      snapshot.content.nodes.find((node) => node.id === "next").interactions[0].trigger.type ===
      "key",
  );
  await editor.keyboard.press("Control+z");
  await editor.getByRole("button", { name: "Trigger: click", exact: true }).waitFor();
  await choice(editor, "Transition", "slide");
  await editor.getByLabel("Duration (ms)", { exact: true }).fill("650");
  await editor.getByLabel("Duration (ms)", { exact: true }).press("Enter");
  await waitFor(
    (snapshot) =>
      snapshot.content.nodes.find((node) => node.id === "next").interactions[0].transition
        .duration === 650,
  );
  await editor.reload();
  await openPanels(editor);
  await editor.getByRole("button", { name: "Select Next screen", exact: true }).click();
  await editor.getByRole("button", { name: "Prototype", exact: true }).click();
  await editor.getByRole("button", { name: "Transition: slide", exact: true }).waitFor();
  assert.equal(await editor.getByLabel("Duration (ms)", { exact: true }).inputValue(), "650");
  await editor.getByRole("button", { name: "Preview", exact: true }).click();
  await editor.getByRole("region", { name: "Prototype player", exact: true }).waitFor();
  await editor.locator('[data-prototype-node="next"]').press("Enter");
  await editor.getByLabel("Screen Second screen", { exact: true }).waitFor();
  assert.ok(
    await editor.evaluate(() =>
      document
        .querySelector('[aria-label="Screen Second screen"]')
        .getAnimations()
        .some(
          (animation) =>
            animation.effect.getTiming().duration === 650 &&
            animation.effect.getKeyframes()[0].transform?.includes("32px"),
        ),
    ),
  );
  await editor.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-prototype-node="second-text"]')).color ===
      "rgb(170, 34, 187)",
  );
  await editor.getByRole("button", { name: "Back", exact: true }).click();
  await editor.getByLabel("Screen Start screen", { exact: true }).waitFor();
  await editor.getByRole("button", { name: "Exit preview", exact: true }).click();
  assert.equal(
    (await snapshot()).content.nodes.find((node) => node.id === "second-text").style.color,
    undefined,
  );
  console.log(
    "PASS: contextual authoring, one-step undo/redo, transition persistence, editor keyboard playback and temporary delay state",
  );
  const viewer = await contexts[1].newPage();
  viewer.on("pageerror", (error) => errors.push(error.message));
  await viewer.goto(`${base}/present/${file}?frame=first`);
  await viewer.getByLabel("Screen Start screen", { exact: true }).waitFor();
  await viewer.waitForFunction(() => {
    const image = document.querySelector('[data-prototype-node="image"] img');
    return image?.complete && image.naturalWidth === 100;
  });
  assert.equal(
    await viewer
      .locator('[data-prototype-node="component-text"]')
      .evaluate((element) => getComputedStyle(element).fontFamily),
    "monospace",
  );
  await viewer.locator('[data-prototype-node="hover"]').hover();
  await viewer.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-prototype-node="hover"]')).backgroundColor ===
      "rgb(17, 170, 34)",
  );
  await viewer.locator('[data-prototype-node="variant"]').click();
  await viewer.getByText("Alternate variant", { exact: true }).waitFor();
  await viewer.locator('[data-prototype-node="key"]').focus();
  await viewer.keyboard.press("o");
  await viewer.getByRole("dialog", { name: "Overlay screen", exact: true }).waitFor();
  await viewer.keyboard.press("Tab");
  assert.ok(
    await viewer.evaluate(() => Boolean(document.activeElement.closest('[role="dialog"]'))),
  );
  await viewer.keyboard.press("Escape");
  await viewer
    .getByRole("dialog", { name: "Overlay screen", exact: true })
    .waitFor({ state: "hidden" });
  await viewer.locator('[data-prototype-node="key"]').press("o");
  await viewer.locator('[data-prototype-node="close"]').press("Enter");
  await viewer
    .getByRole("dialog", { name: "Overlay screen", exact: true })
    .waitFor({ state: "hidden" });
  await viewer.locator('[data-prototype-node="next"]').click();
  await viewer.getByLabel("Screen Second screen", { exact: true }).waitFor();
  await viewer.locator('[data-prototype-node="return"]').press("Enter");
  await viewer.getByLabel("Screen Start screen", { exact: true }).waitFor();
  await choice(viewer, "Presentation frame", "Second page · Second screen");
  await viewer.getByLabel("Screen Second screen", { exact: true }).waitFor();
  await viewer.getByRole("button", { name: "Copy presentation link", exact: true }).click();
  await viewer.getByRole("status").filter({ hasText: "Presentation link copied" }).waitFor();
  const copied = await viewer.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, `${base}/present/${file}?frame=second`);
  await viewer.reload();
  await viewer.getByLabel("Screen Start screen", { exact: true }).waitFor();
  await viewer.goto(copied);
  await viewer.getByLabel("Screen Second screen", { exact: true }).waitFor();
  await viewer.setViewportSize({ width: 360, height: 800 });
  assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  console.log(
    "PASS: authorized shared route, original assets/typography, hover and variant states, overlays/focus/Escape, cross-page links and narrow presentation",
  );
  const denied = await api(contexts[1], `/api/files/${file}/changes`, "POST", {
    operationId: crypto.randomUUID(),
    patch: [],
  });
  assert.equal(denied.status(), 403);
  await viewer.goto(`${base}/files/${file}`);
  await openPanels(viewer);
  await viewer.getByRole("button", { name: "Select Next screen", exact: true }).click();
  await viewer.getByRole("button", { name: "Prototype", exact: true }).click();
  assert.equal(
    await viewer.getByRole("button", { name: "Add interaction", exact: true }).isDisabled(),
    true,
  );
  await viewer.getByRole("button", { name: "Preview", exact: true }).click();
  await viewer.getByLabel("Screen Start screen", { exact: true }).waitFor();
  const outside = await contexts[2].newPage();
  const inaccessible = await outside.goto(`${base}/present/${file}`);
  assert.ok([200, 404].includes(inaccessible.status()));
  await outside.getByText("This page could not be found.", { exact: true }).waitFor();
  assert.equal(
    await outside.getByRole("region", { name: "Prototype player", exact: true }).count(),
    0,
  );
  assert.ok(!(await inaccessible.text()).includes("Second page content"));
  assert.equal((await api(contexts[2], `/api/assets/${asset}`)).status(), 404);
  const anonymous = await browser.newContext();
  const login = await anonymous.newPage();
  await login.goto(`${base}/present/${file}`);
  assert.equal(new URL(login.url()).pathname, "/login");
  await anonymous.close();
  await client.query('delete from "member" where "organizationId"=$1 and "userId"=$2', [
    org,
    users[1],
  ]);
  assert.equal((await api(contexts[1], `/api/assets/${asset}`)).status(), 404);
  const revoked = await viewer.goto(`${base}/present/${file}`);
  assert.ok([200, 404].includes(revoked.status()));
  await viewer.getByText("This page could not be found.", { exact: true }).waitFor();
  assert.equal(
    await viewer.getByRole("region", { name: "Prototype player", exact: true }).count(),
    0,
  );
  assert.ok(!(await revoked.text()).includes("Second page content"));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: viewer preview without writes, outsider/anonymous denial, membership revocation and no browser runtime errors",
  );
} catch (error) {
  console.error("Browser runtime errors:", errors);
  for (const context of contexts)
    for (const page of context.pages())
      console.error(
        "Page:",
        page.url(),
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 1400),
      );
  throw error;
} finally {
  await browser.close();
  await client.query('delete from "organization" where "id"=$1', [org]).catch(() => {});
  await client.query('delete from "user" where "id"=any($1::text[])', [users]).catch(() => {});
  await client.end();
}
