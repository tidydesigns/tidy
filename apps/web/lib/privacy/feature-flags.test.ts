import { expect, test } from "bun:test";

test("UI flags fail closed across consent, SDK errors, refreshes and account changes", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const instances=[];
    class SDK {
      init(key, config) { this.config=config; instances.push(this); config.loaded(this); }
      register() {}
      identify() {}
      on(event, handler) { this.reload=handler; return ()=>{}; }
      onFeatureFlags(handler) { this.flags=handler; return ()=>{}; }
      set_config() {}
      opt_out_capturing() {}
      stopSessionRecording() {}
      shutdown() { return Promise.resolve(); }
      resolve(values, errorsLoading=false) { this.flags?.(Object.keys(values),values,{errorsLoading}); }
    }
    mock.module("posthog-js/full/no-external",()=>({PostHog:SDK}));
    globalThis.window=new EventTarget();
    globalThis.document=Object.assign(new EventTarget(),{cookie:""});
    globalThis.location=new URL("https://app.example/mcp");
    globalThis.localStorage={setItem(){},removeItem(){}};
    globalThis.sessionStorage={removeItem(){}};
    let user={id:"account-a",email:"a@example.test"}, failReceipt=false;
    globalThis.fetch=async()=>failReceipt ? new Response(null,{status:503}) :
      Response.json({id:crypto.randomUUID(),browserId:crypto.randomUUID(),user});
    const {chooseConsent,ESSENTIAL_ONLY,consentCookie}=await import("./lib/privacy/consent");
    const {default:posthog,startPostHogConsent}=await import("./lib/posthog-client");
    const {featureFlagEnabled,subscribeFeatureFlags}=await import("./lib/feature-flags");
    const keys=["mcp-pi-gemini","github-connector","settings-connectors"];
    const enabled=Object.fromEntries(keys.map(key=>[key,true]));
    const closed=()=>keys.forEach(key=>assert.equal(featureFlagEnabled(key),false));
    const opened=()=>keys.forEach(key=>assert.equal(featureFlagEnabled(key),true));
    const settle=()=>new Promise(resolve=>setTimeout(resolve,15));
    let changes=0; const unsubscribe=subscribeFeatureFlags(()=>changes++);
    startPostHogConsent(); await settle(); closed(); assert.equal(instances.length,0);
    chooseConsent(ESSENTIAL_ONLY); await settle(); closed(); assert.equal(instances.length,0);
    chooseConsent({analytics:false,replay:true,diagnostics:true}); await settle();
    closed(); assert.equal(instances.at(-1).config.advanced_disable_feature_flags,true);
    assert.equal(instances.at(-1).flags,undefined);
    chooseConsent({analytics:true,replay:false,diagnostics:false}); await settle();
    const first=instances.at(-1); closed();
    assert.equal(first.config.advanced_disable_feature_flags,false);
    first.resolve(enabled); opened(); assert.ok(changes>0);
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED="0";closed();
    process.env.NEXT_PUBLIC_POSTHOG_ENABLED="1";opened();
    for(const value of [false,undefined,"true","enabled",1]) {
      first.resolve(Object.fromEntries(keys.map(key=>[key,value]))); closed();
    }
    first.resolve({}); closed(); first.resolve(enabled); opened();
    first.resolve(enabled,true); closed(); first.resolve(enabled); opened();
    first.reload(); closed(); first.resolve(enabled); opened();
    chooseConsent(ESSENTIAL_ONLY); closed(); first.resolve(enabled); closed(); await settle();
    chooseConsent({analytics:true,replay:false,diagnostics:false}); await settle();
    closed(); first.resolve(enabled); closed();
    const second=instances.at(-1); second.resolve(enabled); opened();
    user={id:"account-b",email:"b@example.test"}; posthog.identify(user.id,{email:user.email});
    closed(); second.resolve(enabled); closed(); await settle(); closed();
    instances.at(-1).resolve(enabled); opened();
    user=null;
    const logout=new Event("storage");Object.defineProperty(logout,"key",{value:"tidy-telemetry-auth-change"});
    window.dispatchEvent(logout);closed();await settle();closed();
    instances.at(-1).resolve(enabled);opened();
    failReceipt=true;window.dispatchEvent(new Event("focus"));closed();await settle();closed();
    chooseConsent(ESSENTIAL_ONLY);await settle();
    failReceipt=false;chooseConsent({analytics:true,replay:false,diagnostics:false});await settle();
    instances.at(-1).resolve(enabled);opened();
    document.cookie=consentCookie({analytics:true,replay:false,diagnostics:false},Date.now()-181*86400000);
    closed();window.dispatchEvent(new Event("focus"));await settle();closed();
    const before=changes;unsubscribe();chooseConsent(ESSENTIAL_ONLY);assert.equal(changes,before);
    process.exit(0);
    `,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        NEXT_PUBLIC_POSTHOG_ENABLED: "1",
        NEXT_PUBLIC_POSTHOG_KEY: "synthetic-key",
        NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({
    code: 0,
    error: "",
  });
});
