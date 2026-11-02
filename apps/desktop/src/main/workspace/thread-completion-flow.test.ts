import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32")(
  "native IPC completes a linked thread after offline retry and preserves a manual reopen",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tidy completion flow "));
    try {
      const bin = join(directory, ".local/bin");
      await mkdir(bin, { recursive: true });
      await mkdir(join(directory, "system-bin"));
      const phase = join(directory, "github-phase");
      await writeFile(phase, "open\n");
      await writeFile(
        join(bin, "gh"),
        `#!/bin/sh
read -r phase < "$TIDY_GH_PHASE"
[ "$phase" = "offline" ] && exit 1
case "$1 $2" in
"repo view") printf '%s\\n' '{"defaultBranchRef":{"name":"main"}}' ;;
"pr view")
  if [ "$phase" = "open" ]; then
    printf '%s\\n' '{"state":"OPEN","isDraft":false,"baseRefName":"main","mergedAt":null,"closedAt":null}'
  else
    printf '%s\\n' '{"state":"MERGED","isDraft":false,"baseRefName":"main","mergedAt":"2026-01-01T00:00:00Z","closedAt":"2026-01-01T00:00:00Z"}'
  fi ;;
*) exit 2 ;;
esac
`,
        { mode: 0o700 },
      );
      const moduleURL = (relative: string) =>
        JSON.stringify(new URL(relative, import.meta.url).href);
      const script = `
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProjectStore } from ${moduleURL("./project-store.ts")};
import { WorkspaceService } from ${moduleURL("./workspace-service.ts")};
import { createWorkspaceRequests } from ${moduleURL("../ipc/workspace-requests.ts")};
import { defaultThreadCompletion } from ${moduleURL("../../shared/contracts/thread-completion.ts")};
let now = Date.now(); Date.now = () => now;
const root = join(process.env.HOME, "project"); await mkdir(root);
const store = new ProjectStore(join(process.env.HOME, "private")); await store.initialize();
const {project} = await store.open(root);
let run;
const service = new WorkspaceService(store, input => {
  const end = Promise.withResolvers(); run = {input, complete:end.resolve};
  return {done:end.promise,stop:end.resolve};
}, async () => "/fixture/agent", async () => {});
const ipc = createWorkspaceRequests(service, {chooseProject:async()=>null,chooseDesign:async()=>null,openExternal:async()=>{},showItemInFolder:()=>{}});
const invoke = (name,input) => ipc.invoke(name,input,undefined);
try {
  const thread = await invoke("start-thread",{projectId:project.id,harness:"codex",prompt:"Ship",designIds:[],threadMode:"local"});
  const url = "https://github.com/owner/repo/pull/42";
  run.input.onUpdate({type:"tool",tool:{id:"create",kind:"command",toolName:"Shell",title:"Create pull request",input:'BODY_FILE=/tmp/body.md\\ngh pr create --body-file "$BODY_FILE" && git status --short',status:"completed",exitCode:0,output:url}});
  if ((await service.readThread(project.id,thread.id)).pullRequests?.[0] !== url) throw Error("Live creation receipt was not linked");
  run.input.onUpdate({type:"message",id:"receipt",text:"Created pull request: "+url});
  const finished = Promise.withResolvers(); let doneEvents = 0;
  const unsubscribe = service.subscribe(event => {
    if (event.type !== "thread" || event.thread.id !== thread.id) return;
    if (event.thread.doneReason === "merged") doneEvents++;
    if (event.thread.status === "completed") finished.resolve();
  });
  run.complete(); await finished.promise;
  const check = () => invoke("auto-complete-threads",{projectId:project.id,preferences:defaultThreadCompletion});
  await check();
  if ((await store.readThread(project.id,thread.id)).doneAt) throw Error("Open PR closed its thread");
  await writeFile(process.env.TIDY_GH_PHASE,"offline\\n"); now += 60_001;
  let failed = false; try {await check();} catch {failed = true;}
  if (!failed || (await store.readThread(project.id,thread.id)).doneAt) throw Error("Unavailable status was silently accepted");
  await writeFile(process.env.TIDY_GH_PHASE,"merged\\n");
  await invoke("auto-complete-threads",{projectId:project.id,preferences:defaultThreadCompletion,force:true});
  const done = JSON.parse(await readFile(await store.storagePath(project.id,"threads",thread.id),"utf8"));
  if (done.doneReason !== "merged" || !done.doneAt || doneEvents !== 1) throw Error("Merged PR did not persist and publish Done");
  await invoke("set-thread-done",{projectId:project.id,threadId:thread.id,done:false});
  await check();
  const reopened = await store.readThread(project.id,thread.id);
  if (reopened.doneAt || !reopened.autoDoneAfter) throw Error("Old merge undid a manual reopen");
  unsubscribe();
  console.log(JSON.stringify({links:done.pullRequests,reason:done.doneReason,doneEvents,offlineReported:failed,reopened:!reopened.doneAt}));
} finally {await service.close();}
`;
      const child = Bun.spawn([process.execPath, "-e", script], {
        cwd: directory,
        env: {
          ...process.env,
          HOME: directory,
          PATH: join(directory, "system-bin"),
          TIDY_GH_PHASE: phase,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        links: ["https://github.com/owner/repo/pull/42"],
        reason: "merged",
        doneEvents: 1,
        offlineReported: true,
        reopened: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
