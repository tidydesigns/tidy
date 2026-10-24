import { expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pgRequire = createRequire(require.resolve("pg/package.json"));
const Connection = pgRequire("pg/lib/connection");
// The default Node export is intentionally empty; load the installed Worker
// adapter to exercise the same pg/pg-cloudflare pairing as the deployment.
const { CloudflareSocket } = pgRequire(
  join(dirname(pgRequire.resolve("pg-cloudflare/package.json")), "dist/index.js"),
);

test("Postgres termination closes Cloudflare sockets instead of exhausting Worker connections", async () => {
  const close = mock(() => {});
  const writes = [];
  for (let i = 0; i < 12; i++) {
    const socket = new CloudflareSocket(false);
    socket.writable = true;
    socket._cfSocket = { close };
    socket._cfWriter = {
      async write(bytes) {
        writes.push(Buffer.from(bytes));
      },
    };
    const connection = new Connection({ stream: socket });
    connection._connecting = true;
    connection.end();
    // Flush the adapter's write completion and resulting socket close.
    await Promise.resolve();
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(i + 1);
  }
  expect(writes).toHaveLength(12);
  for (const bytes of writes) expect(bytes).toEqual(Buffer.from([0x58, 0, 0, 0, 4]));
});
