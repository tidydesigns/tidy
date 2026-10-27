import { describe, expect, test } from "bun:test";
import { createDemoAPI } from "./host";
import { demoId, project } from "./fixture";
import type { DesktopEvent } from "../shared/contracts/desktop";

describe("website desktop host", () => {
  test("canvas edits reach both preview and reopened design, with version conflicts rejected", async () => {
    const api = createDemoAPI();
    const events: DesktopEvent[] = [];
    const unsubscribe = api.onEvent((event) => events.push(event));
    const original = await api.readDesign(project.id, demoId(2));
    const headline = original.document.nodes.find((node) => node.id === "headline")!;
    headline.text = "An idea worth making.";
    const edited = await api.updateDesign({
      projectId: project.id,
      designId: original.id,
      expectedVersion: original.version,
      document: original.document,
    });
    expect(edited.version).toBe("2");
    expect(
      (await api.previewDesign(project.id, original.id)).document.nodes.find(
        (n) => n.id === "headline",
      )?.text,
    ).toBe("An idea worth making.");
    expect((await api.refreshDesign(project.id, original.id, "1"))?.version).toBe("2");
    expect(await api.refreshDesign(project.id, original.id, "2")).toBeNull();
    expect(events.some((event) => event.type === "designs")).toBe(true);
    await expect(
      api.updateDesign({
        projectId: project.id,
        designId: original.id,
        expectedVersion: "1",
        name: "Stale",
      }),
    ).rejects.toThrow("design changed");
    unsubscribe();
  });

  test("threads share a real design, maintain independent messages and emit updates", async () => {
    const api = createDemoAPI();
    const first = await api.readThread(project.id, demoId(10));
    const second = await api.readThread(project.id, demoId(20));
    expect(first.designIds).toEqual(second.designIds);
    const updated = await api.sendMessage({
      projectId: project.id,
      threadId: first.id,
      text: "Try a smaller headline.",
    });
    expect(updated.messages.at(-2)?.text).toBe("Try a smaller headline.");
    expect(updated.messages.at(-1)?.text).toContain("demo");
    expect((await api.readThread(project.id, second.id)).messages).toEqual(second.messages);
  });

  test("sample state is isolated per renderer and API results cannot mutate stored state", async () => {
    const api = createDemoAPI();
    const design = await api.readDesign(project.id, demoId(2));
    design.name = "Modified outside API";
    expect((await api.readDesign(project.id, design.id)).name).not.toBe(design.name);
    await api.updateDesign({
      projectId: project.id,
      designId: design.id,
      expectedVersion: design.version,
      name: "Edited",
    });
    expect((await createDemoAPI().readDesign(project.id, design.id)).name).not.toBe("Edited");
    await expect(api.readDesign(demoId(999), design.id)).rejects.toThrow("sample project");
    expect(api.cloud).toBeUndefined();
  });

  test("new designs are empty editable documents and uploads reject remote URLs", async () => {
    const api = createDemoAPI();
    const value = await api.createDesign(project.id);
    expect(value.document.nodes).toEqual([]);
    expect(value.nodeCount).toBe(0);
    await expect(
      api.uploadDesignAsset(project.id, "https://example.com/image.png"),
    ).rejects.toThrow("Choose an image");
  });
});
