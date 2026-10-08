import "server-only";
import { db } from "./db";
import { withDeadline } from "./deadline";

export async function checkDatabaseHealth() {
  await withDeadline(db.query("select 1"), 3000, "Database health check timed out.");
}
