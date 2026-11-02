export const recoveryLockScript = String.raw`
const lockInactiveHost = directory => {
  const { DatabaseSync } = require('node:sqlite');
  const databases = [];
  const release = () => { for (const db of databases.reverse()) db.close(); };
  try {
    let marker;
    try { marker = fs.readFileSync(path.join(directory, 'host.lock'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (marker !== JSON.stringify({ format: 'tidy-workspace-lock', version: 2 })) {
      if (marker?.startsWith('{')) throw Error('The backend ownership format requires a newer desktop.');
      const legacy = new DatabaseSync(path.join(directory, 'host.lock'));
      databases.push(legacy);
      legacy.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    }
    const current = new DatabaseSync(path.join(directory, 'host-v2.lock'));
    databases.push(current);
    current.exec('PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    return release;
  } catch (error) {
    release();
    if (error.errcode === 5 || error.errcode === 6) return null;
    throw error;
  }
};
`;
