export const agentSupervisor = `
const { spawn } = require("node:child_process");
const parent = Number(process.argv[1]);
const terminate = () => process.kill(-process.pid, "SIGKILL");
if (process.ppid !== parent) terminate();
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
const watcher = setInterval(() => { if (process.ppid !== parent) terminate(); }, 200);
child.on("error", () => { clearInterval(watcher); process.exit(1); });
child.on("exit", (code, signal) => { clearInterval(watcher); process.exit(code ?? (signal ? 1 : 0)); });
`;
