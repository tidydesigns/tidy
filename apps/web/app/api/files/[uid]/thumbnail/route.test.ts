import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("thumbnail routes establish session identity and reject foreign origins before shared services", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    let session=null; const calls=[];
    mock.module("@/lib/auth",()=>({auth:{api:{getSession:async()=>session}}}));
    mock.module("@/lib/design/thumbnail-service",()=>({
      thumbnailResponseForUser:async (...args)=>{calls.push(["read",args[0],args[1]]); return new Response("private");},
      uploadThumbnailForUser:async (...args)=>{calls.push(["write",args[0],args[1]]); return new Response(null,{status:204});},
    }));
    const {GET,POST}=await import("./app/api/files/[uid]/thumbnail/route.ts");
    const context={params:Promise.resolve({uid:"selected-file"})};
    const request=(origin="http://localhost:3000")=>new Request("http://localhost:3000/api/files/selected-file/thumbnail",{method:"POST",headers:{origin},body:"png"});
    expect((await GET(new Request(request().url),context)).status).toBe(401);
    expect((await POST(request(),context)).status).toBe(401);
    session={user:{id:"session-actor"}};
    expect((await POST(request("https://foreign.example"),context)).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await POST(request(),context)).status).toBe(204);
    expect(await (await GET(new Request(request().url),context)).text()).toBe("private");
    expect(calls).toEqual([["write","session-actor","selected-file"],["read","session-actor","selected-file"]]);
    console.log("PASS");
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../../../../.."),
      env: { ...process.env, NODE_ENV: "test", BETTER_AUTH_URL: "http://localhost:3000" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString()).toContain("PASS");
});
