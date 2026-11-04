import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { APP_URL } from "../src/main/app/renderer-security";
import type { BrowserWindow } from "electron";
import type { WorkspaceService } from "../src/main/workspace/workspace-service";
import type { BrowserScope } from "../src/shared/contracts/browser";

const pointSchema = z.object({ x: z.number(), y: z.number() });
const boundsSchema = pointSchema.extend({ width: z.number(), height: z.number() });

export async function checkBrowserVideo(options: {
  window: BrowserWindow;
  service: WorkspaceService;
  scope: BrowserScope;
  machineId: string;
  viewerId(): string | undefined;
  h264Frames(): number;
  evaluate(expression: string): Promise<unknown>;
  until(check: () => Promise<unknown> | boolean, name: string): Promise<void>;
  offline(): void;
  online(): void;
}) {
  const { window, service, scope, evaluate, until } = options;
  const minimumFps = z.coerce
    .number()
    .min(1)
    .max(60)
    .parse(process.env.TIDY_TEST_BROWSER_MIN_FPS ?? 20);
  const inspect = async (expression: string): Promise<unknown> => {
    const tabId = (await service.browser.state(scope)).activeTabId;
    assert.ok(tabId);
    assert.ok(viewerId);
    const result = await service.browser.command(
      scope,
      {
        kind: "evaluate",
        tabId,
        expression,
      },
      { actor: viewerId },
    );
    return JSON.parse(z.string().parse(result.output));
  };
  const control = async () => {
    const state = await service.browser.state(scope, viewerId);
    if (state.control !== "you")
      await evaluate('document.querySelector(".browser-control-button").click()');
    await until(
      () => evaluate('document.querySelector(".browser-surface")?.dataset.interactive === "true"'),
      "interactive video page",
    );
  };
  const marker = async () =>
    z.object({ value: z.number(), valid: z.boolean() }).parse(
      await evaluate(`(() => {
    const canvas=document.querySelector('.browser-canvas'); if(!canvas||canvas.hidden||canvas.width<256) return {value:-1,valid:false};
    const pixels=canvas.getContext('2d').getImageData(0,8,256,1).data; let value=0,check=0;
    for(let i=0;i<8;i++){if(pixels[(i*16+8)*4]>128)value|=1<<i;if(pixels[((i+8)*16+8)*4]>128)check|=1<<i;}
    return {value,valid:((~value)&255)===check}; })()`),
    );
  const moving = async () => {
    const first = await marker();
    await until(async () => {
      const next = await marker();
      return next.valid && next.value !== first.value;
    }, "decoded video marker changes");
  };
  const nativePoint = async (x: number, y: number) => {
    const bounds = boundsSchema.parse(
      await evaluate(
        `(() => { const r=document.querySelector('.browser-canvas').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`,
      ),
    );
    const state = await service.browser.state(scope);
    const tab = state.tabs.find((candidate) => candidate.id === state.activeTabId);
    assert.ok(tab);
    return {
      x: Math.round(bounds.x + (x * bounds.width) / tab.width),
      y: Math.round(bounds.y + (y * bounds.height) / tab.height),
    };
  };
  const click = async (x: number, y: number, clickCount = 1) => {
    const at = await nativePoint(x, y);
    window.webContents.sendInputEvent({ type: "mouseMove", ...at });
    window.webContents.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount });
    window.webContents.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount });
  };
  await window.loadURL(APP_URL);
  await until(
    () => evaluate('Boolean(document.querySelector(".settings-trigger"))'),
    "settings ready",
  );
  await evaluate('document.querySelector(".settings-trigger").click()');
  await until(
    () => evaluate('Boolean(document.querySelector("[aria-controls=settings-browser-panel]"))'),
    "browser settings page",
  );
  await evaluate('document.querySelector("[aria-controls=settings-browser-panel]").click()');
  await until(
    () =>
      evaluate('Boolean(document.querySelector("button[aria-label^=\\"Browser host machine\\"]"))'),
    "host selector",
  );
  await evaluate(
    'document.querySelector("button[aria-label^=\\"Browser host machine\\"]").click()',
  );
  await until(
    () =>
      evaluate(
        'Array.from(document.querySelectorAll("[role=menuitemradio]")).some(item=>item.textContent.includes("test@browser-host"))',
      ),
    "remote host option",
  );
  await evaluate(
    'Array.from(document.querySelectorAll("[role=menuitemradio]")).find(item=>item.textContent.includes("test@browser-host")).click()',
  );
  const toggle = 'document.querySelector("#settings-browser-panel [role=switch]")';
  await until(() => evaluate(`${toggle}&&!${toggle}.disabled`), "streaming toggle ready");
  if (!(await service.browser.streamingState()).enabled) await evaluate(`${toggle}.click()`);
  await until(
    async () => (await service.browser.streamingState()).enabled,
    "video choice stored remotely",
  );
  await evaluate(
    `sessionStorage.setItem('tidy:navigation:machine',${JSON.stringify(JSON.stringify(options.machineId))});sessionStorage.setItem(${JSON.stringify(`tidy:navigation:${options.machineId}:mode`)},'"code"');sessionStorage.setItem(${JSON.stringify(`tidy:navigation:${options.machineId}:threads`)},${JSON.stringify(JSON.stringify({ [scope.projectId]: scope.threadId }))});true`,
  );
  await window.loadURL(APP_URL);
  window.show();
  window.focus();
  window.webContents.focus();
  await until(
    () => evaluate('Boolean(document.querySelector(".chat-web-link"))'),
    "remote conversation link",
  );
  await evaluate(`(() => {
    window.fixturePaints={video:0,jpeg:0};
    window.fixtureVideoEvents=[];window.fixtureQueuedVideo=[];window.fixtureHoldVideo=false;
    const draw=CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage=function(...args){
      if(this.canvas.classList.contains('browser-canvas')){
        if(typeof VideoFrame!=='undefined'&&args[0] instanceof VideoFrame)window.fixturePaints.video++;
        else window.fixturePaints.jpeg++;
      }
      return draw.apply(this,args);
    };
    const Original=Worker; window.Worker=class extends Original {
    constructor(...args){super(...args);if(String(args[0]).includes('browser-video-worker')){
      window.fixtureVideoWorker=this;this.addEventListener('message',event=>{
        if(event.data.kind==='error'||event.data.kind==='unsupported'){
          window.fixtureVideoEvents.push({kind:event.data.kind,message:event.data.message});
          if(window.fixtureVideoEvents.length>32)window.fixtureVideoEvents.shift();
        }
      });
    }}
    postMessage(...args){
      if(this===window.fixtureBurstWorker&&window.fixtureHoldVideo){window.fixtureQueuedVideo.push(args);return;}
      super.postMessage(...args);
    }
  };return true;})()`);
  await evaluate('document.querySelector(".chat-web-link").click()');
  await until(
    () => evaluate('Boolean(document.querySelector(".browser-canvas:not([hidden])"))'),
    "first rendered frame",
  );
  await until(
    () => options.h264Frames() > 20,
    "H264 delivered through authenticated remote client",
  );
  const viewerId = options.viewerId();
  await moving();
  if (minimumFps >= 20) {
    await until(
      () =>
        evaluate(
          "window.fixturePaints.video>20&&!document.querySelector('.browser-stream-status')",
        ),
      "healthy decoder before delivery burst",
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let probe: Awaited<ReturnType<typeof service.browser.watch>> | undefined;
    let probeVideo = false;
    probe = await service.browser.watch(scope, randomUUID(), (event) => {
      if (event.kind === "frame") {
        if (event.codec === "h264") probeVideo = true;
        probe?.input({
          tabId: event.tabId,
          viewId: event.viewId,
          input: { kind: "ack", frameId: event.frameId },
        });
      }
    });
    try {
      await until(() => probeVideo, "healthy second viewer before delivery burst");
      const before = z.number().parse(await evaluate("window.fixturePaints.video"));
      await evaluate(
        "window.fixtureVideoEvents=[];window.fixtureBurstWorker=window.fixtureVideoWorker;window.fixtureHoldVideo=true;true",
      );
      await until(
        () => evaluate("window.fixtureQueuedVideo.length>=20"),
        "encoded delivery burst queued",
      );
      await evaluate(
        "window.fixtureHoldVideo=false;for(const args of window.fixtureQueuedVideo.splice(0))window.fixtureBurstWorker.postMessage(...args);true",
      );
      await until(
        () => evaluate(`window.fixturePaints.video>${before}+20`),
        "decoder drains encoded delivery burst",
      );
      assert.deepEqual(
        await evaluate("window.fixtureVideoEvents"),
        [],
        "A bounded arrival burst must not reset a healthy decoder",
      );
      await moving();
    } finally {
      probe.close();
      probe = undefined;
    }
  }
  await control();
  const target = pointSchema.parse(
    await inspect(
      `(() => {const r=document.querySelector('main button').getBoundingClientRect();return{x:r.x+15,y:r.y+5};})()`,
    ),
  );
  const at = await nativePoint(target.x, target.y);
  window.webContents.sendInputEvent({ type: "mouseMove", ...at });
  await until(
    async () =>
      (await inspect("getComputedStyle(document.querySelector('main button')).backgroundColor")) ===
      "rgb(30, 80, 220)",
    "remote hover responds",
  );
  await until(
    () =>
      evaluate(
        `(() => {const p=document.querySelector('.browser-canvas').getContext('2d').getImageData(${target.x},${target.y},1,1).data;return p[2]>170&&p[0]<90;})()`,
      ),
    "hover painted in video",
  );
  window.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
  await until(
    async () =>
      (await inspect("getComputedStyle(document.querySelector('main button')).backgroundColor")) !==
      "rgb(30, 80, 220)",
    "hover clears on leaving preview",
  );
  const input = pointSchema.parse(
    await inspect(
      `(() => {const r=document.querySelector('#name').getBoundingClientRect();return{x:r.x+15,y:r.y+15};})()`,
    ),
  );
  await click(input.x, input.y);
  await until(
    () => evaluate('document.activeElement?.classList.contains("browser-keyboard")'),
    "native keyboard focus",
  );
  window.webContents.insertText("Seán 王 👩🏽‍💻");
  await until(
    async () => (await inspect("document.querySelector('#name').value")) === "Seán 王 👩🏽‍💻",
    "Unicode native input exactly once",
  );
  await click(target.x, target.y + 10);
  await until(
    async () =>
      String(await inspect("document.querySelector('#result').textContent")).includes("Seán 王"),
    "remote click executes",
  );
  await inspect(`(() => {
    const input=document.createElement('input');input.id='fixture-drag';input.type='range';
    input.min='0';input.max='100';input.value='0';
    input.style.cssText='position:fixed;left:24px;top:100px;width:240px;height:32px;z-index:99999;margin:0;padding:0;border:0';
    document.body.append(input);return true;
  })()`);
  const dragBounds = boundsSchema.parse(
    await inspect(
      `(() => {const r=document.querySelector('#fixture-drag').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()`,
    ),
  );
  const dragStart = await nativePoint(dragBounds.x + 8, dragBounds.y + dragBounds.height / 2);
  window.webContents.sendInputEvent({ type: "mouseMove", ...dragStart });
  window.webContents.sendInputEvent({
    type: "mouseDown",
    ...dragStart,
    button: "left",
    clickCount: 1,
  });
  for (let step = 1; step <= 8; step++) {
    const at = await nativePoint(
      dragBounds.x + 8 + ((dragBounds.width - 16) * step) / 8,
      dragBounds.y + dragBounds.height / 2,
    );
    window.webContents.sendInputEvent({
      type: "mouseMove",
      ...at,
      button: "left",
      modifiers: ["leftbuttondown"],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const dragEnd = await nativePoint(
    dragBounds.x + dragBounds.width - 8,
    dragBounds.y + dragBounds.height / 2,
  );
  window.webContents.sendInputEvent({ type: "mouseUp", ...dragEnd, button: "left", clickCount: 1 });
  await until(
    async () => Number(await inspect("document.querySelector('#fixture-drag').value")) >= 95,
    "native pointer drag reaches range endpoint",
  );
  await inspect("document.querySelector('#fixture-drag').remove();true");
  const originalBounds = window.getBounds();
  const originalState = await service.browser.state(scope);
  const originalTab = originalState.tabs.find((tab) => tab.id === originalState.activeTabId);
  assert.ok(originalTab);
  window.setBounds({ width: 1173, height: 823 });
  await until(async () => {
    const state = await service.browser.state(scope);
    const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return tab && (tab.width !== originalTab.width || tab.height !== originalTab.height);
  }, "odd window resize changes remote viewport");
  await moving();
  assert.equal(await inspect("document.querySelector('#name').value"), "Seán 王 👩🏽‍💻");
  window.setBounds(originalBounds);
  await until(async () => {
    const state = await service.browser.state(scope);
    const tab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return tab?.width === originalTab.width && tab.height === originalTab.height;
  }, "remote viewport restored");
  await moving();
  const tabColor = async (green: boolean) =>
    until(
      () =>
        evaluate(
          `(() => {const p=document.querySelector('.browser-canvas').getContext('2d').getImageData(16,40,1,1).data;return ${green ? "p[1]>140&&p[0]<90" : "p[0]>140&&p[1]<90"};})()`,
        ),
      green ? "second tab paints its own pixels" : "first tab restores its own pixels",
    );
  const tabMarker = (color: string) =>
    `(() => {const marker=document.createElement('div');marker.style.cssText='position:fixed;left:0;top:24px;width:32px;height:32px;z-index:99999;background:${color}';document.body.append(marker);return true;})()`;
  await inspect(tabMarker("rgb(220,20,20)"));
  await tabColor(false);
  await service.browser.command(scope, { kind: "open", url: originalTab.url }, { actor: viewerId });
  await until(
    async () => (await service.browser.state(scope)).tabs.length === 2,
    "second source tab opened",
  );
  await moving();
  await inspect("document.querySelector('#name').value='second tab';true");
  await inspect(tabMarker("rgb(20,220,20)"));
  await tabColor(true);
  await evaluate("document.querySelector('.browser-tab [role=tab]').click()");
  await until(
    async () => (await service.browser.state(scope)).activeTabId === originalTab.id,
    "native UI restores first tab",
  );
  await moving();
  await tabColor(false);
  assert.equal(await inspect("document.querySelector('#name').value"), "Seán 王 👩🏽‍💻");
  await evaluate("document.querySelector('.browser-tab:last-child [role=tab]').click()");
  await until(
    async () => (await service.browser.state(scope)).activeTabId !== originalTab.id,
    "native UI selects second tab",
  );
  await moving();
  await tabColor(true);
  assert.equal(await inspect("document.querySelector('#name').value"), "second tab");
  await evaluate("document.querySelector('.browser-tab:last-child .browser-tab-close').click()");
  await until(
    async () => (await service.browser.state(scope)).activeTabId === originalTab.id,
    "closing second tab restores first source",
  );
  await moving();
  await tabColor(false);
  assert.equal(await inspect("document.querySelector('#name').value"), "Seán 王 👩🏽‍💻");
  const tabId = (await service.browser.state(scope)).activeTabId;
  assert.ok(tabId);
  await service.browser.command(scope, { kind: "screenshot", tabId });
  await moving();
  for (let restart = 0; restart < 3; restart++) {
    const processes = await promisify(execFile)("ps", [
      "--ppid",
      String(process.pid),
      "-o",
      "pid=,args=",
    ]);
    const line = processes.stdout
      .split("\n")
      .find((value) => value.includes("--framerate=60") && value.includes("--audio-enabled=false"));
    const pid = Number(line?.trim().split(/\s+/)[0]);
    assert.ok(Number.isInteger(pid) && pid > 0);
    const before = options.h264Frames();
    process.kill(pid, "SIGKILL");
    await until(() => options.h264Frames() > before + 20, "encoder restart delivers new video");
    await moving();
    assert.equal(await inspect("document.querySelector('#name').value"), "Seán 王 👩🏽‍💻");
  }
  const fastBefore = z.number().parse(await evaluate("window.fixturePaints.video"));
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const fastPaints = z.number().parse(await evaluate("window.fixturePaints.video")) - fastBefore;
  const slowId = randomUUID();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const slow = await service.browser.watch(scope, slowId, (event) => {
    if (event.kind !== "frame") return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      slow?.input({
        tabId: event.tabId,
        viewId: event.viewId,
        input: { kind: "ack", frameId: event.frameId },
      });
    }, 350);
    timers.add(timer);
  });
  try {
    const before = options.h264Frames();
    const paintedBefore = z.number().parse(await evaluate("window.fixturePaints.video"));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const paintedAfter = z.number().parse(await evaluate("window.fixturePaints.video"));
    console.log(
      JSON.stringify({
        kind: "browser-video-viewer-isolation",
        seconds: 3,
        fastPaints,
        fastPaintsWithSlowViewer: paintedAfter - paintedBefore,
        deliveredFrames: options.h264Frames() - before,
        minimumFps,
        streamStatus: await evaluate(
          "document.querySelector('.browser-stream-status')?.textContent??'video'",
        ),
        decoderEvents: await evaluate("window.fixtureVideoEvents"),
      }),
    );
    assert.ok(
      options.h264Frames() > before + 3 * minimumFps,
      "Video delivery must meet the selected network budget",
    );
    assert.ok(
      paintedAfter > paintedBefore + 3 * minimumFps,
      "Slow viewer must not gate actual renderer painting",
    );
    await moving();
  } finally {
    slow.close();
    for (const timer of timers) clearTimeout(timer);
  }
  await control();
  const beforeDecoder = await service.browser.state(scope);
  const beforeDecoderTab = beforeDecoder.tabs.find((tab) => tab.id === beforeDecoder.activeTabId);
  assert.ok(beforeDecoderTab);
  await evaluate(
    `window.fixtureVideoWorker.dispatchEvent(new MessageEvent('message',{data:{kind:'error',message:'Injected transient decoder fault'}}));true`,
  );
  await until(
    () => evaluate('Boolean(document.querySelector(".browser-stream-status"))'),
    "temporary JPEG fallback shown",
  );
  const before = options.h264Frames();
  await until(() => options.h264Frames() > before + 20, "video resumes without reconnect");
  await moving();
  const afterDecoder = await service.browser.state(scope);
  const afterDecoderTab = afterDecoder.tabs.find((tab) => tab.id === afterDecoder.activeTabId);
  assert.ok(afterDecoderTab);
  assert.deepEqual(
    { width: afterDecoderTab.width, height: afterDecoderTab.height },
    { width: beforeDecoderTab.width, height: beforeDecoderTab.height },
    "fallback status must preserve the remote viewport",
  );
  const saved = await inspect("document.querySelector('#name').value");
  options.offline();
  await until(
    () => evaluate('Boolean(document.querySelector(".browser-reconnecting"))'),
    "remote disconnect visible",
  );
  window.webContents.insertText("must-not-replay");
  options.online();
  await until(
    () => evaluate('!document.querySelector(".browser-reconnecting")'),
    "remote reconnect",
  );
  await moving();
  assert.equal(await inspect("document.querySelector('#name').value"), saved);
  const soakSeconds = z.coerce
    .number()
    .int()
    .min(0)
    .max(1800)
    .parse(process.env.TIDY_TEST_BROWSER_SOAK_SECONDS ?? 0);
  if (soakSeconds) {
    const sampleSchema = z.object({ video: z.number(), jpeg: z.number(), status: z.string() });
    const sample = async () =>
      sampleSchema.parse(
        await evaluate(
          `({...window.fixturePaints,status:document.querySelector('.browser-stream-status')?.textContent.trim()??'video'})`,
        ),
      );
    let previous = await sample();
    let videoPaints = 0;
    let jpegPaints = 0;
    let validMarkers = 0;
    let changingMarkers = 0;
    let minimumVideoFps = Infinity;
    let peakMainRss = process.memoryUsage().rss;
    const statuses = new Map<string, number>();
    const started = performance.now();
    const cpu = process.cpuUsage();
    let previousMarker = await marker();
    for (let second = 0; second < soakSeconds; second++) {
      const before = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const current = await sample();
      const elapsed = (performance.now() - before) / 1000;
      const paints = current.video - previous.video;
      videoPaints += paints;
      jpegPaints += current.jpeg - previous.jpeg;
      minimumVideoFps = Math.min(minimumVideoFps, paints / elapsed);
      statuses.set(current.status, (statuses.get(current.status) ?? 0) + 1);
      peakMainRss = Math.max(peakMainRss, process.memoryUsage().rss);
      const currentMarker = await marker();
      if (currentMarker.valid) validMarkers++;
      if (currentMarker.valid && currentMarker.value !== previousMarker.value) changingMarkers++;
      previousMarker = currentMarker;
      previous = current;
      if ((second + 1) % 30 === 0)
        console.log(
          JSON.stringify({
            kind: "browser-video-soak-progress",
            seconds: second + 1,
            videoPaints,
            jpegPaints,
            validMarkers,
            statuses: Object.fromEntries(statuses),
          }),
        );
    }
    const seconds = (performance.now() - started) / 1000;
    const usedCpu = process.cpuUsage(cpu);
    console.log(
      JSON.stringify({
        kind: "browser-video-soak",
        seconds,
        videoFps: videoPaints / seconds,
        minimumVideoFps,
        jpegPaints,
        validMarkers,
        changingMarkers,
        statuses: Object.fromEntries(statuses),
        peakMainRssBytes: peakMainRss,
        mainCpuSeconds: (usedCpu.user + usedCpu.system) / 1e6,
      }),
    );
    assert.ok(validMarkers >= soakSeconds * 0.95, "soak must display valid source pixels");
    assert.ok(changingMarkers >= soakSeconds * 0.9, "soak must keep source pixels moving");
    assert.ok(videoPaints > soakSeconds * minimumFps, "soak must sustain actual video painting");
  }
  console.log(
    "PASS authenticated remote renderer: decoded H264, hover/leave, native click/Unicode/drag, odd viewport resize, tab switching, screenshot, three encoder restarts, slow viewer isolation, automatic video recovery, disconnect without input replay",
  );
}
