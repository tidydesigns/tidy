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

type BrowserState = { cookie: string; attribution: string | null };

// Each call starts a new document AND fresh module graph. Only browser storage
// and the consent cookie cross reloads, just as in a receiving browser tab.
function browserDocument(source: string, previous?: BrowserState): BrowserState {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      import assert from "node:assert/strict";
      import { mock } from "bun:test";
      const state = JSON.parse(process.env.TEST_BROWSER_STATE);
      const key = "tidy-website-attribution";
      const id = "00000000-0000-4000-8000-000000000001";
      const sent = [], initialized = [];
      let reads = 0, writes = 0, user = null;
      class SDK {
        init(key, config) {
          this.config = config;
          this.id = config.bootstrap.distinctID;
          initialized.push(sessionStorage["tidy-website-attribution"] ?? null);
          config.loaded(this);
        }
        register() {} set_config() {} opt_out_capturing() {} stopSessionRecording() {}
        shutdown() { return Promise.resolve(); }
        identify(id, props) { this.id = id; this.capture("$identify", { $set: props }); }
        capture(event, properties = {}) {
          const clean = this.config.before_send({event, properties: {distinct_id: this.id, ...properties}});
          if (clean) sent.push(clean);
        }
      }
      mock.module("posthog-js/full/no-external", () => ({ PostHog: SDK }));
      function storage() {
        return {
          getItem(key) { reads++; return this[key] ?? null; },
          setItem(key, value) { writes++; this[key] = value; },
          removeItem(key) { delete this[key]; },
        };
      }
      globalThis.localStorage = storage();
      globalThis.sessionStorage = storage();
      if (state.attribution !== null) sessionStorage[key] = state.attribution;
      globalThis.window = new EventTarget();
      globalThis.document = Object.assign(new EventTarget(), { cookie: state.cookie });
      globalThis.location = new URL("https://app.example/login");
      globalThis.history = {state: null, replaceState(state, unused, path) {
        globalThis.location = new URL(path, "https://app.example");
      }};
      globalThis.fetch = async () => Response.json({id: crypto.randomUUID(), browserId: crypto.randomUUID(), user});
      const attribution = await import("@tidy/ui/website-attribution");
      const { chooseConsent, consentCookie, CONSENT_MAX_AGE, ESSENTIAL_ONLY } = await import("./lib/privacy/consent");
      const {default: posthog, startPostHogConsent} = await import("./lib/posthog-client");
      const allow = {analytics: true, replay: false, diagnostics: false};
      const settle = () => new Promise(resolve => setTimeout(resolve, 20));
      const freshFragment = () => {
        location.hash = "tidy_website=" + id;
        attribution.readWebsiteAttribution();
        assert.equal(location.hash, "");
      };
      const visitor = () => { posthog.capture("signup_started"); return sent.at(-1)?.properties.website_visitor_id; };
      const authChange = () => {
        const event = new Event("storage");
        Object.defineProperty(event, "key", {value: "tidy-telemetry-auth-change"});
        window.dispatchEvent(event);
      };
      ${source}
      console.log(JSON.stringify({cookie: document.cookie, attribution: sessionStorage[key] ?? null}));
      process.exit(0);
      `,
    ],
    {
      cwd: import.meta.dir + "/../..",
      env: {
        ...process.env,
        TEST_BROWSER_STATE: JSON.stringify(previous ?? { cookie: "", attribution: null }),
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
  return JSON.parse(result.stdout.toString());
}

function authenticatedDocument() {
  return browserDocument(`
    document.cookie = consentCookie(allow);
    user = {id: "account-a", email: "a@example.test"};
    freshFragment();
    assert.equal(reads, 0); assert.equal(writes, 0);
    startPostHogConsent(); await settle();
    // Persistence must precede init, even when no pageview/capture has happened.
    assert.equal(JSON.parse(initialized[0]).accountId, user.id);
    assert.equal(visitor(), id);
  `);
}

test("authenticated attribution survives same-account document reloads and is bound before SDK init", () => {
  const first = authenticatedDocument();
  const second = browserDocument(
    `
    user = {id: "account-a", email: "a@example.test"};
    startPostHogConsent(); await settle();
    assert.equal(JSON.parse(initialized[0]).accountId, user.id);
    assert.equal(visitor(), id);
  `,
    first,
  );
  expect(second.attribution).toEqual(first.attribution);
});

for (const nextAccount of ["account-b", null]) {
  test(`authenticated attribution cannot cross a document reload to ${nextAccount ?? "anonymous"}`, () => {
    const first = authenticatedDocument();
    browserDocument(
      `
      user = ${JSON.stringify(nextAccount ? { id: nextAccount, email: "b@example.test" } : null)};
      startPostHogConsent(); await settle();
      assert.equal(initialized[0], null);
      assert.equal(visitor(), undefined);
      assert.equal(sessionStorage[key], undefined);
    `,
      first,
    );
  });
}

test("a fragment received on reload cannot bypass a prior authenticated-account binding", () => {
  const first = authenticatedDocument();
  browserDocument(
    `
    user = {id: "account-b", email: "b@example.test"};
    freshFragment();
    startPostHogConsent(); await settle();
    assert.equal(visitor(), undefined);
  `,
    first,
  );
});

test("anonymous attribution bridges the first signup, persists its binding and cannot bridge a second account", () => {
  const anonymous = browserDocument(`
    document.cookie = consentCookie(allow);
    freshFragment(); startPostHogConsent(); await settle();
    assert.equal(JSON.parse(initialized[0]).accountId, null);
    assert.equal(visitor(), id);
  `);
  const firstAccount = browserDocument(
    `
    user = {id: "account-a", email: "a@example.test"};
    startPostHogConsent(); await settle();
    assert.equal(JSON.parse(initialized[0]).accountId, user.id);
    assert.equal(visitor(), id);
    // Same-account storage notifications must not erase attribution.
    authChange(); await settle();
    assert.equal(visitor(), id);
  `,
    anonymous,
  );
  browserDocument(
    `
    user = {id: "account-b", email: "b@example.test"};
    startPostHogConsent(); await settle();
    assert.equal(visitor(), undefined);
  `,
    firstAccount,
  );
});

for (const consentState of ["missing", "expired"]) {
  for (const fresh of [false, true]) {
    test(`${consentState} consent clears persisted attribution and ${fresh ? "retains a fresh fragment" : "cannot revive it after consent"}`, () => {
      const first = authenticatedDocument();
      browserDocument(
        `
        document.cookie = ${consentState === "missing" ? '""' : "consentCookie(allow, Date.now() - CONSENT_MAX_AGE * 1000)"};
        ${fresh ? "freshFragment();" : ""}
        assert.equal(reads, 0); assert.equal(writes, 0);
        startPostHogConsent(); await settle();
        assert.equal(reads, 0); assert.equal(writes, 0);
        assert.equal(initialized.length, 0);
        assert.equal(sessionStorage[key], undefined);
        chooseConsent(allow); await settle();
        assert.equal(visitor(), ${fresh ? "id" : "undefined"});
        ${fresh ? "assert.equal(JSON.parse(initialized[0]).accountId, null);" : ""}
      `,
        first,
      );
    });
  }
}

test("same-account receipts preserve attribution; account loss and changes clear it in the current document", () => {
  browserDocument(`
    document.cookie = consentCookie(allow);
    user = {id: "account-a", email: "a@example.test"};
    freshFragment(); startPostHogConsent(); await settle();
    window.dispatchEvent(new Event("focus")); await settle();
    assert.equal(visitor(), id);
    authChange(); await settle(); assert.equal(visitor(), id);
    user = {id: "account-b", email: "b@example.test"};
    authChange(); await settle(); assert.equal(visitor(), undefined);
    freshFragment(); assert.equal(visitor(), id);
    user = null; window.dispatchEvent(new Event("focus")); await settle();
    assert.equal(visitor(), undefined);
  `);
});

test("legacy unbound attribution cannot cross an unknown prior account", () => {
  const first = authenticatedDocument();
  const legacy = JSON.parse(first.attribution!);
  delete legacy.accountId;
  browserDocument(
    `
    user = {id: "account-b", email: "b@example.test"};
    startPostHogConsent(); await settle();
    assert.equal(visitor(), undefined);
  `,
    { ...first, attribution: JSON.stringify(legacy) },
  );
});
