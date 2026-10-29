import { openDatabaseAsync } from "expo-sqlite";

const database = openDatabaseAsync("tidy-designs.db").then(async (db) => {
  await db.execAsync(
    "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  return db;
});
export const designStorage = {
  async read(): Promise<string[]> {
    return (
      await (await database).getAllAsync<{ value: string }>("SELECT value FROM documents")
    ).map((row) => row.value);
  },
  async write(id: string, value: string) {
    await (
      await database
    ).runAsync(
      "INSERT INTO documents (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
      id,
      value,
    );
  },
};
