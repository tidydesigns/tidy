import { afterEach, beforeEach, expect, test } from "bun:test";
import { createExportImageSession, embedDesignImages, embedThumbnailImages } from "./export-images";

const originalFetch = globalThis.fetch;
const originalReader = globalThis.FileReader;
const originalImageElement = globalThis.HTMLImageElement;
const originalTimeout = AbortSignal.timeout;
class TestImage {
  src: string;
  constructor(private original: string) {
    this.src = original;
  }
  getAttribute(name: string) {
    return name === "data-original-src" ? this.original : null;
  }
}
class TestFileReader {
  result: string | null = null;
  onload?: () => void;
  onerror?: (error: unknown) => void;
  canceled = false;
  abort() {
    this.canceled = true;
  }
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(
      (bytes) => {
        if (this.canceled) return;
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
        this.onload?.();
      },
      (error) => this.onerror?.(error),
    );
  }
}
beforeEach(() => {
  globalThis.FileReader = TestFileReader as unknown as typeof FileReader;
  globalThis.HTMLImageElement = TestImage as unknown as typeof HTMLImageElement;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.FileReader = originalReader;
  globalThis.HTMLImageElement = originalImageElement;
  AbortSignal.timeout = originalTimeout;
});
function images(body = new Uint8Array([1, 2, 3])) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return new Response(body, { headers: { "Content-Type": "image/png" } });
  }) as unknown as typeof fetch;
  return calls;
}

test("raster exports embed CSS image masks once and keep the intersection layer", async () => {
  const calls = images();
  const style = {
    maskImage: 'url("/api/assets/mask"), linear-gradient(white, white)',
    webkitMaskImage: "",
  };
  const second = { maskImage: style.maskImage, webkitMaskImage: "" };
  const clone = {
    querySelectorAll(selector: string) {
      return selector === "[style]" ? [{ style }, { style: second }] : [];
    },
  } as unknown as HTMLElement;
  await embedDesignImages(clone);
  expect(calls).toEqual(["/api/assets/mask"]);
  expect(style.maskImage).toBe('url("data:image/png;base64,AQID"), linear-gradient(white, white)');
  expect(second.maskImage).toBe(style.maskImage);
  expect(style.webkitMaskImage).toBe(style.maskImage);
});

test("thumbnail capture tolerates missing local images and masks while exports remain strict", async () => {
  const missing = "/__tidy/assets/project/missing";
  const available = "/__tidy/assets/project/available";
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return url === missing
      ? new Response(null, { status: 404 })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } });
  }) as unknown as typeof fetch;
  const absent = new TestImage(missing),
    present = new TestImage(available);
  const style = {
    maskImage: `url("${missing}"), linear-gradient(white, white)`,
    webkitMaskImage: "",
  };
  const clone = {
    querySelectorAll(selector: string) {
      return selector === "img, svg image"
        ? [absent, present]
        : selector === "[style]"
          ? [{ style }]
          : [];
    },
  } as unknown as HTMLElement;
  expect(await embedThumbnailImages(clone)).toBe(false);
  expect(calls).toEqual([missing, available]);
  expect(decodeURIComponent(absent.src)).toContain('fill="#eeeeee"');
  expect(present.src).toBe("data:image/png;base64,AQID");
  expect(style.maskImage).not.toContain(missing);
  expect(style.maskImage).toContain("linear-gradient(white, white)");
  expect(decodeURIComponent(style.maskImage)).toContain('width="1"');
  await expect(embedDesignImages(clone)).rejects.toThrow(
    "Could not include an image in the export.",
  );
});

