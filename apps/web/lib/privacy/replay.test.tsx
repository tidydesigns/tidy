import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { PropertyField } from "../../app/files/[uid]/property-field";
import { Choice, ColorField, Section } from "../../app/files/[uid]/inspector-controls";
import { SelectMenu } from "@tidy/ui/select-menu";
import { replayAttribute, replayText } from "./replay";
import { iconSources } from "@tidy/editor/components/ui/icon-sources";
import { Icon } from "@tidy/editor/components/ui/icon";
import { buildDrawnNode } from "../design/document";
import { LayerTree } from "../../app/files/[uid]/layer-tree";

test("public inspector labels do not opt field values or custom labels into replay", () => {
  const html = renderToStaticMarkup(
    <Section title="Position" replayTitle>
      <PropertyField label="Width" replayLabel value="private-value" onCommit={() => {}} />
      <PropertyField label="private-property-name" value="private-value" onCommit={() => {}} />
      <Choice
        label="Token"
        replayLabel
        value="private-token"
        choices={[["private-token", "private-token-name"]]}
        onChange={() => {}}
      />
      <ColorField
        label="Fill"
        replayLabel
        nodes={[
          buildDrawnNode("fixture", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
        ]}
        get={() => "#123abc"}
        onChange={() => {}}
      />
    </Section>,
  );
  expect(html).toMatch(/data-ph-public="true"[^>]*>Position</);
  const widthLabel = html.match(/<label for="([^"]+)" data-ph-public="true">Width<\/label>/);
  expect(widthLabel).not.toBeNull();
  const widthInput = [...html.matchAll(/<input\b[^>]*>/g)]
    .map(([tag]) => tag)
    .find((tag) => tag.includes(`id="${widthLabel![1]}"`));
  expect(widthInput).toContain('value="private-value"');
  expect(widthInput).not.toContain("data-ph-public");
  expect(html).toMatch(/<label for="[^"]+">private-property-name<\/label>/);
  expect(html).not.toMatch(/data-ph-public="true"[^>]*>private-/);
  expect(html).toMatch(/data-ph-private="true"[^>]*>private-token-name</);
  expect(html).toMatch(/data-ph-private="true"[^>]*style="background-color:#123abc"/);
});

test("approved dropdown descriptions exclude the user's selected option", () => {
  const html = renderToStaticMarkup(
    <SelectMenu
      label="Destination"
      replayLabel
      value="secret"
      options={[{ value: "secret", label: "private-frame-name" }]}
      onChange={() => {}}
    />,
  );
  expect(html).toContain('data-ph-control-label="Destination"');
  expect(html).toMatch(/data-ph-private="true"[^>]*>private-frame-name</);
  const element = {
    closest: () => null,
    hasAttribute: (name: string) => name === "data-ph-control-label",
    getAttribute: () => "Destination",
  } as unknown as Element;
  expect(replayAttribute("aria-label", "Destination: private-frame-name", element)).toBe(
    "Destination",
  );
  expect(replayAttribute("href", "/files/private-id", element)).toBe("");
  expect(replayAttribute("data-private-value", "secret", element)).toBe("");
  expect(replayAttribute("title", "private-frame-name", element)).toBe("");
});

test("private boundaries override public descendants and hide visual values", () => {
  const element = {
    closest: () => ({}),
    hasAttribute: () => true,
    getAttribute: () => "private-label",
  } as unknown as HTMLElement;
  expect(replayText("private-property-name", element)).toBe("[hidden]");
  expect(replayAttribute("style", "background-color: #123abc", element)).toBe("");
  expect(replayAttribute("aria-label", "private-property-name", element)).toBe("");
  expect(replayAttribute("title", "private-property-name", element)).toBe("");
  expect(replayText("unreviewed text")).toBe("[hidden]");
  expect(replayText(" \n\t")).toBe(" \n\t");
  expect(replayText("")).toBe("");
});

test("layer controls retain only the static tree label in replay", () => {
  const node = {
    ...buildDrawnNode("fixture", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
    name: "private-layer-name",
  };
  const html = renderToStaticMarkup(
    <LayerTree
      nodes={[node]}
      selectedIds={[]}
      query=""
      onSelect={() => {}}
      onMenu={() => {}}
      onMove={() => {}}
      onVisibility={() => {}}
      onLock={() => {}}
    />,
  );
  expect(html).toMatch(/data-ph-control-label="Layers"[^>]*role="tree"/);
  const buttons = [
    ...html.matchAll(/<button\b[^>]*aria-label="[^"]*private-layer-name[^"]*"[^>]*>/g),
  ];
  expect(buttons).toHaveLength(3);
  for (const [button] of buttons)
    expect(button).not.toMatch(/data-ph-(public-label|control-label)/);

  const tree = {
    closest: () => null,
    hasAttribute: (name: string) => name === "data-ph-control-label",
    getAttribute: () => "Layers",
  } as unknown as Element;
  expect(replayAttribute("aria-label", "Layers", tree)).toBe("Layers");
  const rowButton = {
    // An ancestor match must not authorize a descendant's attributes.
    closest: (selector: string) =>
      /^\[data-ph-(public-label|control-label)\]$/.test(selector) ? tree : null,
    hasAttribute: () => false,
  } as unknown as Element;
  for (const action of ["Select", "Hide", "Show", "Lock", "Unlock"]) {
    expect(replayAttribute("aria-label", `${action} ${node.name}`, rowButton)).toBe("");
    expect(replayAttribute("title", `${action} ${node.name}`, rowButton)).toBe("");
  }
});

function replayElement(boundary?: string, svg = false) {
  return {
    namespaceURI: svg ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml",
    closest: (selector: string) =>
      selector === "[data-ph-public]" || (boundary && selector.split(", ").includes(boundary))
        ? {}
        : null,
    hasAttribute: () => false,
  } as unknown as HTMLElement;
}

function withReplayLocation(check: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: new URL("https://replay.example.test/files"),
  });
  try {
    check();
  } finally {
    if (original) Object.defineProperty(globalThis, "location", original);
    else Reflect.deleteProperty(globalThis, "location");
  }
}

