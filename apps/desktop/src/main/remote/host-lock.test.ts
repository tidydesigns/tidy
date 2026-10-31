import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function proveOwnership(script: string) {
  const root = await mkdtemp(join(tmpdir(), "host-ownership-"));
  try {
    const child = spawn("node", ["--import", "tsx", "--input-type=module", "-e", script, root], {
      cwd: new URL("../../..", import.meta.url),
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10000,
      killSignal: "SIGKILL",
    });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    expect(errors).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "ownership migration preserves a live legacy host and permanently excludes legacy launchers after release",
  async () => {
    await proveOwnership(`
      import assert from 'node:assert/strict';
      import {readFile} from 'node:fs/promises';
      import {join} from 'node:path';
      import {lockHost,lockWorkspaceHost} from './src/main/remote/host-lock.ts';
      const root=process.argv[1], legacyPath=join(root,'host.lock');
      const releaseLegacy=lockHost(legacyPath);
      const original=await readFile(legacyPath);
      await assert.rejects(lockWorkspaceHost(root));
      assert.deepEqual(await readFile(legacyPath),original);
      releaseLegacy();
      const release=await lockWorkspaceHost(root);
      assert.deepEqual(JSON.parse(await readFile(legacyPath,'utf8')), {format:'tidy-workspace-lock',version:2});
      await assert.rejects(lockWorkspaceHost(root));
      assert.throws(()=>lockHost(legacyPath));
      release();
      assert.throws(()=>lockHost(legacyPath));
      const recovered=await lockWorkspaceHost(root); recovered();
    `);
  },
);

test.skipIf(process.platform === "win32")(
  "a crashed backend leaves the legacy guard intact while an updated backend can reclaim ownership",
  async () => {
    await proveOwnership(`
      import assert from 'node:assert/strict';
      import {spawn} from 'node:child_process';
      import {join} from 'node:path';
      import {lockHost,lockWorkspaceHost} from './src/main/remote/host-lock.ts';
      const root=process.argv[1];
      const worker=spawn(process.execPath,['--import','tsx','--input-type=module','-e',
        "import {lockWorkspaceHost} from './src/main/remote/host-lock.ts'; await lockWorkspaceHost(process.argv[1]); process.stdout.write('ready'); setInterval(()=>{},1000);",root],
        {stdio:['ignore','pipe','inherit']});
      const exited=new Promise((resolve,reject)=>{worker.once('exit',resolve);worker.once('error',reject)});
      try {
        await Promise.race([
          new Promise(resolve=>worker.stdout.once('data',resolve)),
          exited.then(()=>{throw new Error('Worker exited before acquiring ownership')})
        ]);
        worker.kill('SIGKILL'); await exited;
        assert.throws(()=>lockHost(join(root,'host.lock')));
        const release=await lockWorkspaceHost(root); release();
        assert.throws(()=>lockHost(join(root,'host.lock')));
      } finally {worker.kill('SIGKILL'); await exited;}
    `);
  },
);
