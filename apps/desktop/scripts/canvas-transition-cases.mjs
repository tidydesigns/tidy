import assert from "node:assert/strict";

/** Shared by native CI and the existing shared-browser driver. No second UI implementation. */
export async function canvasTransitionCases(driver, origin, { coldOrigin } = {}) {
  const { evaluate, click, fill, navigate } = driver;
  const passed = [];
  async function wait(expression) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw Error(`Canvas transition timed out: ${expression}`);
  }
  async function colors(expected) {
    const actual = await evaluate(
      `Array.from(document.querySelectorAll('.thread-design-peek,.thread-design-lens,.thread-design-dialog,.thread-design-canvas,.tidy-editor,[aria-label="Design canvas"]'), e => getComputedStyle(e).backgroundColor)`,
    );
    assert.equal(actual.length, 6);
    assert.deepEqual([...new Set(actual)], [expected]);
  }
  async function transition(open, artwork = true) {
    function aligned(target, source) {
      for (const axis of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(target[axis] - source[axis]) < 1,
          `Artwork ${axis} jumped: ${target[axis]} vs ${source[axis]}`,
        );
    }
    let target;
    if (open)
      await evaluate(`new Promise(resolve => {
        document.querySelector('.thread-design-peek').scrollIntoView({block: 'nearest'});
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
    const source = await evaluate(
      `(() => {const n=document.querySelector('.thread-design-peek [data-thumbnail-node]');return n ? {id:n.dataset.thumbnailNode,rect:${open ? "n.getBoundingClientRect().toJSON()" : "null"}} : null})()`,
    );
    await evaluate(
      `(() => {const original=Element.prototype.animate,rect=Element.prototype.getBoundingClientRect;window.__canvasTransitionCheck={original,rect,reads:0,animations:[],nodes:Array.from(document.querySelectorAll('.thread-design-canvas [data-node-id]'))};Element.prototype.getBoundingClientRect=function(){if(this.matches('[data-node-id],[data-thumbnail-node]'))window.__canvasTransitionCheck.reads++;return rect.call(this)};Element.prototype.animate=function(...args){const a=original.apply(this,args);if(this.matches('.thread-design-dialog,.thread-design-canvas,.thread-design-transition-edge')){a.pause();a.currentTime=0;window.__canvasTransitionCheck.animations.push(a)}return a};return true})()`,
    );
    try {
      await click(open ? "Expand canvas" : "Minimise canvas");
      await wait(
        `document.querySelector('.thread-design-dialog').dataset.phase === '${open ? "opening" : "closing"}'`,
      );
      const reads = await evaluate(
        `(()=>{const c=window.__canvasTransitionCheck;Element.prototype.getBoundingClientRect=c.rect;return c.reads})()`,
      );
      assert.equal(
        reads,
        0,
        "Warm transitions must use camera math instead of measuring design nodes",
      );
      if (!open)
        await evaluate(
          `(() => {for(const a of window.__canvasTransitionCheck.animations)a.currentTime=a.effect.getTiming().duration-0.001;return true})()`,
        );
      if (artwork && source) {
        target = await evaluate(
          `document.querySelector('.thread-design-canvas [data-node-id="${source.id}"]')?.getBoundingClientRect().toJSON()`,
        );
        assert.ok(target, `Editor must contain the preview's ${source.id}`);
        if (open) aligned(target, source.rect);
      }
      assert.equal(await evaluate(`document.activeElement.matches(':focus-visible')`), false);
    } finally {
      await evaluate(
        `(() => {const c=window.__canvasTransitionCheck;Element.prototype.animate=c.original;Element.prototype.getBoundingClientRect=c.rect;for(const a of c.animations)a.play();return true})()`,
      );
    }
    await wait(
      `document.querySelector('.thread-design-dialog').dataset.phase === '${open ? "open" : "closed"}'`,
    );
    if (!open && target) {
      const restored = await evaluate(
        `document.querySelector('.thread-design-peek [data-thumbnail-node="${source.id}"]').getBoundingClientRect().toJSON()`,
      );
      aligned(target, restored);
    }
    assert.equal(
      await evaluate(`window.__canvasTransitionCheck.nodes.every(n=>n.isConnected)`),
      true,
      "Retained editor artwork must not remount on each transition",
    );
    assert.equal(
      await evaluate(
        `getComputedStyle(document.querySelector('${open ? ".thread-design-artwork" : ".thread-design-canvas [data-canvas-artwork]"}')).contentVisibility`,
      ),
      "hidden",
      "The inactive retained scene must be excluded from layout/paint work",
    );
    assert.equal(
      await evaluate(`document.querySelector('.thread-design-canvas').inert`),
      !open,
      "The inactive editor must remain inaccessible to pointer and keyboard input",
    );
    assert.equal(
      await evaluate(`document.activeElement.getAttribute('aria-label')`),
      open ? "Minimise canvas" : "Expand canvas",
    );
    assert.equal(await evaluate(`document.activeElement.matches(':focus-visible')`), false);
    assert.equal(
      await evaluate(`document.querySelector('.thread-design-dialog').style.clipPath`),
      "",
    );
    assert.equal(
      await evaluate(`document.querySelector('.thread-design-canvas').style.transform`),
      "",
    );
  }
  const mutate = (body) =>
    evaluate(
      `(async()=>{const projectId='f0f0f0f0-0000-4000-8000-000000000001',designId='f0f0f0f0-0000-4000-8000-000000000002';const d=await window.tidy.readDesign(projectId,designId);${body};await window.tidy.updateDesign({projectId,designId,expectedVersion:d.version,document:d.document});return true})()`,
    );
  if (coldOrigin) {
    for (const theme of ["light", "dark"]) {
      await navigate(`${coldOrigin}/desktop-demo/?view=desktop&theme=${theme}&cold=1`);
      await wait(
        `Boolean(document.querySelector('.thread-design-peek [data-thumbnail-node="landing"]'))`,
      );
      await wait(`!document.querySelector('.thread-design-frame').hasAttribute('data-moving')`);
      assert.equal(
        await evaluate(
          `Boolean(document.querySelector('.thread-design-canvas [data-node-id="landing"]'))`,
        ),
        false,
        "Cold fixture must delay the real editor module",
      );
      await evaluate(`new Promise(resolve => {
        document.querySelector('.thread-design-peek').scrollIntoView({block: 'nearest'});
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const source = await evaluate(
        `document.querySelector('.thread-design-peek [data-thumbnail-node="landing"]').getBoundingClientRect().toJSON()`,
      );
      await evaluate(
        `(()=>{const original=Element.prototype.animate;window.__coldAnimations={original,animations:[]};Element.prototype.animate=function(...args){const a=original.apply(this,args);if(this.matches('.thread-design-dialog,.thread-design-canvas,.thread-design-transition-edge')){a.pause();a.currentTime=0;window.__coldAnimations.animations.push(a)}return a};return true})()`,
      );
      let loading;
      try {
        await click("Expand canvas");
        const first = await evaluate(
          `document.querySelector('.thread-design-canvas [data-thumbnail-node="landing"]').getBoundingClientRect().toJSON()`,
        );
        for (const axis of ["x", "y", "width", "height"])
          assert.ok(
            Math.abs(first[axis] - source[axis]) < 1,
            `Cold opening artwork ${axis} must align: ${first[axis]} vs ${source[axis]}`,
          );
      } finally {
        await evaluate(
          `(()=>{const c=window.__coldAnimations;Element.prototype.animate=c.original;for(const a of c.animations)a.play();return true})()`,
        );
      }
      await wait(`document.querySelector('.thread-design-dialog').dataset.phase==='open'`);
      loading = await evaluate(
        `document.querySelector('.thread-design-canvas [data-thumbnail-node="landing"]')?.getBoundingClientRect().toJSON()`,
      );
      assert.ok(loading, "Loading artwork must remain visible while the editor downloads");
      await click("Minimise canvas");
      await wait(`document.querySelector('.thread-design-dialog').dataset.phase==='closed'`);
      assert.equal(
        await evaluate(`document.activeElement.getAttribute('aria-label')`),
        "Expand canvas",
      );
      await click("Expand canvas");
      await wait(`document.querySelector('.thread-design-dialog').dataset.phase==='open'`);
      loading = await evaluate(
        `document.querySelector('.thread-design-canvas [data-thumbnail-node="landing"]')?.getBoundingClientRect().toJSON()`,
      );
      assert.ok(loading, "Reopening must not wait for the delayed editor download");
      await evaluate(`fetch('/__fixtures/release-editor', {method: 'POST'}).then(response => {
        if (!response.ok) throw Error('Could not release the editor download');
        return true;
      })`);
      await wait(
        `Boolean(document.querySelector('.thread-design-canvas [data-node-id="landing"]'))`,
      );
      const ready = await evaluate(
        `document.querySelector('.thread-design-canvas [data-node-id="landing"]').getBoundingClientRect().toJSON()`,
      );
      for (const axis of ["x", "y", "width", "height"])
        assert.ok(
          Math.abs(ready[axis] - loading[axis]) < 1,
          `Editor handoff must preserve artwork ${axis}`,
        );
      await colors(theme === "light" ? "rgb(243, 243, 243)" : "rgb(38, 38, 38)");
      await wait(`document.activeElement.getAttribute('aria-label')==='Minimise canvas'`);
      await transition(false);
      passed.push(
        `${theme}: cold expand/minimize/reopen, loading-preview alignment and editor focus handoff`,
      );
    }
  }
  for (const theme of ["light", "dark"]) {
    await navigate(`${origin}/desktop-demo/?view=desktop&theme=${theme}`);
    await wait(`Boolean(document.querySelector('.thread-design-canvas [data-node-id="landing"]'))`);
    await colors(theme === "light" ? "rgb(243, 243, 243)" : "rgb(38, 38, 38)");
    await transition(true);
    await transition(false);
    passed.push(`${theme}: default colors, artwork alignment, pointer focus and animation cleanup`);

    await mutate(
      `d.document.pages[0].background='#d4d4d4';d.document.pages.push({id:'contrast',name:'Contrast',background:'#e7dec9'},{id:'empty',name:'Empty',background:'#b8c9db'});d.document.nodes.push(...d.document.nodes.map(n=>({...n,id:'second-'+n.id,parentId:n.parentId?'second-'+n.parentId:null,pageId:'contrast',box:{...n.box,...(n.parentId?{}:{x:-400,y:250})},style:{...n.style,...(n.parentId?{}:{rotation:15})}})))`,
    );
    await wait(
      `getComputedStyle(document.querySelector('.thread-design-peek')).backgroundColor==='rgb(212, 212, 212)'`,
    );
    await colors("rgb(212, 212, 212)");
    await transition(true);
    await click("Expand editor panels");
    assert.equal(
      await evaluate(
        `document.activeElement.matches('[aria-label="Design canvas"]') && !document.activeElement.closest('[inert],[aria-hidden="true"]')`,
      ),
      true,
      "Panel toggles must move focus before hiding their triggering control",
    );
    await click("Contrast");
    await wait(
      `document.querySelector('.thread-design-peek [data-thumbnail-node="second-landing"]')!==null`,
    );
    // Bounds and the fitted preview camera must settle before the close path measures them.
    await evaluate(
      `new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    await colors("rgb(231, 222, 201)");
    await transition(false);
    await transition(true);
    await mutate(`d.document.pages.find(p=>p.id==='contrast').background='#8ab5a3'`);
    await wait(
      `getComputedStyle(document.querySelector('[aria-label="Design canvas"]')).backgroundColor==='rgb(138, 181, 163)'`,
    );
    await colors("rgb(138, 181, 163)");
    await transition(false);
    await transition(true);
    passed.push(
      `${theme}: second-page artwork, rotated/offset roots and changed custom backgrounds`,
    );

    await click("Empty");
    await wait(`document.querySelector('.thread-design-peek [data-thumbnail-node]')===null`);
    await colors("rgb(184, 201, 219)");
    await transition(false, false);
    await transition(true, false);
    await mutate(`d.document.pages=d.document.pages.filter(p=>p.id!=='empty')`);
    await wait(
      `document.querySelector('.thread-design-peek [data-thumbnail-node="landing"]')!==null`,
    );
    await colors("rgb(212, 212, 212)");
    await transition(false);
    passed.push(`${theme}: empty pages and deletion of the selected page`);

    // Native text entry establishes keyboard modality. A subsequent pointer click must reset it.
    await fill("Message", "Focus regression check");
    assert.equal(
      await evaluate(
        `(()=>{const b=document.querySelector('.thread-design-peek');b.focus({preventScroll:true});return b.matches(':focus-visible')})()`,
      ),
      true,
    );
    await transition(true);
    await evaluate(
      `(()=>{const t=document.createElement('textarea');t.setAttribute('aria-label','Focus check');t.style.cssText='position:fixed;top:0;left:0';document.querySelector('.thread-design-dialog').append(t);return true})()`,
    );
    await fill("Focus check", "Keyboard focus");
    assert.equal(
      await evaluate(
        `(()=>{const b=document.querySelector('[data-canvas-back]');b.focus();document.querySelector('[aria-label="Focus check"]').remove();return b.matches(':focus-visible')})()`,
      ),
      true,
    );
    await transition(false);
    passed.push(`${theme}: keyboard indicators survive; pointer transitions clear inherited rings`);

    await evaluate(
      `(()=>{const original=window.matchMedia.bind(window);window.matchMedia=query=>{const m=original(query);if(query==='(prefers-reduced-motion: reduce)')Object.defineProperty(m,'matches',{value:true});return m};return true})()`,
    );
    await transition(true, false);
    assert.equal(
      await evaluate(`document.querySelector('.thread-design-canvas').style.transform`),
      "",
    );
    await transition(false, false);
    passed.push(`${theme}: reduced motion opens and closes cleanly`);
  }
  return passed;
}
