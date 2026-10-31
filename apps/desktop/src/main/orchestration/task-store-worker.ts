export const taskStoreWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const database = process.versions.bun
  ? new (require('bun:sqlite').Database)(workerData.path, { create: true })
  : new (require('node:sqlite').DatabaseSync)(workerData.path);
const statement = (sql) => process.versions.bun ? database.query(sql) : database.prepare(sql);
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const transaction = (work) => {
  database.exec('BEGIN IMMEDIATE');
  try { const result = work(); database.exec('COMMIT'); return result; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
};
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const nextSequence = () => {
  database.exec('UPDATE metadata SET sequence = sequence + 1 WHERE id = 1');
  return statement('SELECT sequence FROM metadata WHERE id = 1').get().sequence;
};
const decode = (row) => row ? JSON.parse(row.record) : undefined;
const get = (id) => decode(statement('SELECT record FROM tasks WHERE id = ?').get(id));
const save = (task) => {
  statement('UPDATE tasks SET state = ?, sequence = ?, delivered = ?, record = ? WHERE id = ?')
    .run(task.state, task.sequence, Number(task.delivered), JSON.stringify(task), task.id);
  return task;
};
function dispatch(kind, input) {
  if (kind === 'initialize') {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 3000; CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL); INSERT OR IGNORE INTO metadata VALUES (1, 0); CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_thread_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, sequence INTEGER NOT NULL, delivered INTEGER NOT NULL, record TEXT NOT NULL, UNIQUE(project_id, parent_thread_id, request_id)); CREATE INDEX IF NOT EXISTS task_owner_sequence ON tasks(project_id, parent_thread_id, sequence); CREATE INDEX IF NOT EXISTS task_delivery ON tasks(delivered, state, sequence); CREATE TABLE IF NOT EXISTS operation_receipts (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_children (project_id TEXT NOT NULL, child_thread_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, PRIMARY KEY(project_id, child_thread_id)); INSERT INTO task_children SELECT project_id, json_extract(record, \'$.childThreadId\'), id FROM tasks WHERE (json_extract(record, \'$.kind\') IS NULL OR json_extract(record, \'$.kind\') = \'initial\') AND NOT EXISTS (SELECT 1 FROM task_children WHERE task_children.task_id = tasks.id);');
    database.exec('CREATE TABLE IF NOT EXISTS thread_receivers (project_id TEXT NOT NULL, thread_id TEXT NOT NULL, grant_id TEXT NOT NULL, PRIMARY KEY(project_id, thread_id));');
    transaction(() => {
      while (true) {
        const rows = statement("SELECT record FROM tasks WHERE state IN ('queued', 'running', 'cancel_requested') LIMIT 100").all();
        if (!rows.length) break;
        for (const row of rows) {
          const task = decode(row);
          save({ ...task, state: 'interrupted', error: 'The workspace backend stopped during this assignment. Inspect its changes before retrying.', delivered: false, updatedAt: new Date().toISOString(), sequence: nextSequence() });
        }
      }
    });
    return { receivers: statement('SELECT project_id AS projectId, thread_id AS threadId, grant_id AS grantId FROM thread_receivers').all(), lineage: statement('SELECT task_children.project_id AS projectId, task_children.child_thread_id AS childThreadId, tasks.parent_thread_id AS parentThreadId FROM task_children JOIN tasks ON tasks.id = task_children.task_id').all() };
  }
  if (kind === 'set-receiver') return transaction(() => {
    if (!input.enabled) { statement('DELETE FROM thread_receivers WHERE project_id = ? AND thread_id = ?').run(input.projectId, input.threadId); return null; }
    const prior = statement('SELECT grant_id FROM thread_receivers WHERE project_id = ? AND thread_id = ?').get(input.projectId, input.threadId);
    if (prior) return prior.grant_id;
    if (statement('SELECT COUNT(*) AS count FROM thread_receivers').get().count >= 10000) fail('CAPACITY', 'The receiver permission store reached its retention limit.');
    const grant = randomUUID();
    statement('INSERT INTO thread_receivers VALUES (?, ?, ?)').run(input.projectId, input.threadId, grant);
    return grant;
  });
  if (kind === 'create') return transaction(() => {
    const { fingerprint, ...value } = input;
    const prior = statement('SELECT record, fingerprint FROM tasks WHERE project_id = ? AND parent_thread_id = ? AND request_id = ?').get(value.projectId, value.parentThreadId, value.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', 'This request ID belongs to a different assignment.');
      return decode(prior);
    }
    const childOwner = statement('SELECT task_id FROM task_children WHERE project_id = ? AND child_thread_id = ?').get(value.projectId, value.childThreadId);
    if (value.kind === 'followup') {
      const owner = childOwner && get(childOwner.task_id);
      if (!owner || owner.parentThreadId !== value.parentThreadId) fail('REQUEST_CONFLICT', 'This child thread belongs to another assignment owner.');
    } else if (childOwner) fail('REQUEST_CONFLICT', 'This child thread already belongs to an assignment.');
    if (statement('SELECT COUNT(*) AS count FROM tasks').get().count >= 10000) fail('CAPACITY', 'The assignment store reached its retention limit.');
    const now = new Date().toISOString();
    const task = { ...value, id: randomUUID(), state: 'queued', sequence: nextSequence(), createdAt: now, updatedAt: now, delivered: false };
    statement('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(task.id, task.projectId, task.parentThreadId, task.requestId, fingerprint, task.state, task.sequence, 0, JSON.stringify(task));
    if (!childOwner && value.kind !== 'message') statement('INSERT INTO task_children VALUES (?, ?, ?)').run(task.projectId, task.childThreadId, task.id);
    return task;
  });
  if (kind === 'for-request') return decode(statement('SELECT record FROM tasks WHERE project_id = ? AND parent_thread_id = ? AND request_id = ?').get(input.projectId, input.parentThreadId, input.requestId)) ?? null;
  if (kind === 'for-child') return decode(statement('SELECT tasks.record FROM task_children JOIN tasks ON tasks.id = task_children.task_id WHERE task_children.project_id = ? AND task_children.child_thread_id = ?').get(input.projectId, input.childThreadId)) ?? null;
  if (kind === 'get') return get(input.id) ?? null;
  if (kind === 'thread-page') {
    const filter = input.taskIds ? ' AND id IN (' + input.taskIds.map(() => '?').join(',') + ')' : '';
    const rows = statement('SELECT rowid AS position, record FROM tasks WHERE project_id = ? AND parent_thread_id = ?' + (input.before ? ' AND rowid < ?' : '') + filter + ' ORDER BY rowid DESC LIMIT 51')
      .all(input.projectId, input.parentThreadId, ...(input.before ? [input.before] : []), ...(input.taskIds || []));
    const tasks = [];
    let bytes = 2048;
    for (const row of rows.slice(0, 50)) {
      const task = decode(row);
      const value = {
        id: task.id, childThreadId: task.childThreadId, originatingMessageId: task.originatingMessageId,
        sequence: task.sequence, label: task.prompt.replace(/\s+/g, ' ').slice(0, 160),
        state: task.state, kind: task.kind || 'initial', harness: task.harness,
        model: task.settings.model, effort: task.settings.effort, createdAt: task.createdAt,
        summary: task.summary?.slice(-1000), error: task.error?.slice(0, 1000),
      };
      const size = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (bytes + size > 128 * 1024) break;
      tasks.push(value);
      bytes += size;
    }
    return { tasks, nextCursor: rows.length > tasks.length ? rows[tasks.length - 1].position : null };
  }
  if (kind === 'list') {
    const ids = input.ids;
    if (ids && !ids.length) return { tasks: [], cursor: input.after };
    const filter = ids ? ' AND id IN (' + ids.map(() => '?').join(',') + ')' : '';
    const tasks = statement('SELECT record FROM tasks WHERE project_id = ? AND parent_thread_id = ? AND sequence > ?' + filter + ' ORDER BY sequence LIMIT ?')
      .all(input.projectId, input.parentThreadId, input.after, ...(ids || []), input.limit).map(decode);
    return { tasks, cursor: tasks.length ? tasks[tasks.length - 1].sequence : input.after };
  }
  if (kind === 'transition') return transaction(() => {
    const current = get(input.id);
    if (!current) fail('NOT_FOUND', 'Assignment not found.');
    if (terminal.has(current.state)) {
      if (current.state === input.state) return current;
      fail('INVALID_STATE', 'This assignment already has a terminal result.');
    }
    let state = input.state;
    if (current.state === 'cancel_requested' && terminal.has(state)) state = 'cancelled';
    const allowed = current.state === 'queued'
      ? new Set(['running', 'cancel_requested', 'cancelled', 'failed', 'interrupted'])
      : current.state === 'running'
        ? new Set(['completed', 'failed', 'cancel_requested', 'cancelled', 'interrupted'])
        : new Set(['cancel_requested', 'cancelled']);
    if (state !== current.state && !allowed.has(state)) fail('INVALID_STATE', 'Invalid assignment state transition.');
    if (state === current.state) return current;
    const task = { ...current, state, sequence: nextSequence(), updatedAt: new Date().toISOString(), delivered: false };
    if (input.summary !== undefined) task.summary = input.summary;
    if (input.error !== undefined) task.error = input.error;
    return save(task);
  });
  if (kind === 'pending') return statement("SELECT record FROM tasks WHERE delivered = 0 AND state IN ('completed','failed','cancelled','interrupted') AND sequence > ? ORDER BY sequence LIMIT 100").all(input.after).map(decode);
  if (kind === 'read-receipt') {
    const row = statement('SELECT value FROM operation_receipts WHERE key = ?').get(input.key);
    return row ? { found: true, value: JSON.parse(row.value) } : { found: false };
  }
  if (kind === 'write-receipt') return transaction(() => {
    const prior = statement('SELECT key FROM operation_receipts WHERE key = ?').get(input.key);
    if (!prior && statement('SELECT COUNT(*) AS count FROM operation_receipts').get().count >= 10000) fail('CAPACITY', 'The operation receipt store reached its retention limit.');
    statement('INSERT INTO operation_receipts (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(input.key, input.encoded);
    return null;
  });
  if (kind === 'delivery-failed') return transaction(() => {
    const task = get(input.id);
    if (!task) fail('NOT_FOUND', 'Assignment not found.');
    if (task.deliveryError !== input.message) save({ ...task, deliveryError: input.message });
    return null;
  });
  if (kind === 'delivered') return transaction(() => {
    const task = get(input.id);
    if (!task) fail('NOT_FOUND', 'Assignment not found.');
    if (!terminal.has(task.state)) fail('INVALID_STATE', 'An active assignment has no result to deliver.');
    if (!task.delivered) {
      const { deliveryError, ...value } = task;
      save({ ...value, delivered: true });
    }
    return null;
  });
  if (kind === 'close') { database.close(); return null; }
  fail('INVALID_REQUEST', 'Unknown assignment store operation.');
}
parentPort.on('message', ({ id, kind, input }) => {
  try { parentPort.postMessage({ id, ok: true, value: dispatch(kind, input) }); }
  catch (error) { parentPort.postMessage({ id, ok: false, code: error.code || 'STORAGE', message: String(error.message).slice(0, 500) }); }
});
`;
