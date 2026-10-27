import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("release snapshots separate installer and update packages for stable and beta releases without claiming installations", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `
    import {mock,expect} from 'bun:test';
    mock.module('server-only',()=>({}));
    const writes=[];
    mock.module('@/lib/db',()=>({db:{query:async(sql,values)=>{
      if(sql.includes('insert into "desktopDownloadSnapshot"')) writes.push(values);
      return {rows:[],rowCount:0};
    }}}));
    const {snapshotDownloads}=await import('./lib/analytics/maintenance');
    const release=(version,ids,draft=false)=>({tag_name:'desktop-v'+version,draft,assets:[
      {id:ids,name:'Tidy-'+version+'-mac-arm64.dmg',download_count:7},
      {id:ids+1,name:'Tidy-'+version+'-mac-arm64.zip',download_count:11},
      {id:ids+2,name:'desktop-update-arm64.json',download_count:15}
    ]});
    let requests=0;
    await snapshotDownloads(async(url,options)=>{
      requests++;
      expect(url).toBe('https://api.github.com/repos/tidydesigns/tidy/releases?per_page=100&page=1');
      expect(new Headers(options.headers).has('authorization')).toBe(false);
      expect(options.redirect).toBe('error');
      return Response.json([release('1.0.0',1),release('1.1.0-beta.1',4),release('2.0.0',7,true),{...release('3.0.0',10),tag_name:'web-v3.0.0'}]);
    });
    expect(requests).toBe(1);
    expect(writes).toEqual([
      [1,'desktop-v1.0.0','installer',7],[2,'desktop-v1.0.0','update',11],
      [4,'desktop-v1.1.0-beta.1','installer',7],[5,'desktop-v1.1.0-beta.1','update',11],
    ]);
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
