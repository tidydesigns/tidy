import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("real PostHog transport receives aggregates only, with sparse returns suppressed and no identities", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
    import {mock,expect} from 'bun:test';
    import {gunzipSync} from 'node:zlib';
    mock.module('server-only',()=>({}));
    process.env.DESKTOP_ANALYTICS_POSTHOG_AGGREGATES='1';
    process.env.NEXT_PUBLIC_POSTHOG_KEY='fixture-public-token';
    process.env.NEXT_PUBLIC_POSTHOG_HOST='https://eu.i.posthog.com';
    const cohort=new Date(Date.now()-40*86_400_000).toISOString().slice(0,10);
    mock.module('@/lib/db',()=>({db:{query:async sql=>{
      if(sql.includes('from "productAnalyticsExport"'))return {rows:[],rowCount:0};
      if(sql.includes('as installations'))return {rows:[{surface:'desktop',name:'harness_turn_started',harness:'codex',events:20,installations:12,subject:'SECRET-INSTALLATION',email:'SECRET-EMAIL'},{surface:'desktop',name:'design_file_created',harness:null,events:1,installations:1}]};
      if(sql.includes('with active as'))return {rows:[{day:cohort,surface:sql.includes('linked_account')?'linked_account':'desktop',size:12,d1:2,d7:12,d30:0}]};
      return {rows:[],rowCount:1};
    }}}));
    const outgoing=[];
    globalThis.fetch=async (url,init)=>{expect(String(url)).toStartWith('https://eu.i.posthog.com/');const bytes=Buffer.from(await new Response(init.body).arrayBuffer());const text=bytes[0]===31&&bytes[1]===139?gunzipSync(bytes).toString():bytes.toString();outgoing.push(JSON.parse(text));return Response.json({status:1});};
    const {exportProductAggregates}=await import('./lib/analytics/maintenance.ts');
    await exportProductAggregates();
    const text=JSON.stringify(outgoing);
    expect(text).not.toContain('SECRET-');
    expect(text).not.toContain('design_file_created');
    const events=outgoing.flatMap(value=>value.batch??[value]);
    expect(events.some(value=>value.event==='product_usage_aggregate')).toBe(true);
    const retention=events.find(value=>value.event==='product_retention_aggregate');
    expect(retention.properties.d1).toBeNull();
    expect(retention.properties.d7).toBe(12);
    expect(retention.properties.$process_person_profile).toBe(false);
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
