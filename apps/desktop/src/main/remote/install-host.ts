export const installHostScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const [root, stage, nodeStage, nodeRuntime, checksum, build, state] = process.argv.slice(1);
const runtime = path.join(root, build);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const complete = (directory, marker) => {
  try {
    return !fs.lstatSync(directory).isSymbolicLink() &&
      fs.readFileSync(path.join(directory, 'complete'), 'utf8').trim() === marker &&
      (fs.accessSync(path.join(directory, 'bin/node'), fs.constants.X_OK), true);
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};
const nodeReady = () => {
  if (!complete(nodeRuntime, checksum)) return false;
  const result = cp.spawnSync(path.join(nodeRuntime, 'bin/node'), ['-e', 'require("node:sqlite"); process.stdout.write("ready")'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && result.stdout === 'ready';
};
const bundleReady = () => {
  try { return complete(runtime, build) && hash(path.join(runtime, 'tidy-host.mjs')) === build; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};
const locks = [];
const cleanup = () => {
  for (const db of locks.reverse()) { try { db.close(); } catch {} }
  fs.rmSync(stage, { recursive: true, force: true });
  if (nodeStage) fs.rmSync(nodeStage, { recursive: true, force: true });
};
process.once('exit', cleanup);
for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(1));
const acquire = async file => {
  const db = new DatabaseSync(file);
  locks.push(db);
  db.exec('PRAGMA busy_timeout=0');
  const deadline = Date.now() + 450000;
  for (;;) {
    try { db.exec('BEGIN EXCLUSIVE'); return; }
    catch (e) {
      if (e.errcode !== 5 && e.errcode !== 6) throw e;
      if (Date.now() >= deadline) throw Error('Another installation is still running. Retry shortly.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
};
const readRuntime = () => {
  try { return JSON.parse(fs.readFileSync(path.join(state, 'runtime.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const alive = runtime => {
  if (!runtime) return false;
  try { process.kill(runtime.pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
};
const publish = (source, destination) => {
  const quarantine = destination + '.damaged-' + crypto.randomUUID();
  let previous = false;
  try {
    if (exists(destination)) { fs.renameSync(destination, quarantine); previous = true; }
    fs.renameSync(source, destination);
  } catch (e) {
    if (previous && !exists(destination)) fs.renameSync(quarantine, destination);
    throw e;
  }
  if (previous) fs.rmSync(quarantine, { recursive: true, force: true });
};
(async () => {
  await acquire(path.join(root, 'install-v2.lock'));
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  await acquire(path.join(state, 'launch.lock'));
  const current = readRuntime();
  if (!nodeReady()) {
    if (exists(nodeRuntime) && alive(current)) throw Error('The shared runtime is damaged while a backend is running. Its active work was left in place.');
    if (!nodeStage) throw Error('The shared backend runtime is damaged. Retry to restore its installation.');
    publish(nodeStage, nodeRuntime);
  }
  if (!bundleReady()) {
    if (current?.buildId === build && alive(current))
      throw Error('The running backend installation is damaged. Its active work was left in place.');
    if (hash(path.join(stage, 'tidy-host.mjs')) !== build) throw Error('Backend checksum mismatch.');
    fs.mkdirSync(path.join(stage, 'bin'));
    fs.symlinkSync(path.join(nodeRuntime, 'bin/node'), path.join(stage, 'bin/node'));
    const check = cp.spawnSync(path.join(stage, 'bin/node'), [path.join(stage, 'tidy-host.mjs'), 'version'], { encoding: 'utf8', timeout: 30000 });
    if (check.status !== 0) throw Error('The backend installation could not be verified.');
    if (JSON.parse(check.stdout).protocol !== 3) throw Error('The backend protocol is incompatible.');
    fs.writeFileSync(path.join(stage, 'complete'), build + '\n', { mode: 0o600 });
    publish(stage, runtime);
  }
})().catch(error => {
  process.stderr.write('Backend installation failed: ' + error.message + '\n');
  process.exitCode = 1;
});
`;
