import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { db } from "../db";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { getFileImage } from "./file-image";

// Never use an app environment or a remote database for destructive fixtures.
const testUrl = process.env.FILE_IMAGE_TEST_DATABASE_URL;
const enabled = Boolean(
  testUrl &&
  process.env.DATABASE_URL === testUrl &&
  new URL(testUrl).hostname === "127.0.0.1" &&
  new URL(testUrl).pathname === "/tidy_file_image_test",
);
const integration = enabled ? test : test.skip;
const assetId = "00000000-0000-4000-8000-000000000001";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz0AAAAASUVORK5CYII=";
const document = {
  ...blankDesignDocument(),
  nodes: [
    {
      ...buildDrawnNode("screenshot", "image", null, { x: 0, y: 0, width: 400, height: 300 }),
      assetId,
      name: "Hero inspiration",
    },
  ],
};
const read = (userId = "viewer", fileId = "file", id = assetId) => getFileImage(userId, fileId, id);

beforeAll(async () => {
  if (!enabled) return;
  await db.query("drop schema public cascade; create schema public");
  for (const name of [
    "schema.sql",
    "schema-organization.sql",
    "schema-design-files.sql",
    "schema-design-folders.sql",
    "schema-design-document.sql",
    "schema-github.sql",
    "20261003-design-object-storage.sql",
  ]) {
    await db.query(
      await readFile(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8"),
    );
  }
});
beforeEach(async () => {
  if (!enabled) return;
  await db.query('truncate "user", "organization" cascade');
  await db.query(`insert into "user" ("id", "name", "email", "emailVerified") values
    ('viewer', 'Viewer', 'viewer@example.invalid', true), ('outsider', 'Outsider', 'outsider@example.invalid', true)`);
  await db.query(`insert into "organization" ("id", "name", "slug", "createdAt") values
    ('org', 'Inspiration', 'inspiration', now()), ('other', 'Other', 'other', now())`);
  await db.query(
    `insert into "member" ("id", "organizationId", "userId", "role", "createdAt") values ('membership', 'org', 'viewer', 'viewer', now())`,
  );
  await db.query(
    `insert into "designFile" ("id", "organizationId", "name", "createdBy") values ('file', 'org', 'Inspiration', 'viewer')`,
  );
  await db.query(
    `insert into "designAsset" ("id", "organizationId", "mimeType", "sha256", "body", "byteSize") values ($1, 'org', 'image/png', 'test-digest', $2, $3)`,
    [assetId, Buffer.from(png, "base64"), Buffer.from(png, "base64").length],
  );
  await db.query(
    `insert into "designDocument" ("fileId", "revision", "content") values ('file', 4, $1)`,
    [JSON.stringify(document)],
  );
});
afterAll(async () => {
  if (enabled) await db.end();
});

integration("viewers can retrieve original image bytes and the current layer context", async () => {
  const image = await read();
  expect(image).toMatchObject({
    fileId: "file",
    assetId,
    revision: 4,
    mimeType: "image/png",
    base64: png,
  });
  expect(image.layers).toEqual([
    expect.objectContaining({ nodeId: "screenshot", name: "Hero inspiration" }),
  ]);
});
integration(
  "outsiders, removed members, missing files and archived files cannot read images",
  async () => {
    await expect(read("outsider")).rejects.toThrow("not found or access denied");
    await expect(read("viewer", "missing")).rejects.toThrow("not found or access denied");
    await db.query(`update "designFile" set "archivedAt" = now() where "id" = 'file'`);
    await expect(read()).rejects.toThrow("not found or access denied");
    await db.query(`update "designFile" set "archivedAt" = null where "id" = 'file'`);
    await db.query(`delete from "member" where "id" = 'membership'`);
    await expect(read()).rejects.toThrow("not found or access denied");
  },
);
integration("unreferenced, cross-organization and missing assets are rejected", async () => {
  await expect(read("viewer", "file", "00000000-0000-4000-8000-000000000002")).rejects.toThrow(
    "not found or access denied",
  );
  await db.query(`update "designDocument" set "content" = $1 where "fileId" = 'file'`, [
    JSON.stringify({ ...document, nodes: [] }),
  ]);
  await expect(read()).rejects.toThrow("not found or access denied");
  await db.query(`update "designDocument" set "content" = $1 where "fileId" = 'file'`, [
    JSON.stringify(document),
  ]);
  await db.query(`update "designAsset" set "organizationId" = 'other' where "id" = $1`, [assetId]);
  // Even a member of both organizations cannot read a foreign asset through this file.
  await db.query(
    `insert into "member" ("id", "organizationId", "userId", "role", "createdAt") values ('other-membership', 'other', 'viewer', 'viewer', now())`,
  );
  await expect(read()).rejects.toThrow("not found or access denied");
});
integration("image paints and unselected component variants are readable references", async () => {
  const container = buildDrawnNode("master", "container", null, {
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  for (const reference of [
    { style: { paints: [{ type: "image", assetId }] } },
    { variants: { options: { secondary: { root: { assetId } } } } },
    {
      variants: {
        options: {
          secondary: { children: { image: { style: { paints: [{ type: "image", assetId }] } } } },
        },
      },
    },
  ]) {
    await db.query(
      `update "designDocument" set "revision" = "revision" + 1, "content" = $1 where "fileId" = 'file'`,
      [JSON.stringify({ ...document, nodes: [{ ...container, ...reference }] })],
    );
    expect((await read()).layers[0].nodeId).toBe("master");
  }
  expect((await read()).revision).toBe(7);
});
