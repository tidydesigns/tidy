import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const sql = await readFile(
  fileURLToPath(new URL("../../../migrations/schema-design-rectangles.sql", import.meta.url)),
  "utf8",
);
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const before = await client.query(
    `select to_regclass('"designFile"') is not null as "filePresent",
            to_regclass('"designRectangle"') is not null as "rectanglePresent"`,
  );
  if (process.argv.includes("--check")) {
    console.log(before.rows[0]);
    if (before.rows[0].rectanglePresent) {
      const counts = await client.query(
        `select (select count(*)::int from "designFile") as files,
                (select count(*)::int from "designFrame") as frames,
                (select count(*)::int from "designRectangle") as rectangles,
                to_regclass('"designRectangle_fileId_createdAt_idx"') is not null as "indexPresent"`,
      );
      console.log(counts.rows[0]);
    }
  } else {
    if (!before.rows[0].filePresent || before.rows[0].rectanglePresent) {
      throw new Error(
        "Expected designFile to exist and designRectangle to be absent. Review schema before retrying.",
      );
    }
    await client.query("begin");
    try {
      await client.query(sql);
      const verified = await client.query(
        `select c."conname" from pg_constraint c where c."conrelid" = '"designRectangle"'::regclass
         and c."conname" in ('designRectangle_fileId_fkey', 'designRectangle_position_check', 'designRectangle_size_check')`,
      );
      const index = await client.query(
        `select to_regclass('"designRectangle_fileId_createdAt_idx"') is not null as present`,
      );
      if (verified.rowCount !== 3 || !index.rows[0].present)
        throw new Error("Rectangle constraints or index did not verify.");
      await client.query("commit");
      console.log("Created and verified designRectangle, its constraints, and index.");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
