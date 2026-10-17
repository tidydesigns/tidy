/** One fixed shard holds short-lived leases for multiple accounts. */
export class ConnectionLeases {
  private count: number;
  private nextCleanupAt = 0;
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS connection_lease (owner TEXT NOT NULL, id TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(owner,id))",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS connection_lease_expiry ON connection_lease(expires_at)");
    this.count = sql
      .exec<{ count: number }>("SELECT count(*) AS count FROM connection_lease")
      .toArray()[0].count;
  }
  acquire(owner: string, id: string, expiresAt: number, now = Date.now()) {
    if (
      !owner ||
      owner.length > 128 ||
      !id ||
      id.length > 128 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + 305_000
    )
      return false;
    if (now >= this.nextCleanupAt) {
      this.count -= this.sql
        .exec(
          "DELETE FROM connection_lease WHERE rowid IN (SELECT rowid FROM connection_lease WHERE expires_at <= ? ORDER BY expires_at LIMIT 256) RETURNING id",
          now,
        )
        .toArray().length;
      this.nextCleanupAt = now + 1000;
    }
    // A ticket identifies one connection, not an idempotent lease acquisition.
    if (
      this.sql.exec("SELECT 1 FROM connection_lease WHERE owner=? AND id=?", owner, id).toArray()
        .length
    )
      return false;
    if (this.count >= 10_000) return false;
    const active = this.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM connection_lease WHERE owner=? AND expires_at>?",
        owner,
        now,
      )
      .toArray()[0].count;
    if (active >= 10) return false;
    this.sql.exec("INSERT INTO connection_lease VALUES (?, ?, ?)", owner, id, expiresAt);
    this.count++;
    return true;
  }
  release(owner: string, id: string) {
    this.count -= this.sql
      .exec("DELETE FROM connection_lease WHERE owner=? AND id=? RETURNING id", owner, id)
      .toArray().length;
  }
}
