import { recoveryLockScript } from "./recovery-lock";

export const installedHostScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
${recoveryLockScript}
const [root, state, desired, client, expected, update] = process.argv.slice(1);
const read = name => {
  try { return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
try {
  const runtime = read('runtime.json');
  if (expected) {
    let identity;
    try { identity = fs.readFileSync(path.join(state, 'identity'), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((identity && identity !== expected) || (runtime && runtime.hostId !== expected))
      throw Error('Backend identity changed. Verify this machine before reconnecting.');
  }
  let alive = runtime && (() => {
      try { process.kill(runtime.pid, 0); return true; }
      catch (error) {
        if (error.code === 'ESRCH') return false;
        if (error.code === 'EPERM') return true;
        throw error;
      }
    })();
  if (alive && runtime.protocol !== 3) {
    const release = lockInactiveHost(state);
    if (!release) throw Error('The backend protocol is incompatible with this desktop. Install compatible desktop and backend versions before reconnecting.');
    release();
    alive = false;
  }
  const activation = !alive || update === 'yes' || update === 'apply' ? read('activation.json') : null;
  if (update === 'yes') {
    process.stdout.write('TIDY_INSTALL_REQUIRED\n');
  } else {
    const candidate = update === 'apply' || update === 'installed' ? desired : alive ? runtime.buildId : activation?.buildId ?? runtime?.buildId ?? desired;
    const builds = [candidate];
    if (alive && update === 'no') {
      builds.push(desired);
      try {
        builds.push(...fs.readdirSync(root, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
          .slice(0, 32).map(entry => entry.name));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const deadline = Date.now() + 10000;
    let damagedLive = false;
    for (const build of new Set(builds)) {
      if (typeof build !== 'string' || !/^[a-f0-9]{64}$/.test(build)) continue;
      let installed = false;
      let present = false;
      const directory = path.join(root, build);
      const entry = path.join(directory, 'tidy-host.mjs');
      const node = path.join(directory, 'bin', 'node');
      try {
        const info = fs.lstatSync(directory);
        present = true;
        installed = info.isDirectory() && !info.isSymbolicLink() &&
          fs.readFileSync(path.join(directory, 'complete'), 'utf8').trim() === build &&
          crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') === build;
        if (installed) {
          try { fs.accessSync(node, fs.constants.X_OK); }
          catch (error) { if (error.code !== 'EACCES') throw error; installed = false; }
        }
        if (installed && fs.realpathSync(node) !== fs.realpathSync(process.execPath)) {
          const check = cp.spawnSync(node, ['-e', 'if(Number(process.versions.node.split(".")[0]) < 24) process.exit(1); process.stdout.write("ready")'], { encoding: 'utf8', timeout: 5000 });
          installed = check.status === 0 && check.stdout === 'ready';
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        installed = false;
      }
      if (build === runtime?.buildId && present && !installed) damagedLive = true;
      if (installed && alive && build !== runtime.buildId && update !== 'apply') {
        if (Date.now() >= deadline) break;
        const version = cp.spawnSync(node, [entry, 'version'], {
          encoding: 'utf8', timeout: Math.min(5000, Math.max(1, deadline - Date.now())),
        });
        let descriptor;
        try { descriptor = JSON.parse(version.stdout); } catch { continue; }
        if (version.status !== 0 || descriptor?.protocol !== 3) continue;
        if (runtime.managed !== false &&
            !(Array.isArray(descriptor.capabilities) && descriptor.capabilities.includes('reconnect')))
          continue;
      }
      if (installed) {
        const result = cp.spawnSync(node, [entry, 'ensure', client, ...(update === 'apply' ? [] : ['--reconnect'])], {
          stdio: 'inherit', env: process.env, timeout: 105000, killSignal: 'SIGTERM',
        });
        if (result.error) throw result.error;
        process.exit(result.status ?? 1);
      }
    }
    if (alive && damagedLive) {
      const release = lockInactiveHost(state);
      if (!release) throw Error('The running backend installation is damaged. Restore its verified runtime before reconnecting.');
      release();
    }
    process.stdout.write('TIDY_INSTALL_REQUIRED\n');
  }
} catch (error) {
  process.stderr.write('Remote backend recovery failed: ' + error.message + '\n');
  process.exitCode = 1;
}
`;
