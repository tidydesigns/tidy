// Invoke in the collaborative browser on a disposable, editable file:
// transpile this module, then evaluate checkPendingEditNavigation.toString().
// Delays writes in the page rather than changing the server or using a real outage.
export async function checkPendingEditNavigation() {
  const results: string[] = [];
  function check(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
    results.push(message);
  }
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
  const fileId = location.pathname.match(/^\/files\/([^/]+)$/)?.[1];
  check(fileId, "Run this regression on an editable disposable file");
  const originalFetch = window.fetch;
  const before = (await (await originalFetch(`/api/files/${fileId}/changes`)).json()) as {
    canEdit: boolean;
    snapshot: { content: { nodes: unknown[] } };
  };
  check(before.canEdit, "The fixture has editor access");
  const beforeCount = before.snapshot.content.nodes.length as number;
  const writes: { release: () => Promise<void>; aborted: boolean }[] = [];
  window.fetch = Object.assign(
    (input: Parameters<typeof originalFetch>[0], init?: Parameters<typeof originalFetch>[1]) => {
      if (init?.method === "POST" && String(input).endsWith("/changes")) {
        return new Promise<Response>((resolve, reject) => {
          let released = false;
          const write = {
            aborted: false,
            release: async () => {
              if (released) return;
              released = true;
              try {
                resolve(await originalFetch(input, init));
              } catch (error) {
                reject(error);
              }
            },
          };
          writes.push(write);
          init.signal?.addEventListener("abort", () => {
            write.aborted = true;
            reject(new DOMException("The edit was canceled before persistence", "AbortError"));
          });
        });
      }
      return originalFetch(input, init);
    },
    originalFetch,
  );
  const canvas = document.querySelector<HTMLElement>('[aria-label="Design canvas"]');
  check(canvas, "The design canvas is ready");
  const capture = canvas.setPointerCapture;
  try {
    const tool = [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Rectangle tool"]'),
    ].find((element) => element.checkVisibility());
    check(tool, "The rectangle tool is available");
    tool.click();
    await settle();
    canvas.setPointerCapture = () => {};
    const rect = canvas.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    for (const [type, offset, buttons] of [
      ["pointerdown", 0, 1],
      ["pointermove", 80, 1],
      ["pointerup", 80, 0],
    ] as const) {
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "mouse",
          button: 0,
          buttons,
          clientX: x + offset,
          clientY: y + offset,
        }),
      );
      await settle();
    }
    check(writes.length === 1, "A visible layer has a pending server write");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    check(unload.defaultPrevented, "Reload and tab close are guarded while edits are pending");
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    if (navigation) {
      const traversal = new Event("navigate", { cancelable: true });
      Object.defineProperty(traversal, "navigationType", { value: "traverse" });
      navigation.dispatchEvent(traversal);
      check(traversal.defaultPrevented, "Browser history traversal is guarded where supported");
    }
    const back = [
      ...document.querySelectorAll<HTMLAnchorElement>('a[aria-label="Back to files"]'),
    ].find((element) => element.checkVisibility());
    check(back, "The file navigation is available");
    const path = location.pathname;
    back.click();
    await settle();
    check(location.pathname === path, "Back to files retains the editor until the write finishes");
    check(
      writes.every((write) => !write.aborted),
      "Blocked navigation does not cancel edits",
    );
    check(
      document.body.innerText.includes("Your changes are still syncing"),
      "The editor explains why navigation is blocked",
    );
    window.fetch = originalFetch;
    await Promise.all(writes.map((write) => write.release()));
    for (let attempt = 0; attempt < 30; attempt++) {
      await settle();
      const unload = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(unload);
      if (!unload.defaultPrevented) break;
      check(attempt < 29, "The guard releases after successful synchronization");
    }
    const after = (await (await originalFetch(`/api/files/${fileId}/changes`)).json()) as {
      snapshot: { content: { nodes: unknown[] } };
    };
    check(
      after.snapshot.content.nodes.length === beforeCount + 1,
      "The new layer persists on the server",
    );
    const unloadAfter = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unloadAfter);
    check(!unloadAfter.defaultPrevented, "Saved files do not produce unnecessary leave warnings");
    back.click();
    for (let attempt = 0; attempt < 30 && location.pathname === path; attempt++) await settle();
    check(location.pathname === "/files", "Back to files works normally after synchronization");
    return results;
  } finally {
    window.fetch = originalFetch;
    canvas.setPointerCapture = capture;
    await Promise.all(writes.filter((write) => !write.aborted).map((write) => write.release()));
  }
}
