import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PropertyField } from "../../app/files/[uid]/property-field";
import { Choice, ColorField, Section } from "../../app/files/[uid]/inspector-controls";
import { SelectMenu } from "@tidy/ui/select-menu";
import { replayAttribute, replayText } from "./replay";
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
