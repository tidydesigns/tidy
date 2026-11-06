import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportsExactReset } from "./codex-reset-capability";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});
async function executable() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-reset-capability-test-"));
  cleanups.push(directory);
  const path = join(directory, "codex-fixture");
  async function install(creditId: boolean) {
    await writeFile(
      path,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (JSON.stringify(process.argv.slice(2, 5)) !== JSON.stringify(['app-server','generate-json-schema','--out'])) process.exit(2);
const out = process.argv[5];
fs.mkdirSync(path.join(out,'v2'));
fs.writeFileSync(path.join(out,'v2','ConsumeAccountRateLimitResetCreditParams.json'), JSON.stringify({properties:{idempotencyKey:{type:'string'}${creditId ? ",creditId:{type:['string','null']}" : ""}}}));
`,
    );
    await chmod(path, 0o700);
  }
  return { path, install };
}

test("a CLI without creditId support cannot redeem; replacing it invalidates capability cache", async () => {
  const fixture = await executable();
  await fixture.install(false);
  expect(await supportsExactReset(fixture.path)).toBe(false);
  await fixture.install(true);
  expect(await supportsExactReset(fixture.path)).toBe(true);
  await fixture.install(false);
  expect(await supportsExactReset(fixture.path)).toBe(false);
});

test("failed schema generation never enables redemption", async () => {
  const fixture = await executable();
  await writeFile(fixture.path, "#!/usr/bin/env node\nprocess.exit(1);\n");
  await chmod(fixture.path, 0o700);
  expect(await supportsExactReset(fixture.path)).toBe(false);
});

test("a transient schema failure can recover without replacing the executable", async () => {
  const fixture = await executable();
  await fixture.install(true);
  const code = await readFile(fixture.path, "utf8");
  await writeFile(
    fixture.path,
    code.replace(
      "const out = process.argv[5];",
      `
const marker = __filename + '.attempted';
if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); process.exit(1); }
const out = process.argv[5];`,
    ),
  );
  expect(await supportsExactReset(fixture.path)).toBe(false);
  expect(await supportsExactReset(fixture.path)).toBe(true);
});
