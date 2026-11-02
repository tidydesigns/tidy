export const installedHostScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const [root, state, desired, client, expected, update] = process.argv.slice(1);
const read = name => {
  try { return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
try {
  const runtime = read('runtime.json');
  const activation = read('activation.json');
  if (expected) {
    let identity;
    try { identity = fs.readFileSync(path.join(state, 'identity'), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((identity && identity !== expected) || (runtime && runtime.hostId !== expected))
      throw Error('Backend identity changed. Verify this machine before reconnecting.');
  }
  const alive = runtime && (() => {
      try { process.kill(runtime.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    })();
  if (alive && runtime.protocol !== 3)
    throw Error('The backend protocol is incompatible with this desktop. Install compatible desktop and backend versions before reconnecting.');
  if (update === 'yes') {
    process.stdout.write('TIDY_INSTALL_REQUIRED\n');
  } else {
    const build = update === 'apply' ? desired : alive ? runtime.buildId : activation?.buildId ?? runtime?.buildId ?? desired;
    let installed = false;
    if (typeof build === 'string' && /^[a-f0-9]{64}$/.test(build)) {
      const directory = path.join(root, build);
      const entry = path.join(directory, 'tidy-host.mjs');
      const node = path.join(directory, 'bin', 'node');
      try {
        installed = !fs.lstatSync(directory).isSymbolicLink() &&
          fs.readFileSync(path.join(directory, 'complete'), 'utf8').trim() === build &&
          crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex') === build;
        if (installed) fs.accessSync(node, fs.constants.X_OK);
        if (installed && fs.realpathSync(node) !== fs.realpathSync(process.execPath)) {
          const check = cp.spawnSync(node, ['-e', 'if(Number(process.versions.node.split(".")[0]) < 24) process.exit(1); process.stdout.write("ready")'], { encoding: 'utf8', timeout: 5000 });
          installed = check.status === 0 && check.stdout === 'ready';
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        installed = false;
      }
      if (installed) {
        const result = cp.spawnSync(node, [entry, 'ensure', client, ...(update === 'apply' ? [] : ['--reconnect'])], {
          stdio: 'inherit', env: process.env, timeout: 105000, killSignal: 'SIGTERM',
        });
        if (result.error) throw result.error;
        process.exit(result.status ?? 1);
      }
    }
    if (alive) throw Error('The running backend installation is damaged. Restore its verified runtime before reconnecting.');
    process.stdout.write('TIDY_INSTALL_REQUIRED\n');
  }
} catch (error) {
  process.stderr.write('Remote backend recovery failed: ' + error.message + '\n');
  process.exitCode = 1;
}
`;
