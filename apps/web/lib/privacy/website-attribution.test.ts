import { expect, test } from "bun:test";

test("attribution waits for app consent and is cleared by expiry, receiving-tab logout and account changes", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    const sent=[];
    class SDK {
      init(key,config){this.config=config;this.id=config.bootstrap.distinctID;config.loaded(this)}
      register(){} set_config(){} opt_out_capturing(){} stopSessionRecording(){} shutdown(){return Promise.resolve()}
      identify(id,props){this.id=id;this.capture("$identify",{$set:props})}
      capture(event,props={}){const clean=this.config.before_send({event,properties:{distinct_id:this.id,...props}});if(clean)sent.push(clean)}
    }
    mock.module("posthog-js/full/no-external",()=>({PostHog:SDK}));
    let storageWrites=0, storageReads=0;
    const storage=()=>({getItem(key){storageReads++;return this[key]??null},setItem(key,value){storageWrites++;this[key]=value},removeItem(key){delete this[key]}});
    globalThis.localStorage=storage();globalThis.sessionStorage=storage();
    globalThis.window=new EventTarget();globalThis.document=Object.assign(new EventTarget(),{cookie:""});
    const id="00000000-0000-4000-8000-000000000001";
    globalThis.location=new URL("https://app.example/login#tidy_website="+id);
    globalThis.history={state:null,replaceState(state,unused,path){globalThis.location=new URL(path,"https://app.example")}};
    let user=null;
    globalThis.fetch=async()=>Response.json({id:crypto.randomUUID(),browserId:crypto.randomUUID(),user});
    const attribution=await import("@tidy/ui/website-attribution");
    attribution.readWebsiteAttribution();
    assert.equal(location.hash,"");assert.equal(storageWrites,0);assert.equal(storageReads,0);
    assert.equal(attribution.websiteAttribution(false),undefined);
    assert.equal(storageWrites,0);assert.equal(storageReads,0);
    const {chooseConsent,ESSENTIAL_ONLY}=await import("./lib/privacy/consent");
    const {default:posthog,startPostHogConsent}=await import("./lib/posthog-client");
    const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
    startPostHogConsent();await settle();
    chooseConsent({analytics:true,replay:false,diagnostics:false});await settle();
    posthog.capture("signup_started",{signup_method:"email"});
    assert.equal(sent.at(-1).properties.website_visitor_id,id);
    // Expired/deleted consent must end an already activated attribution grant.
    document.cookie="";window.dispatchEvent(new Event("focus"));await settle();
    chooseConsent({analytics:true,replay:false,diagnostics:false});await settle();
    posthog.capture("signup_started");assert.equal(sent.at(-1).properties.website_visitor_id,undefined);
    location.hash="tidy_website="+id;attribution.readWebsiteAttribution();
    user={id:"account-a",email:"a@example.test"};posthog.identify(user.id,user);await settle();
    posthog.capture("signup_started");assert.equal(sent.at(-1).properties.website_visitor_id,id);
    user={id:"account-b",email:"b@example.test"};window.dispatchEvent(new Event("focus"));await settle();
    posthog.capture("signup_started");assert.equal(sent.at(-1).properties.website_visitor_id,undefined);
    location.hash="tidy_website="+id;attribution.readWebsiteAttribution();
    posthog.capture("signup_started");assert.equal(sent.at(-1).properties.website_visitor_id,id);
    user=null;
    const change=new Event("storage");Object.defineProperty(change,"key",{value:"tidy-telemetry-auth-change"});window.dispatchEvent(change);await settle();
    posthog.capture("signup_started");assert.equal(sent.at(-1).properties.website_visitor_id,undefined);
    location.hash="tidy_website="+id;attribution.readWebsiteAttribution();
    assert.equal(attribution.websiteAttribution(true),id);
    chooseConsent(ESSENTIAL_ONLY);await settle();
    chooseConsent({analytics:true,replay:false,diagnostics:false});await settle();
    posthog.capture("signup_started");assert.equal(sent.at(-1).properties.website_visitor_id,undefined);
    location.hash="tidy_website="+id;attribution.readWebsiteAttribution();
    const now=Date.now();Date.now=()=>now+31*60_000;
    assert.equal(attribution.websiteAttribution(true),undefined);
    process.exit(0);
  `,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        NEXT_PUBLIC_POSTHOG_ENABLED: "1",
        NEXT_PUBLIC_POSTHOG_KEY: "fixture",
        NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
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
