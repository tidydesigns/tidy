// Local deterministic regression: node apps/web/scripts/test-web-capture-browser.mjs
// Profile/background/clipping/text regression: append --profile (optionally --retina).
// Optional live check: append --shale. No writes to Tidy or the source website.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { browserCaptureScript } from "../lib/mcp/browser-capture.generated.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(path.join(tmpdir(), "tidy-capture-regression-"));
const bundle = path.join(output, "capture.js");
execFileSync(
  "bun",
  [
    "build",
    "apps/web/scripts/fixtures/capture-preview.ts",
    "--target=browser",
    `--outfile=${bundle}`,
  ],
  { cwd: repo, stdio: "pipe" },
);
const browser = await chromium.launch({ headless: true });
const live = process.argv.includes("--shale");
const profile = process.argv.includes("--profile");
const artifacts = process.argv.includes("--artifacts");
const search = process.argv.includes("--search");
const selector = profile ? "#profile" : undefined;
const width = live ? 1440 : 1000,
  height = live ? 1000 : 800;
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: process.argv.includes("--retina") ? 2 : 1,
  });
  if (live) await page.goto("https://shales.dev/", { waitUntil: "networkidle" });
  else if (search) {
    const image = (color) =>
      `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${color}"/><circle cx="40" cy="40" r="20" fill="#eee"/></svg>`)}`;
    await page.route("https://images.test/partial.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#f28434"/></svg>',
      }),
    );
    await page.route("https://capture.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>
      *{box-sizing:border-box}body{margin:0;background:color(srgb .13 .14 .15);color:#ddd;font:20px Arial}
      main{position:relative;width:1000px;height:1800px}
      img{position:absolute;width:80px;height:80px}
      #hero{position:absolute;left:30px;top:150px;width:480px;height:200px;overflow:hidden}
      #hero img{width:96px;height:200px;object-fit:cover}
      #divider{position:absolute;left:30px;top:390px;width:480px;height:40px;color:white;border:0;border-bottom:2px solid color(srgb .3 .32 .34 / .6)}
      #edges{position:absolute;left:30px;top:450px;width:300px;height:70px;border:6px solid transparent;border-left-color:oklch(.6 .1 140);border-right-color:color(display-p3 .7 .2 .3);border-bottom-color:color(srgb .3 .32 .34)}
      .symbol{position:absolute;left:600px;width:40px;height:40px;color:#498df4}
      #pseudo{position:absolute;left:690px;top:250px;width:40px;height:40px;border:1px solid color(srgb .3 .32 .34);border-radius:50%}
      #pseudo::before{content:"";position:absolute;left:9px;top:9px;width:20px;height:20px;border-radius:50%;background:oklch(.65 .15 140)}
      #pseudo::after{content:"+";position:absolute;left:13px;top:8px;font:20px Arial;color:white}
      #carousel{position:absolute;left:400px;top:480px;width:80px;height:80px;overflow:hidden}
      #partial{left:950px;top:450px;width:100px;height:100px}
      #tabs{position:absolute;left:30px;top:90px;display:flex;gap:20px;background:color(srgb 0 0 0 / 0)}
      #tabs span{border-bottom:3px solid transparent;padding-bottom:8px}
      #tabs .active{border-bottom-color:#ddd}
      #search-pill{position:absolute;left:300px;top:20px;width:400px;height:40px;border:1px solid #4d5156;border-radius:20px;background:#363840}
      .filtered{position:absolute;left:850px;top:1200px;width:12px;height:12px;filter:grayscale(.3);background:#c17544}
      #contents{display:contents;overflow:hidden}
      #contents::after{content:""}
      .repeated-icon{position:absolute;left:850px;top:650px;width:12px;height:12px;background:#498df4;filter:grayscale(.3)}
      </style><main>
      ${Array.from({ length: 105 }, (_, i) => `<div class="filtered" style="top:${1200 + i * 3}px;background:rgb(${i},100,140)"></div>`).join("")}
      ${Array.from({ length: 105 }, (_, i) => `<img alt="Offscreen ${i}" style="left:${(i % 10) * 90}px;top:${1200 + Math.floor(i / 10) * 40}px" src="${image(`#${(0x100000 + i * 1001).toString(16)}`)}">`).join("")}
      ${Array.from({ length: 120 }, (_, i) => `<img alt="Repeated ${i}" style="width:12px;height:12px;left:${30 + (i % 60) * 14}px;top:${600 + Math.floor(i / 60) * 20}px" src="${image("#396594")}">`).join("")}
      <svg width="0" height="0" style="position:absolute"><defs><symbol id="social" viewBox="0 0 24 24"><path fill="currentColor" d="M2 2h20v20H2z"/></symbol></defs></svg>
      <div id="contents"><section id="hero">${["#ba7750", "#659cba", "#7d60ad", "#5d9655", "#c08c43"].map((color, i) => `<img alt="Hero ${i}" style="left:${i * 96}px" src="${image(color)}">`).join("")}</section></div>
      <nav id="tabs"><span class="active">All</span><span>Images</span><span>News</span></nav><div id="search-pill"></div>
      ${Array.from({ length: 10 }, (_, i) => `<div class="repeated-icon" style="left:${850 + i * 13}px"></div>`).join("")}
      <div id="divider"></div><div id="edges"></div>
      <svg class="symbol" style="top:250px"><use href="#social"/></svg>
      <svg class="symbol" style="top:1100px"><use href="#social"/></svg>
      <div id="pseudo"></div><div id="carousel">${Array.from({ length: 105 }, (_, i) => `<img alt="Clipped ${i}" style="left:${100 + i * 90}px" src="${image("#b23f50")}">`).join("")}</div>
      <img id="partial" alt="Partial" src="https://images.test/partial.svg">
      <input style="position:absolute;top:30px;left:30px" value="private search token">
      </main>`,
      }),
    );
    await page.goto("https://capture.test/");
    await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  } else if (artifacts) {
    await page.route("https://capture.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<style>
        *{box-sizing:border-box}body{margin:0;background:#212327;color:#ddd;font:20px/28px Arial}
        main{position:relative;width:1000px;height:800px}
        #public{position:absolute;left:30px;top:30px;width:500px;height:130px;perspective:1000px;background:#212327}
        repo-header{display:block;width:450px;height:60px;background:#292d33;padding:15px}
        button{position:absolute;left:750px;top:30px;width:160px;height:48px;border:1px solid transparent;border-radius:24px;background:#30333d;color:#ddd;font:20px Arial}
        #form{position:absolute;left:30px;top:220px;width:400px;height:150px;perspective:1000px;background:#212327}
        input,[contenteditable]{position:absolute;left:20px;width:240px;height:40px;border:0;color:white;font:20px Arial}
        input{top:20px;background:transparent}[contenteditable]{top:80px;background:rgba(255,255,255,.2)}
        #closed{position:absolute;left:30px;top:430px;width:400px;height:120px;perspective:1000px;background:#212327}
        private-editor{display:block;width:300px;height:60px;background:#292d33}
      </style><main><section id="public"><repo-header>Public repository owner</repo-header><p>Public repository details</p></section>
      <button id="upgrade">Upgrade</button><section id="form"><input value="private input token"><div contenteditable="true">private draft token</div></section>
      <section id="closed"><private-editor></private-editor><span>Public account details</span></section></main>`,
      }),
    );
    await page.goto("https://capture.test/");
    await page.evaluate(() => {
      document.querySelector("private-editor").attachShadow({ mode: "closed" }).innerHTML =
        '<input value="closed private token" style="color:red">';
    });
  } else if (profile) {
    const avatar = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#63a69f"/><circle cx="100" cy="70" r="40" fill="#efbb92"/><path d="M20 200v-50a80 65 0 01160 0v50" fill="#383f51"/></svg>`;
    const icon =
      '<svg viewBox="0 0 24 24" width="24" height="24" style="color:#479cf0"><path fill="currentColor" d="M12 0l3 4 5-1-1 5 5 4-5 3 1 5-5-1-3 5-3-5-5 1 1-5-5-3 5-4-1-5 5 1z"/></svg>';
    const html = `<style>
      *{box-sizing:border-box}body{margin:0;font:24px/30px Arial;color:#e7e9ea}.canvas{background:#000;width:1000px;height:800px}
      #profile{position:relative;width:1000px;height:800px;padding:0 30px}#avatar{position:absolute;left:30px;top:-30px;width:180px;height:180px;border:4px solid #000;border-radius:50%;overflow:hidden}#avatar img{width:100%;height:100%;object-fit:cover}
      button{position:absolute;right:30px;top:25px;background:transparent;color:inherit;border:1px solid #536471;border-radius:9999px;padding:12px 24px;font:bold 24px/30px Arial}
      h1{position:absolute;top:180px;left:30px;margin:0;font:bold 32px/38px Arial}h1 svg{margin-left:10px;vertical-align:middle;transform:translateY(-2px)}
      #handle{position:absolute;top:225px;left:30px;color:#71767b}#bio{position:absolute;top:290px;left:30px;width:760px}
      #details{position:absolute;top:365px;left:30px;color:#71767b}#details a{color:#479cf0;text-decoration:none;margin:0 20px}#counts{position:absolute;top:425px;left:30px;color:#71767b}#counts strong{color:#e7e9ea}#counts span{margin-right:25px}
      #wrapped{position:absolute;top:510px;left:30px;width:350px;line-height:32px}#filtered{position:absolute;top:520px;left:500px;width:80px;height:80px;background:#f76838;filter:grayscale(.5);clip-path:circle(40%)}
      #rotated{position:absolute;top:520px;left:650px;width:100px;height:80px;background:#479cf0;transform:rotate(20deg)}
    </style><div class="canvas"><main id="profile"><div id="avatar"><img alt="Avatar" src="data:image/svg+xml,${encodeURIComponent(avatar)}"></div><button>Edit profile</button><h1>Alex Designer${icon}</h1><div id="handle">@alex_designer</div><div id="bio">Building Tidy, an open source agentic design platform.</div><div id="details">Dublin, Ireland<a href="https://example.com">example.com</a>Joined October 2026</div><div id="counts"><span><strong>65</strong> Following</span><strong>5</strong> Followers</div><div id="wrapped">This description deliberately wraps onto several lines in the source page.</div><div id="filtered"></div><div id="rotated"></div></main></div>`;
    await page.route("https://capture.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto("https://capture.test/");
  } else {
    const trees = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="500"><rect width="300" height="500" fill="#b4cac4"/>${Array.from(
      { length: 45 },
      (_, i) => {
        const x = (i * 67) % 300,
          y = (i * 43) % 400;
        return `<path d="M${x} ${y}l-35 110h70z" fill="${i % 2 ? "#163c35" : "#407563"}"/>`;
      },
    ).join("")}</svg>`;
    await page.setContent(`<style>
      *{box-sizing:border-box}body{margin:0;background:#f7f7f5;font:16px Arial}main{position:relative;width:1000px;height:800px;background:#f7f7f5}
      h1{position:absolute;left:300px;top:30px;margin:0;font-size:32px}button{position:absolute;left:420px;top:100px;z-index:4;background:#161818;color:white;border:0;padding:12px}
      .forest{position:absolute;left:0;top:150px;width:300px;height:600px;background-image:url('data:image/svg+xml,${encodeURIComponent(trees)}');background-size:cover;opacity:.8;mask-image:linear-gradient(90deg,#000 60%,transparent),linear-gradient(transparent,#000 20%,#000 80%,transparent);mask-composite:intersect}
      .right{left:700px;transform:scaleX(-1)}#laptop{position:absolute;left:310px;top:250px;width:380px;height:340px;perspective:800px}
      .screen{position:absolute;left:10px;top:0;width:360px;height:240px;background:#182820;border:12px solid #202322;border-radius:14px;transform:rotateX(-24deg) rotateY(8deg);transform-origin:50% 100%;box-shadow:0 6px 14px #0005}
      .screen span{display:block;margin:24px;color:white}.base{position:absolute;left:-20px;top:230px;width:420px;height:35px;background:linear-gradient(#aaa,#222);border-radius:0 0 15px 15px;box-shadow:0 12px 12px #0004}
    </style><main><h1>Editable heading</h1><button>Editable action</button><div class="forest" id="trees-left"></div><div class="forest right" id="trees-right"></div><div id="laptop"><div class="screen"><span>Workspace ready</span></div><div class="base"></div></div></main>`);
    // captureSourceUrl deliberately rejects about:blank; use a synthetic HTTP URL
    // through routing so the deterministic fixture never needs a network service.
    const html = await page.content();
    await page.route("https://capture.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: html }),
    );
    await page.goto("https://capture.test/");
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
    for (const animation of document.getAnimations()) animation.pause();
  });
  await page.addScriptTag({ content: await readFile(bundle, "utf8") });
  await page.addScriptTag({ content: browserCaptureScript });
  const borderSamples = search
    ? await page.evaluate(() =>
        [...document.querySelectorAll("#tabs span, #search-pill")].map((element) => {
          const box = element.getBoundingClientRect();
          return { x: Math.floor(box.left + box.width / 2), y: Math.floor(box.bottom - 1) };
        }),
      )
    : [];
  const viewport = await page.evaluate(
    (selector) => globalThis.__tidyCapture.prepare({ selector }),
    selector,
  );
  const before = await page.screenshot({ path: path.join(output, "source.png") });
  const capture = await page.evaluate(
    async ({ screenshot, viewport, selector }) =>
      globalThis.__tidyCapture.capture({ screenshot, viewport, selector }),
    { screenshot: `data:image/png;base64,${before.toString("base64")}`, viewport, selector },
  );
  await assert.rejects(
    page.evaluate(
      async ({ screenshot, viewport }) =>
        globalThis.__tidyCapture.capture({
          screenshot,
          viewport: { ...viewport, scrollY: viewport.scrollY + 1 },
        }),
      { screenshot: `data:image/png;base64,${before.toString("base64")}`, viewport },
    ),
    /matching prepare/,
  );
  await writeFile(path.join(output, "capture.json"), JSON.stringify(capture));
  execFileSync(
    "bun",
    [
      "-e",
      'import {webCaptureSchema} from "./packages/design/web-capture.ts"; webCaptureSchema.parse(await Bun.file(process.argv[1]).json());',
      path.join(output, "capture.json"),
    ],
    { cwd: repo, stdio: "pipe" },
  );
  if (search) {
    assert.equal(capture.assets.length, 100, "Unique assets stay within the existing budget");
    assert.ok(!JSON.stringify(capture).includes("private search token"));
    assert.ok(
      !capture.document.warnings.some(({ message }) => message.includes("advanced CSS colors")),
    );
    const divider = capture.document.nodes.find((node) => node.name === "divider");
    assert.ok(divider.style.borderColor.startsWith("#4"), "Bottom divider retains its dark color");
    const edges = capture.document.nodes.find((node) => node.name === "edges");
    assert.equal(edges.style.borderColor, "#00000000");
    assert.ok(
      edges.style.borderBottomColor && edges.style.borderLeftColor && edges.style.borderRightColor,
    );
    assert.ok(
      capture.document.nodes.some((node) => node.name.startsWith("contents:")),
      "Visible photo group survives offscreen image pressure",
    );
    const icons = capture.document.nodes.filter((node) => node.name.startsWith("repeated-icon:"));
    assert.equal(icons.length, 10);
    assert.equal(
      new Set(icons.map((node) => node.assetId)).size,
      1,
      "Repeated raster effects share an asset",
    );
    const repeated = capture.document.nodes.filter((node) => node.name.startsWith("Repeated "));
    assert.equal(repeated.length, 120);
    assert.equal(
      new Set(repeated.map((node) => node.assetId)).size,
      1,
      "Repeated pixels share one asset",
    );
    assert.ok(
      !capture.document.nodes.some((node) => node.name.startsWith("Clipped ")),
      "Carousel clips do not consume image slots",
    );
    assert.ok(
      capture.document.nodes.some((node) => node.name.includes("Generated CSS content")),
      "Generated icon is retained",
    );
    assert.ok(
      capture.document.nodes.some((node) => node.name === "Partial"),
      "Partially visible cross-origin images use the visible crop",
    );
    assert.equal(
      capture.document.nodes.filter((node) => node.name === "svg").length,
      2,
      "Local SVG symbols work inside and outside the viewport",
    );
  } else if (artifacts) {
    const upgrade = capture.document.nodes.find((node) => node.name === "upgrade");
    assert.equal(upgrade.style.borderColor, "#00000000", "Transparent borders stay invisible");
    assert.equal(upgrade.style.borderWidth, 1, "Invisible borders retain their layout width");
    for (const text of [
      "Public repository owner",
      "Public repository details",
      "Public account details",
    ])
      assert.ok(
        capture.document.nodes.some((node) => node.type === "text" && node.text === text),
        `${text} stays editable`,
      );
    assert.ok(!JSON.stringify(capture).includes("private input token"));
    assert.ok(!JSON.stringify(capture).includes("private draft token"));
    assert.ok(!JSON.stringify(capture).includes("closed private token"));
    assert.equal(
      capture.assets.length,
      1,
      "Only the inspectable form group uses screenshot pixels",
    );
    const { data, info } = await sharp(Buffer.from(capture.assets[0].base64, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (const [y, color] of [
      [40, [33, 35, 39, 255]],
      [100, [77, 79, 82, 255]],
    ]) {
      const offset = (y * info.width + 40) * 4;
      assert.deepEqual(
        [...data.subarray(offset, offset + 4)],
        color,
        "Private controls use opaque CSS backgrounds instead of white bars",
      );
    }
  } else if (profile) {
    assert.equal(
      capture.document.nodes[0].style.fill,
      "#000000",
      "Transparent selection inherits its dark ancestor canvas",
    );
    const avatar = capture.document.nodes.find((node) => node.name === "avatar");
    assert.equal(avatar.style.radius, 90);
    assert.equal(avatar.style.overflow, "hidden");
    assert.ok(
      capture.document.nodes.some((node) => node.type === "image" && node.parentId === avatar.id),
    );
    for (const text of ["Edit profile", "65", "Joined October 2026"]) {
      assert.ok(
        capture.document.nodes.some(
          (node) =>
            node.type === "text" && node.text.includes(text) && node.style.textWrap === "nowrap",
        ),
        `${text} remains editable without wrapping again`,
      );
    }
    assert.ok(
      capture.document.nodes.some((node) => node.name.includes("CSS filter")),
      "Filter is preserved in pixels",
    );
    assert.ok(
      capture.document.nodes.some((node) => node.name.includes("CSS transform")),
      "Rotation is preserved in pixels",
    );
    assert.ok(
      !capture.document.warnings.some(({ message }) => message.includes("approximated")),
      "Supported profile styles are preserved",
    );
    const icon = capture.document.nodes.find((node) => node.name === "svg");
    const asset = capture.assets.find((asset) => asset.id === icon.assetId);
    const { data, info } = await sharp(Buffer.from(asset.base64, "base64"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.equal(data[3], 0, "SVG icon corners remain transparent");
  } else {
    const masked = capture.document.nodes.filter((node) => node.name.includes("CSS mask"));
    const laptop = capture.document.nodes.find((node) => node.name.includes("3D perspective"));
    assert.ok(masked.length >= 2, "Both masked forests must be retained");
    assert.ok(laptop, "Perspective scene must be flattened as one layer");
    assert.ok(
      capture.document.nodes.some(
        (node) =>
          node.type === "text" && node.text.includes(live ? "Run coding" : "Editable heading"),
      ),
      "Heading remains editable",
    );
    assert.ok(
      capture.document.nodes.some(
        (node) =>
          node.type === "text" && node.text.includes(live ? "View source" : "Editable action"),
      ),
      "CTA remains editable",
    );
    assert.deepEqual(
      laptop.style,
      { objectFit: "fill" },
      "Never apply effects twice to rendered pixels",
    );
    for (const node of masked.slice(0, 2)) {
      const imageNodes =
        node.type === "container"
          ? capture.document.nodes.filter((child) => child.parentId === node.id)
          : [node];
      let transparent = false,
        faded = false;
      for (const imageNode of imageNodes) {
        const asset = capture.assets.find((asset) => asset.id === imageNode.assetId);
        const { data, info } = await sharp(Buffer.from(asset.base64, "base64"))
          .raw()
          .toBuffer({ resolveWithObject: true });
        assert.equal(info.channels, 4);
        transparent ||= data.some((value, index) => index % 4 === 3 && value === 0);
        faded ||= data.some((value, index) => index % 4 === 3 && value > 0 && value < 200);
      }
      assert.ok(transparent, "Mask retains transparent pixels");
      assert.ok(faded, "Mask retains its fade, not a hard clip");
    }
  }
  await page.evaluate(
    async ({ capture, width, height }) => {
      const root = document.createElement("div");
      root.style.cssText = `position:relative;width:${width}px;height:${height}px;background:#fff;overflow:hidden`;
      for (const style of document.querySelectorAll("style, link[rel=stylesheet]")) style.remove();
      document.body.replaceChildren(root);
      document.body.style.cssText = "margin:0;padding:0";
      window.renderCapture(
        root,
        capture.document,
        Object.fromEntries(
          capture.assets.map((asset) => [
            asset.id,
            `data:${asset.mimeType};base64,${asset.base64}`,
          ]),
        ),
      );
      await Promise.all([...document.images].map((image) => image.decode().catch(() => {})));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.scrollTo(0, 0);
    },
    { capture, width, height },
  );
  const after = await page.screenshot({ path: path.join(output, "imported.png") });
  const pixels = await Promise.all(
    [before, after].map((bytes) =>
      sharp(bytes).resize(width, height).removeAlpha().raw().toBuffer(),
    ),
  );
  const regions = search
    ? [
        { name: "visible photo grid", x: 20, y: 140, width: 500, height: 220 },
        { name: "modern colors and independent borders", x: 20, y: 380, width: 500, height: 150 },
        { name: "local SVG and generated CSS icons", x: 590, y: 240, width: 150, height: 60 },
        { name: "partially visible cross-origin image", x: 940, y: 440, width: 60, height: 120 },
      ]
    : artifacts
      ? [
          { name: "public custom-element content", x: 20, y: 20, width: 520, height: 150 },
          { name: "transparent upgrade button border", x: 740, y: 20, width: 180, height: 70 },
        ]
      : profile
        ? [
            { name: "profile background and avatar", x: 0, y: 0, width: 250, height: 170 },
            { name: "profile button", x: 750, y: 20, width: 250, height: 80 },
            { name: "profile text and SVG", x: 20, y: 175, width: 930, height: 320 },
            { name: "multiline editable text", x: 20, y: 500, width: 380, height: 160 },
            { name: "filter and clip path", x: 490, y: 510, width: 100, height: 100 },
            { name: "rotated shape", x: 620, y: 490, width: 160, height: 150 },
          ]
        : live
          ? [
              { name: "header logo icon", x: 130, y: 30, width: 28, height: 30 },
              { name: "GitHub header icon", x: 1207, y: 40, width: 20, height: 20 },
              { name: "GitHub CTA icon", x: 562, y: 308, width: 22, height: 22 },
              { name: "left forest", x: 0, y: 300, width: 250, height: 650 },
              { name: "right forest", x: 1210, y: 300, width: 230, height: 650 },
              // Compare the physical laptop, excluding its intentionally redacted controls.
              { name: "laptop top and sides", x: 340, y: 375, width: 790, height: 275 },
              { name: "laptop base", x: 275, y: 837, width: 918, height: 65 },
            ]
          : [
              { name: "left forest", x: 0, y: 150, width: 290, height: 550 },
              { name: "right forest", x: 710, y: 150, width: 290, height: 550 },
              { name: "laptop", x: 290, y: 230, width: 420, height: 320 },
            ];
  for (const { x, y } of borderSamples) {
    const index = (y * width + x) * 3;
    assert.deepEqual(
      pixels[1].subarray(index, index + 3),
      pixels[0].subarray(index, index + 3),
      "React rendering retains the exact active, transparent and dark border pixels",
    );
  }
  for (const region of regions) {
    let total = 0;
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++)
        for (let channel = 0; channel < 3; channel++) {
          const index = (y * width + x) * 3 + channel;
          total += Math.abs(pixels[0][index] - pixels[1][index]);
        }
    const mean = total / (region.width * region.height * 3);
    console.log(`${region.name}: mean channel difference ${mean.toFixed(3)} / 255`);
    assert.ok(mean < 3, `${region.name} deviates from the rendered source (${mean.toFixed(3)})`);
  }
  console.log(`Capture regression passed. Screenshots and capture: ${output}`);
} finally {
  await browser.close();
}
