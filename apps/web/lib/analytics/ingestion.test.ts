import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("native HTTP boundary rejects ambient authority, extra data and oversized bodies; kill switch preserves erasure", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
    import {mock,expect} from 'bun:test';
    mock.module('server-only',()=>({}));
    let enabled=true,storage=true,accepted=0,erased=0,limited=false,lastIdentity,limitedIdentity;
    class PersonalBudgetError extends Error { status=429; }
    mock.module('@/lib/security/personal-budget',()=>({PersonalBudgetError,reservePersonalAttempts:async(_kind,identity)=>{lastIdentity=identity;if(limited||identity===limitedIdentity)throw new PersonalBudgetError();}}));
    mock.module('@/lib/analytics/store',()=>({
      analyticsStorageEnabled:()=>storage,analyticsEnabled:()=>enabled,
      AnalyticsAccessError:class extends Error{},AnalyticsRevisionError:class extends Error{},AnalyticsExportRateError:class extends Error{},
      nativeConsent:async()=>({}),captureNative:async()=>{accepted++;},
      eraseNative:async()=>{erased++;},createAnalyticsLink:async()=>'',exportNative:async()=>({})
    }));
    const {POST}=await import('./app/api/telemetry/desktop/[action]/route.ts');
    const token='a'.repeat(64);
    const request=(body,headers={})=>new Request('https://app.example.test/api/telemetry/desktop/events',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,...headers},body:JSON.stringify(body)});
    const invoke=(r,action='events')=>POST(r,{params:Promise.resolve({action})});
    const event={id:crypto.randomUUID(),at:new Date().toISOString(),release:'0.1.0-beta.1',platform:'darwin',arch:'arm64',event:{name:'product_active_day'}};
    expect((await invoke(request({revision:1,events:[event]}))).status).toBe(204);
    expect(accepted).toBe(1);
    expect((await invoke(request({revision:1,events:[event]},{origin:'https://evil.example'}))).status).toBe(403);
    expect((await invoke(request({revision:1,events:[event]},{cookie:'session=anything'}))).status).toBe(403);
    expect((await invoke(request({revision:1,events:[{...event,event:{name:'product_active_day',prompt:'SECRET-CANARY'}}]}))).status).toBe(400);
    expect((await invoke(request({revision:1,events:[event],accountId:'someone-else'}))).status).toBe(400);
    expect((await invoke(request({huge:'x'.repeat(40_000)}))).status).toBe(413);
    expect(accepted).toBe(1);
    expect((await invoke(new Request('https://app.example.test/api/telemetry/desktop/events',{method:'POST',headers:{authorization:'Bearer '+token},body:'invalid-json'}))).status).toBe(400);
    limited=true;
    const denied=await invoke(request({revision:1,events:[event]}));
    expect(denied.status).toBe(429);expect(denied.headers.get('retry-after')).toBe('60');
    limited=false;
    limitedIdentity=lastIdentity;
    expect((await invoke(request({revision:1,events:[event]}))).status).toBe(429);
    expect((await invoke(request({notice:'anything'}),'receipt')).status).toBe(429);
    for(const action of ['status','export','erase','unlink']) {
      expect((await invoke(request({}),action)).status).toBe(action==='erase'||action==='unlink'?204:200);
    }
    limitedIdentity=undefined;
    erased=0;
    enabled=false;
    expect((await invoke(request({revision:1,events:[event]}))).status).toBe(503);
    expect((await invoke(request({}),'erase')).status).toBe(204);
    expect(erased).toBe(1);
    storage=false;
    expect((await invoke(request({}),'erase')).status).toBe(503);
    console.log('PASS');
  `,
    ],
    {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("PASS");
});
