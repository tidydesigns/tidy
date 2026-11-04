import { expect, test } from "bun:test";

test("website consent defers the SDK, rejects stale receipts, isolates purposes and stops immediately", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const instances=[], events=[], requests=[];
    class SDK {
      init(key,config) { this.config=config; instances.push(this); if(config.capture_pageview)this.capture("$pageview"); }
      capture(event,properties={}) { const clean=this.config.before_send({uuid:crypto.randomUUID(),event,properties:{token:"fixture",distinct_id:"fixture",...properties}}); if(clean)events.push(clean); }
      set_config() {} opt_out_capturing(){this.stopped=true} stopSessionRecording(){} shutdown(){return Promise.resolve()}
    }
    mock.module("posthog-js/full/no-external",()=>({PostHog:SDK}));
    const storage=()=>({getItem(key){return this[key]??null},setItem(key,value){this[key]=value},removeItem(key){delete this[key]}});
    globalThis.localStorage=storage();globalThis.sessionStorage=storage();
    globalThis.window=new EventTarget();
    globalThis.location=new URL("https://site.example/?utm_source=launch&secret=private#private");
    const link={href:"https://app.example/login",isConnected:true};
    globalThis.document=Object.assign(new EventTarget(),{cookie:"",referrer:"https://search.example/private?secret=private",querySelectorAll(){return [link]}});
    const visitor="00000000-0000-4000-8000-000000000001";
    const receipt=()=>Response.json({id:crypto.randomUUID(),browserId:visitor,user:null});
    let resolveFirst;
    globalThis.fetch=async(input,options)=>{requests.push({input,options});if(requests.length===1)return new Promise(resolve=>resolveFirst=resolve);return receipt()};
    const {chooseConsent,ESSENTIAL_ONLY}=await import("@tidy/ui/privacy-consent");
    const analytics=await import("./lib/website-analytics");
    const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
    analytics.startWebsiteAnalytics();await settle();
    assert.equal(requests.length,0);assert.equal(instances.length,0);
    chooseConsent({analytics:true,replay:true,diagnostics:true});await settle();
    assert.equal(requests.length,1);assert.equal(instances.length,0);
    chooseConsent(ESSENTIAL_ONLY);
    assert.equal(instances.length,0);
    resolveFirst(receipt());await settle();await settle();
    assert.equal(instances.length,0);assert.equal(events.length,0);assert.equal(requests.length,2);
    chooseConsent({analytics:true,replay:false,diagnostics:false});await settle();
    assert.equal(instances.length,1);
    const first=instances[0];
    assert.equal(first.config.person_profiles,"never");assert.equal(first.config.cross_subdomain_cookie,false);
    assert.equal(first.config.disable_session_recording,true);
    assert.equal(first.config.capture_performance,false);assert.equal(first.config.capture_exceptions,false);
    assert.equal(first.config.capture_heatmaps,false);assert.equal(first.config.enable_recording_console_log,false);
    assert.equal(first.config.internal_or_test_user_hostname,null);assert.equal(first.config.opt_out_useragent_filter,false);
    assert.equal(first.config.logs.captureConsoleLogs,false);
    assert.equal(first.config.api_host,"https://site.example/api/t");
    assert.match(first.config.request_headers["x-tidy-receipt"],/^[a-f0-9-]{36}$/);
    assert.match(first.config.request_headers["x-tidy-consent"],/^8:[0-9]+:100$/);
    const beforeFocus=requests.length;
    window.dispatchEvent(new Event("focus"));await settle();
    assert.equal(instances.length,1);assert.equal(requests.length,beforeFocus);
    assert.ok(link.href.endsWith("#tidy_website="+visitor));
    analytics.captureWebsite("website_cta_clicked",{action:"download_mac",placement:"hero"});
    assert.equal(events.at(-1).event,"website_cta_clicked");assert.equal(events.at(-1).properties.website_visitor_id,visitor);
    assert.equal(events.at(-1).properties.utm_source,"launch");assert.ok(!JSON.stringify(events).includes("private"));
    const pageviews=events.filter(event=>event.event==="$pageview").length;
    chooseConsent({analytics:true,replay:true,diagnostics:false});await settle();
    assert.equal(events.filter(event=>event.event==="$pageview").length,pageviews);
    assert.equal(instances.at(-1).config.session_recording.sampleRate,0.2);
    const mask=instances.at(-1).config.session_recording.maskCapturedNetworkRequestFn;
    assert.equal(mask({method:"POST",name:"https://site.example/private?secret=private"}),null);
    assert.deepEqual(mask({name:"https://site.example/?secret=private#private"}),{name:"https://site.example/",startTime:0,duration:0,entryType:"navigation"});
    assert.equal(first.stopped,true);
    const count=events.length;first.capture("$autocapture");assert.equal(events.length,count);
    chooseConsent({analytics:false,replay:true,diagnostics:false});await settle();
    assert.equal(link.href,"https://app.example/login");
    assert.equal(instances.at(-1).config.autocapture,false);assert.equal(instances.at(-1).config.capture_pageview,false);
    instances.at(-1).capture("$snapshot",{$snapshot_data:[]});
    assert.equal(events.at(-1).event,"$snapshot");assert.equal(events.at(-1).properties.utm_source,undefined);
    assert.equal(events.at(-1).properties.website_visitor_id,undefined);
    const onlyReplay=events.length;
    analytics.captureWebsite("website_cta_clicked",{action:"download_mac"});assert.equal(events.length,onlyReplay);
    chooseConsent({analytics:false,replay:false,diagnostics:true});await settle();
    instances.at(-1).capture("$web_vitals",{$web_vitals_LCP_value:125});
    assert.equal(events.at(-1).event,"$web_vitals");
    const beforeWithdrawal=events.length;
    chooseConsent(ESSENTIAL_ONLY);
    instances.at(-1).capture("$web_vitals");assert.equal(events.length,beforeWithdrawal);
    await settle();assert.equal(instances.length,4);
    const beforeRegrant=events.filter(event=>event.event==="$pageview").length;
    chooseConsent({analytics:true,replay:false,diagnostics:false});await settle();
    assert.equal(events.filter(event=>event.event==="$pageview").length,beforeRegrant+1);
    chooseConsent(ESSENTIAL_ONLY);await settle();
    globalThis.fetch=async()=>new Response(null,{status:503});
    chooseConsent({analytics:true,replay:true,diagnostics:true});await settle();
    assert.equal(instances.length,5);assert.equal(analytics.websiteAnalyticsStatus(),"failed");
    let revoked=false;
    Object.defineProperty(document,"cookie",{get(){return ""},set(){throw new Error("blocked")},configurable:true});
    assert.equal(chooseConsent(ESSENTIAL_ONLY),false);
    globalThis.fetch=async(input,options)=>{revoked=JSON.parse(options.body).revoke===true;return Response.json({})};
    await analytics.withdrawWebsiteConsent();assert.equal(revoked,true);
    process.exit(0);
  `,
    ],
    {
      cwd: import.meta.dir + "/..",
      env: {
        ...process.env,
        NODE_ENV: "test",
        NEXT_PUBLIC_POSTHOG_ENABLED: "1",
        NEXT_PUBLIC_POSTHOG_KEY: "fixture",
        NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
        NEXT_PUBLIC_APP_URL: "https://app.example",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({
    code: 0,
    error: "",
  });
});
