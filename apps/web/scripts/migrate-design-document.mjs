import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const sql = await readFile(
  fileURLToPath(new URL("../../../migrations/schema-design-document.sql", import.meta.url)),
  "utf8",
);
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const before =
    await client.query(`select to_regclass('"designFile"') is not null as "filePresent",
    to_regclass('"designDocument"') is not null as "documentPresent",
    to_regclass('"designAsset"') is not null as "assetPresent",
    to_regclass('"designImport"') is not null as "importPresent"`);
  if (process.argv.includes("--check")) {
    console.log(before.rows[0]);
  } else {
    if (
      !before.rows[0].filePresent ||
      before.rows[0].documentPresent ||
      before.rows[0].assetPresent ||
      before.rows[0].importPresent
    )
      throw new Error(
        "Expected existing designFile and no document tables. Check schema before applying.",
      );
    await client.query("begin");
    try {
      await client.query(sql);
      const after =
        await client.query(`select to_regclass('"designDocument"') is not null as document,
        to_regclass('"designAsset"') is not null as asset,
        to_regclass('"designImport"') is not null as import`);
      if (!after.rows[0].document || !after.rows[0].asset || !after.rows[0].import)
        throw new Error("Document tables did not verify.");
      await client.query("commit");
      console.log("Created and verified document, asset, and import tables.");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
