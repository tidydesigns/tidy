import { expect, test } from "bun:test";

for (const scenario of ["failed-tile", "text-tile", "insight-with-error"] as const) {
  test(`dashboard setup handles ${scenario} without creating duplicate insights`, () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
        import assert from "node:assert/strict";
        import { websiteDashboard } from "./lib/analytics/website-dashboard";
        process.argv=["bun","setup-website-dashboard.ts","--apply","--project=1","--host=https://eu.posthog.com"];
        const scenario=${JSON.stringify(scenario)};
        const existing=websiteDashboard.insights.map(insight=>({insight:{name:insight.name}}));
        const extra=scenario==="failed-tile"?{id:9,error:"Could not serialize"}:scenario==="text-tile"?{id:9,text:"Notes"}:{...existing[0],error:"Nonblocking metadata"};
        const requests=[];
        globalThis.fetch=async(url,options)=>{
          requests.push({url,method:options.method});
          assert.equal(options.method,"GET","No insight may be created when all tiles exist or a tile cannot be read");
          return Response.json(url.includes("?search=")?{results:[{id:1,name:websiteDashboard.name}],next:null}:{id:1,tiles:[...(scenario==="failed-tile"?existing.slice(1):existing),extra]});
        };
        let error;
        try {await import("./scripts/setup-website-dashboard")} catch(cause){error=cause}
        assert.equal(requests.length,2);
        if(scenario==="failed-tile")assert.match(error?.message,/tile failed to serialize/);
        else assert.equal(error,undefined);
        `,
      ],
      {
        cwd: import.meta.dir + "/..",
        env: { ...process.env, POSTHOG_API_KEY: "fixture" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({
      code: 0,
      error: "",
    });
  });
}
