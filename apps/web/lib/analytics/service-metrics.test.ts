import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("default service monitoring is separate from optional consent, sampled, bounded and deferred until after the response", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
    import {mock,expect} from 'bun:test';
    mock.module('server-only',()=>({}));
    let storage='1',service,sampled=true;
    const tasks=[],writes=[];
    mock.module('./lib/analytics/config',()=>({analyticsSetting:name=>({DESKTOP_ANALYTICS_STORAGE_ENABLED:storage,DESKTOP_SERVICE_METRICS_ENABLED:service,DESKTOP_ANALYTICS_ENABLED:'0'})[name]}));
    mock.module('next/server',()=>({after:task=>tasks.push(task)}));
    mock.module('./lib/diagnostic-sampling',()=>({sampleDiagnostics:rate=>{expect(rate).toBe(0.1);return sampled;}}));
    mock.module('@/lib/db',()=>({db:{query:async (sql,values)=>{writes.push({sql,values});return {rows:[]};}}}));
    const {withDesktopServiceMetrics,recordDesktopServiceMetric}=await import('./lib/analytics/service-metrics');
    const request=new Request('https://example.test/api/desktop/files/PRIVATE-FILE?revision=PRIVATE-REVISION',{method:'POST',headers:{authorization:'Bearer PRIVATE-TOKEN'},body:'PRIVATE-DESIGN'});
    const response=new Response(null,{status:503});
    expect(await withDesktopServiceMetrics(request,async()=>response)).toBe(response);
    expect(tasks).toHaveLength(1);expect(writes).toHaveLength(0);
    await tasks.shift()();
    expect(writes).toHaveLength(1);expect(JSON.stringify(writes)).not.toContain('PRIVATE');
    expect(writes[0].values.slice(1,3)).toEqual(['file_commit','unavailable']);
    await expect(recordDesktopServiceMetric({day:'2026-10-26',operation:'account',outcome:'success',latency:'under_1s',email:'PRIVATE-EMAIL'})).rejects.toThrow();
    sampled=false;await withDesktopServiceMetrics(request,async()=>response);expect(tasks).toHaveLength(0);
    sampled=true;service='0';await withDesktopServiceMetrics(request,async()=>response);expect(tasks).toHaveLength(0);
    service=undefined;storage='0';await withDesktopServiceMetrics(request,async()=>response);expect(tasks).toHaveLength(0);
    storage='1';await withDesktopServiceMetrics(request,async()=>response);expect(tasks).toHaveLength(1);
    service='0';await tasks.shift()();expect(writes).toHaveLength(1);
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
