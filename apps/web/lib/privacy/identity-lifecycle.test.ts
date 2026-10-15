import { expect, test } from "bun:test";

test("consent, login, account switching, withdrawal and cross-tab logout isolate identity", () => {
  // Isolate the SDK mock and browser globals from the rest of the test suite.
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const instances = [], sent = [];
    class SDK {
      init(key, config) { this.config=config; this.id=config.bootstrap.distinctID; instances.push(this); config.loaded(this); }
      register() {}
      identify(id, properties) { const previous=this.id;this.id=id; this.emit("$identify", {distinct_id:id,$anon_distinct_id:previous,$set:properties}); }
      emit(event, properties={}) { const data=this.config.before_send({event,properties:{distinct_id:this.id,...properties}});if(data)sent.push(data); }
      capture(event, properties) { this.emit(event,properties); }
      captureException() { this.emit("$exception"); }
      set_config() { if(this.throwsOnStop)throw new Error("Synthetic SDK shutdown failure"); }
      opt_out_capturing() { this.stopped=true; }
      stopSessionRecording() {}
      shutdown() { if(this.throwsOnStop)throw new Error("Synthetic SDK shutdown failure");return Promise.resolve(); }
    }
    mock.module("posthog-js/full/no-external",()=>({PostHog:SDK}));
    globalThis.window = new EventTarget();
    globalThis.document = Object.assign(new EventTarget(),{cookie:""});
    globalThis.location = new URL("https://app.example/privacy");
    globalThis.localStorage = {setItem(){},removeItem(){}};
    globalThis.sessionStorage = {removeItem(){}};
    let session=null, sessionRequests=0, previousUser=null, browserId=crypto.randomUUID(), receiptFails=false;
    const backend=async(input)=>{
      sessionRequests++;
      if(String(input)==="/api/auth/get-session") return Response.json(session);
      if(receiptFails)return new Response(null,{status:503});
      const user=session?.user??null;
      if(previousUser && previousUser!==user?.id)browserId=crypto.randomUUID();
      previousUser=user?.id??null;
      return Response.json({id:crypto.randomUUID(),browserId,user});
    };
    globalThis.fetch=backend;
    const {chooseConsent,ESSENTIAL_ONLY}=await import("./lib/privacy/consent");
    const {default:posthog,startPostHogConsent,captureForCurrentSession}=await import("./lib/posthog-client");
    const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
    startPostHogConsent();await settle();
    assert.equal(instances.length,0);assert.equal(sessionRequests,0);
    chooseConsent({analytics:false,replay:true,diagnostics:false});await settle();
    assert.equal(instances.length,1);assert.equal(sent.length,0);
    assert.equal(instances[0].config.api_host,"https://app.example/api/t");
    assert.equal(instances[0].config.ui_host,"https://eu.posthog.com");
    const anonymous=instances[0].id;
    session={user:{id:"account-a",email:"a@example.test"}};
    posthog.identify("account-a",{email:"a@example.test",name:"do not send"});await settle();
    assert.equal(sent.at(-1).properties.$anon_distinct_id,anonymous);
    assert.deepEqual(sent.at(-1).properties.$set,{email:"a@example.test"});
    posthog.capture("$pageview");assert.equal(sent.length,1);
    posthog.capture("$snapshot");assert.equal(sent.at(-1).properties.distinct_id,"account-a");
    const first=instances[0];
    session={user:{id:"account-b",email:"b@example.test"}};
    posthog.identify("account-b",{email:"b@example.test"});await settle();
    assert.equal(first.stopped,true);assert.equal(instances.length,3);
    assert.equal(sent.at(-1).properties.distinct_id,"account-b");
    assert.notEqual(sent.at(-1).properties.$anon_distinct_id,"account-a");
    const count=sent.length;first.emit("$snapshot");assert.equal(sent.length,count);
    instances.at(-1).throwsOnStop=true;
    chooseConsent(ESSENTIAL_ONLY);await settle();
    session={user:{id:"account-c",email:"c@example.test"}};
    posthog.identify("account-c",{email:"c@example.test"});await settle();
    assert.equal(sent.length,count);assert.equal(instances.length,3);
    chooseConsent({analytics:false,replay:true,diagnostics:false});await settle();
    assert.equal(sent.at(-1).properties.$set.email,"c@example.test");
    const beforeLogout=sent.length;
    session=null;
    const change=new Event("storage");Object.defineProperty(change,"key",{value:"tidy-telemetry-auth-change"});window.dispatchEvent(change);await settle();
    assert.equal(sent.length,beforeLogout);assert.equal(instances.at(-2).stopped,true);
    posthog.capture("$snapshot");assert.notEqual(sent.at(-1).properties.distinct_id,"account-c");
    assert.equal(sent.at(-1).properties.$process_person_profile,false);
    let resolveSession;
    globalThis.fetch=()=>new Promise(resolve=>{resolveSession=resolve});
    const beforeFocus=sent.length;
    window.dispatchEvent(new Event("focus"));
    posthog.capture("$snapshot");assert.equal(sent.length,beforeFocus);
    await settle();
    session={user:{id:"account-d",email:"d@example.test"}};
    globalThis.fetch=backend;
    resolveSession(Response.json({id:crypto.randomUUID(),browserId:crypto.randomUUID(),user:session.user}));await settle();
    assert.equal(sent.at(-1).properties.distinct_id,"account-d");
    assert.deepEqual(sent.at(-1).properties.$set,{email:"d@example.test"});
    chooseConsent({analytics:true,replay:true,diagnostics:true});await settle();
    globalThis.fetch=()=>new Promise(resolve=>{resolveSession=resolve});
    window.dispatchEvent(new Event("focus"));
    const beforeDeferred=sent.length;
    posthog.capture("survey shown",{$survey_id:"synthetic-survey"});
    posthog.captureException(new Error("private error"));
    assert.equal(sent.length,beforeDeferred);await settle();
    globalThis.fetch=backend;
    resolveSession(Response.json({id:crypto.randomUUID(),browserId:crypto.randomUUID(),user:session.user}));await settle();
    assert.deepEqual(sent.slice(-2).map(event=>event.event),["survey shown","$exception"]);
    // Model support completing after a delayed POST, just as the feedback form does.
    let completeSupport, supportDeliveries=0;
    const beginFeedback=()=>{
      const capture=captureForCurrentSession();
      return new Promise(resolve=>{completeSupport=resolve}).then(response=>{
        if(response.ok){
          supportDeliveries++;
          capture("survey sent",{$survey_id:"synthetic-survey",$survey_response:"private feedback"});
        }
      });
    };
    const surveyCount=()=>sent.filter(event=>event.event==="survey sent").length;
    let beforeSurvey=surveyCount();
    let feedback=beginFeedback();
    completeSupport({ok:true});await feedback;
    assert.equal(surveyCount(),beforeSurvey+1);
    assert.equal(sent.at(-1).properties.distinct_id,"account-d");
    beforeSurvey=surveyCount();
    feedback=beginFeedback();
    session={user:{id:"account-e",email:"e@example.test"}};
    posthog.identify("account-e",{email:"e@example.test"});await settle();
    completeSupport({ok:true});await feedback;
    assert.equal(surveyCount(),beforeSurvey);
    feedback=beginFeedback();
    chooseConsent(ESSENTIAL_ONLY);await settle();
    chooseConsent({analytics:true,replay:true,diagnostics:true});await settle();
    completeSupport({ok:true});await feedback;
    assert.equal(surveyCount(),beforeSurvey);
    feedback=beginFeedback();
    session=null;
    window.dispatchEvent(change);await settle();
    completeSupport({ok:true});await feedback;
    assert.equal(surveyCount(),beforeSurvey);
    chooseConsent(ESSENTIAL_ONLY);await settle();
    feedback=beginFeedback();
    chooseConsent({analytics:true,replay:true,diagnostics:true});await settle();
    completeSupport({ok:true});await feedback;
    assert.equal(surveyCount(),beforeSurvey);
    assert.equal(supportDeliveries,5);
    globalThis.fetch=()=>new Promise(resolve=>{resolveSession=resolve});
    window.dispatchEvent(new Event("focus"));await settle();
    posthog.capture("survey sent",{$survey_id:"synthetic-survey",$survey_response:"withdrawn feedback"});
    const beforeWithdrawal=sent.length;
    chooseConsent(ESSENTIAL_ONLY);
    globalThis.fetch=backend;
    resolveSession(Response.json({id:crypto.randomUUID(),browserId:crypto.randomUUID(),user:session?.user??null}));await settle();
    assert.equal(sent.length,beforeWithdrawal);
    chooseConsent(ESSENTIAL_ONLY);await settle();
    const beforeFailure=instances.length;
    receiptFails=true;
    chooseConsent({analytics:true,replay:true,diagnostics:true});await settle();
    assert.equal(instances.length,beforeFailure);
    chooseConsent(ESSENTIAL_ONLY);await settle();
    let revoked=false;
    globalThis.fetch=async(input,options)=>{revoked=JSON.parse(options.body).revoke===true;return Response.json({})};
    Object.defineProperty(document,"cookie",{get(){return ""},set(){throw new Error("blocked")},configurable:true});
    assert.equal(chooseConsent(ESSENTIAL_ONLY),false);
    const {recordBrowserWithdrawal}=await import("./lib/privacy/receipt-client");
    await recordBrowserWithdrawal();assert.equal(revoked,true);
    assert.equal(instances.length,beforeFailure);
    process.exit(0);
  `,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        NEXT_PUBLIC_POSTHOG_ENABLED: "1",
        NEXT_PUBLIC_POSTHOG_KEY: "synthetic-key",
        NEXT_PUBLIC_POSTHOG_HOST: "https://t.tidydesign.co",
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