test("replay preserves every bundled icon's actual CSS mask without making its label public", () => {
  withReplayLocation(() => {
    for (const [name, source] of Object.entries(iconSources)) {
      const html = renderToStaticMarkup(<Icon name={name as keyof typeof iconSources} />);
      // Use the component's rendered styles, including both mask declarations.
      const style = html.match(/style="([^"]*)"/)![1].replaceAll("&quot;", '"');
      expect(style).toContain(source);
      expect(replayAttribute("style", style, replayElement())).toBe(style);
      expect(html).not.toContain("data-ph-public");
      expect(replayAttribute("aria-label", "private icon label", replayElement())).toBe("");
    }
  });
});

test("asset approval is exact: uploads, arbitrary build assets and URL suffixes stay redacted", () => {
  withReplayLocation(() => {
    const approved = iconSources.folder;
    const urls = [
      "/icons/customer-upload.svg",
      "/icons/iconoir/folder.svg?private-account=secret",
      "/_next/static/media/customer-upload.123.svg",
      "/api/assets/private-asset",
      "/api/assets/private)asset.svg",
      "/api/assets/private(asset).svg",
      "https://uploads.example.test/customer.svg",
      "https://replay.example.test.evil.test/icons/folder.svg",
      "data:image/svg+xml,private-content",
      "blob:https://replay.example.test/private-content",
      `${approved}?private-account=secret`,
      `${approved}#private-layer`,
      `${approved}.private.svg`,
    ];
    for (const url of urls) {
      const style = `mask-image: url("${url}"); background-image: url("${url}")`;
      const masked = replayAttribute("style", style, replayElement());
      expect(masked).toBe("mask-image: none; background-image: none");
      expect(masked).not.toContain(url);
    }
    expect(replayAttribute("src", approved, replayElement())).toBe("");
    expect(replayAttribute("href", approved, replayElement())).toBe("");
  });
});

test("every private boundary overrides public chrome for text, built-in icons and SVG paths", () => {
  withReplayLocation(() => {
    for (const boundary of [
      ".ph-mask",
      ".ph-no-capture",
      "[data-ph-private]",
      "[contenteditable]",
      "[data-node-id]",
      "[data-design-font]",
      "input",
      "textarea",
      "select",
    ]) {
      const element = replayElement(boundary, true);
      expect(replayText("private-user-content", element)).toBe("[hidden]");
      expect(replayAttribute("style", `mask-image:url("${iconSources.folder}")`, element)).toBe("");
      expect(replayAttribute("d", "M 1 2 L 3 4", element)).toBe("");
      expect(replayAttribute("value", "private-input", element)).toBe("");
      expect(replayAttribute("title", "private-name", element)).toBe("");
    }
    expect(replayText("Files", replayElement())).toBe("Files");
    expect(replayAttribute("d", "M 1 2 L 3 4", replayElement(undefined, true))).toBe("M 1 2 L 3 4");
  });
});

test("bundler-relative deployment URLs are canonicalized without approving caller-supplied suffixes", () => {
  // Isolate the synthetic bundler manifest so it cannot alter other SDK tests.
  execFileSync(
    process.execPath,
    [
      "--eval",
      `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    mock.module("@tidy/editor/components/ui/icon-sources", () => ({
      iconSources: { folder: "/_next/static/media/folder.build.svg?dpl=release" },
    }));
    globalThis.location = new URL("https://replay.example.test/files");
    const { replayAttribute } = await import("./replay.ts");
    const element = { closest: () => null };
    const approved = "/_next/static/media/folder.build.svg?dpl=release";
    for (const url of [approved, location.origin + approved]) {
      const style = 'mask-image:url("' + url + '")';
      assert.equal(replayAttribute("style", style, element), style);
    }
    for (const url of [
      approved + "&private=secret", approved + "#private",
      approved.replace("release", "another-release"),
      "/private-account/.." + approved,
      approved.replace("folder.build.svg", "private-account/../folder.build.svg"),
      "https://evil.example.test" + approved,
      "/_next/static/media/customer.build.svg?dpl=release",
    ]) assert.equal(replayAttribute("style", 'mask-image:url("' + url + '")', element), "mask-image:none");
  `,
    ],
    { cwd: import.meta.dirname, stdio: "pipe" },
  );
});