test("thumbnail cancellation is not converted into a successful partial capture", async () => {
  const controller = new AbortController();
  globalThis.fetch = (async () => {
    controller.abort(new Error("Thumbnail canceled"));
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const image = new TestImage("/__tidy/assets/project/pending");
  const clone = {
    querySelectorAll(selector: string) {
      return selector === "img, svg image" ? [image] : [];
    },
  } as unknown as HTMLElement;
  await expect(embedThumbnailImages(clone, controller.signal)).rejects.toThrow(
    "Thumbnail canceled",
  );
  expect(image.src).toBe("/__tidy/assets/project/pending");
});

test("a failed strict export waits for a stalled external image's bounded cleanup", async () => {
  const deadlines: AbortController[] = [];
  AbortSignal.timeout = (milliseconds) => {
    expect(milliseconds).toBe(15_000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  };
  let cleaned = false,
    settled = false;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (url.endsWith("missing")) return new Response(null, { status: 404 });
    return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener(
        "abort",
        () => {
          cleaned = true;
          reject(options.signal!.reason);
        },
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
  const images = [
    new TestImage("https://external.example/missing"),
    new TestImage("https://external.example/stalled"),
  ];
  const clone = {
    querySelectorAll(selector: string) {
      return selector === "img, svg image" ? images : [];
    },
  } as unknown as HTMLElement;
  const result = embedDesignImages(clone).then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Bun.sleep(0);
    expect(deadlines).toHaveLength(2);
    expect(settled).toBe(false);
    expect(cleaned).toBe(false);
  } finally {
    for (const deadline of deadlines)
      deadline.abort(new DOMException("Image timed out", "TimeoutError"));
  }
  expect(await result).toEqual(new Error("Could not include an image in the export."));
  expect(cleaned).toBe(true);
  expect(settled).toBe(true);
});

test("external image deadlines also cancel a pending data-URL conversion", async () => {
  const deadline = new AbortController();
  AbortSignal.timeout = () => deadline.signal;
  let converting = false,
    canceled = false;
  globalThis.FileReader = class {
    abort() {
      canceled = true;
    }
    readAsDataURL() {
      converting = true;
    }
  } as unknown as typeof FileReader;
  images();
  const session = createExportImageSession();
  const loading = session.load("https://external.example/original").catch((error) => error);
  try {
    await Bun.sleep(0);
    expect(converting).toBe(true);
    deadline.abort(new DOMException("Image timed out", "TimeoutError"));
    expect((await loading).name).toBe("TimeoutError");
    expect(canceled).toBe(true);
  } finally {
    session.dispose();
  }
});

test("an export shares identical original bytes and in-flight reads, then releases them", async () => {
  const calls = images();
  const session = createExportImageSession();
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => session.load("/api/assets/original")),
    );
    expect(results).toEqual(Array(20).fill("data:image/png;base64,AQID"));
    expect(calls).toEqual(["/api/assets/original"]);
  } finally {
    session.dispose();
  }
  await expect(session.load("/api/assets/original")).rejects.toThrow();
  const nextExport = createExportImageSession();
  try {
    await nextExport.load("/api/assets/original");
  } finally {
    nextExport.dispose();
  }
  expect(calls).toHaveLength(2);
});

test("different source versions stay separate and external mutable URLs are never retained", async () => {
  const calls = images();
  const session = createExportImageSession();
  try {
    for (const source of [
      "/api/assets/id?version=one",
      "/api/assets/id?version=two",
      "https://external.example/image.png",
      "https://external.example/image.png",
    ])
      await session.load(source);
    expect(calls).toHaveLength(4);
    await session.load("/api/assets/id?version=one");
    expect(calls).toHaveLength(4);
  } finally {
    session.dispose();
  }
});

test("retained original strings stay bounded and eviction never prevents export", async () => {
  const calls = images(new Uint8Array(2 * 1024 * 1024));
  const session = createExportImageSession();
  try {
    const first = await session.load("/api/assets/large-one");
    await session.load("/api/assets/large-two");
    expect(await session.load("/api/assets/large-one")).toBe(first);
    expect(calls).toEqual([
      "/api/assets/large-one",
      "/api/assets/large-two",
      "/api/assets/large-one",
    ]);
  } finally {
    session.dispose();
  }
});

test("small originals have a bounded entry count and keep recently reused entries", async () => {
  const calls = images();
  const session = createExportImageSession();
  try {
    for (let index = 0; index < 65; index++) await session.load(`/api/assets/${index}`);
    await session.load("/api/assets/64");
    expect(calls).toHaveLength(65);
    await session.load("/api/assets/0");
    expect(calls).toHaveLength(66);
  } finally {
    session.dispose();
  }
});

test("authorization failures aren't retained and a subsequent load checks access again", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: calls === 1 ? 403 : 200 });
  }) as unknown as typeof fetch;
  const session = createExportImageSession();
  try {
    await expect(session.load("/api/assets/private")).rejects.toThrow("403");
    await session.load("/api/assets/private");
    expect(calls).toBe(2);
  } finally {
    session.dispose();
  }
});

test("cancellation removes reuse eligibility and aborts a pending original fetch", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let signal!: AbortSignal;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    signal = init.signal!;
    entered();
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  }) as unknown as typeof fetch;
  const controller = new AbortController();
  const session = createExportImageSession(controller.signal);
  const pending = session.load("/api/assets/pending");
  void pending.catch(() => {});
  await started;
  controller.abort(new Error("export canceled"));
  await expect(pending).rejects.toThrow("export canceled");
  expect(signal.aborted).toBe(true);
  await expect(session.load("/api/assets/pending")).rejects.toThrow("export canceled");
  session.dispose();
});

test("disposing an export aborts pending data-URL conversion", async () => {
  images();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let canceled = false;
  class PausedReader extends TestFileReader {
    abort() {
      super.abort();
      canceled = true;
    }
    readAsDataURL() {
      entered();
    }
  }
  globalThis.FileReader = PausedReader as unknown as typeof FileReader;
  const session = createExportImageSession();
  const pending = session.load("/api/assets/converting");
  void pending.catch(() => {});
  await started;
  session.dispose();
  await expect(pending).rejects.toThrow();
  expect(canceled).toBe(true);
});
