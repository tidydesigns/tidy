import { expect, test } from "bun:test";

test("functional flags work with absent, rejected and expired consent while browser tracking stays off", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    mock.module("server-only",()=>({}));
    mock.module("posthog-js/full/no-external",()=>({PostHog:class {constructor(){throw new Error("Browser SDK must stay off")}}}));
    globalThis.window=new EventTarget();
    globalThis.document=Object.assign(new EventTarget(),{cookie:""});
    globalThis.location=new URL("https://app.example/settings");
    globalThis.localStorage={setItem(){},removeItem(){}};
    globalThis.sessionStorage={removeItem(){}};
    let evaluations=0, captures=0;
    globalThis.fetch=async(input)=>{
      if(String(input).includes("/flags/")) {
        evaluations++;
        return Response.json({errorsWhileComputingFlags:false,flags:{"github-connector":{enabled:true,variant:null}}});
      }
      if(String(input)==="/api/privacy/consent")return Response.json({id:crypto.randomUUID(),browserId:crypto.randomUUID(),user:null});
      captures++;throw new Error("Unexpected telemetry request");
    };
    const {chooseConsent,consentCookie,ESSENTIAL_ONLY,CONSENT_MAX_AGE}=await import("./lib/privacy/consent");
    const {evaluateFunctionalFlags}=await import("./lib/functional-feature-flags");
    const {FeatureFlagsProvider,useFeatureFlag}=await import("./lib/use-feature-flag");
    const {default:posthog,startPostHogConsent,consentConfig}=await import("./lib/posthog-client");
    const {redactTelemetry}=await import("./lib/privacy/telemetry");
    const all={analytics:true,replay:true,diagnostics:true};
    const Probe=()=>createElement("span",null,String(useFeatureFlag("github-connector")));
    startPostHogConsent();
    for(const cookie of ["",consentCookie(ESSENTIAL_ONLY),consentCookie(all,Date.now()-(CONSENT_MAX_AGE+1)*1000)]) {
      document.cookie=cookie;
      window.dispatchEvent(new Event("tidy-consent-change"));
      const flags=await evaluateFunctionalFlags({key:"synthetic-key",host:"https://eu.i.posthog.com"});
      assert.equal(renderToStaticMarkup(createElement(FeatureFlagsProvider,{flags},createElement(Probe))),"<span>true</span>");
      posthog.capture("$pageview");posthog.captureException(new Error("synthetic"));
    }
    assert.equal(captures,0);assert.equal(evaluations,3);
    chooseConsent(ESSENTIAL_ONLY);
    assert.equal(consentConfig({...all,version:4,at:Date.now()}).advanced_disable_feature_flags,true);
    assert.equal(redactTelemetry({event:"$feature_flag_called",properties:{$feature_flag:"github-connector"}},all,location.href),null);
    process.exit(0);
  `,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        NEXT_PUBLIC_POSTHOG_ENABLED: "0",
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
