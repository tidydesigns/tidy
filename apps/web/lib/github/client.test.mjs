import { afterEach, expect, mock, test } from "bun:test";
import {
  exchangeToken,
  githubRequest,
  GitHubError,
  GitHubWorkLimitError,
  paginated,
  readLimited,
  boundedGitHubOperation,
} from "./client";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.GITHUB_CLIENT_SECRET;
const originalTimeout = AbortSignal.timeout;
afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  if (originalSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
  else process.env.GITHUB_CLIENT_SECRET = originalSecret;
});

test("paginated GitHub results preserve order and existing query parameters", async () => {
  const first = Array.from({ length: 100 }, (_, id) => ({ id }));
  globalThis.fetch = mock(async (url) => {
    const query = new URL(url).searchParams;
    expect(query.get("state")).toBe("all");
    expect(query.getAll("per_page")).toEqual(["100"]);
    return Response.json({ repositories: query.get("page") === "1" ? first : [{ id: 100 }] });
  });
  expect(await paginated("token", "/repositories?state=all", "repositories")).toEqual([
    ...first,
    { id: 100 },
  ]);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});

test("a full pagination ceiling rejects without returning a partial authorization search", async () => {
  globalThis.fetch = mock(async () =>
    Response.json(Array.from({ length: 100 }, (_, id) => ({ id }))),
  );
  await expect(paginated("token", "/comments")).rejects.toBeInstanceOf(GitHubWorkLimitError);
  expect(globalThis.fetch).toHaveBeenCalledTimes(20);
});

test("pagination caps aggregate UTF-8 bytes even when each page is below its individual limit", async () => {
  // Approximately 3 MB/page: each page is valid individually; their combined body is too large.
  const page = JSON.stringify(Array.from({ length: 100 }, () => ({ body: "界".repeat(10000) })));
  const canceled = mock(() => {});
  // Close successful pages, while keeping the overflowing response open to observe cancellation.
  globalThis.fetch = mock(async () => {
    const number = globalThis.fetch.mock.calls.length;
    if (number < 6) return new Response(page);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(page));
        },
        cancel: canceled,
      }),
    );
  });
  await expect(paginated("token", "/comments")).rejects.toThrow("too large");
  expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  expect(canceled).toHaveBeenCalledTimes(1);
});

for (const data of [null, {}, { comments: {} }, { comments: Array(101).fill({}) }]) {
  test(`pagination rejects malformed or oversized result arrays: ${JSON.stringify(data).slice(0, 60)}`, async () => {
    globalThis.fetch = mock(async () => Response.json(data));
    await expect(paginated("token", "/comments", "comments")).rejects.toThrow(
      "invalid result page",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
}

test("pagination retains one operation deadline across response reads and subsequent pages", async () => {
  const operation = new AbortController();
  const durations = [];
  AbortSignal.timeout = (duration) => {
    durations.push(duration);
    return duration === 30000 ? operation.signal : originalTimeout(duration);
  };
  const canceled = mock(() => {});
  globalThis.fetch = mock(async () => {
    if (globalThis.fetch.mock.calls.length === 1) return Response.json(Array(100).fill({ id: 1 }));
    return new Response(new ReadableStream({ cancel: canceled }));
  });
  const work = paginated("token", "/comments");
  // Let the second page start reading its stalled response before expiring the operation.
  while (globalThis.fetch.mock.calls.length < 2) await Bun.sleep(1);
  operation.abort(new DOMException("Operation deadline", "TimeoutError"));
  await expect(work).rejects.toThrow("Operation deadline");
  expect(durations.filter((duration) => duration === 30000)).toHaveLength(1);
  expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  expect(canceled).toHaveBeenCalledTimes(1);
});

test("a canceled API caller stops a stalled response body", async () => {
  const caller = new AbortController();
  const canceled = mock(() => {});
  globalThis.fetch = mock(async () => new Response(new ReadableStream({ cancel: canceled })));
  const work = githubRequest("token", "/user", { signal: caller.signal });
  await Bun.sleep(1);
  caller.abort(new Error("Caller canceled"));
  await expect(work).rejects.toThrow("Caller canceled");
  expect(canceled).toHaveBeenCalledTimes(1);
});

test("response deadlines do not wait for a stalled cancellation acknowledgement", async () => {
  const timeout = new AbortController();
  const canceled = mock(() => new Promise(() => {}));
  const work = readLimited(
    new Response(new ReadableStream({ cancel: canceled })),
    100,
    timeout.signal,
  );
  timeout.abort(new Error("Read deadline"));
  await expect(work).rejects.toThrow("Read deadline");
  expect(canceled).toHaveBeenCalledTimes(1);
});

test("OAuth response bodies retain the request deadline after headers arrive", async () => {
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
  const timeout = new AbortController();
  AbortSignal.timeout = () => timeout.signal;
  const canceled = mock(() => {});
  globalThis.fetch = mock(async () => new Response(new ReadableStream({ cancel: canceled })));
  const work = exchangeToken({ code: "test-code" });
  await Bun.sleep(1);
  timeout.abort(new Error("OAuth deadline"));
  await expect(work).rejects.toThrow("OAuth deadline");
  expect(canceled).toHaveBeenCalledTimes(1);
});

test("nested provider operations share admission before sending any excess HTTP requests", async () => {
  globalThis.fetch = mock(async () => Response.json({ id: 1 }));
  const inner = boundedGitHubOperation(() => githubRequest("token", "/user"));
  const outer = boundedGitHubOperation(async () => {
    for (let count = 0; count < 41; count++) await inner();
  });
  await expect(outer()).rejects.toBeInstanceOf(GitHubWorkLimitError);
  expect(globalThis.fetch).toHaveBeenCalledTimes(40);
});

test("parallel provider lookups cannot each obtain a fresh nested request allowance", async () => {
  globalThis.fetch = mock(async () => Response.json({ id: 1 }));
  const inner = boundedGitHubOperation(async () => {
    for (let count = 0; count < 25; count++) await githubRequest("token", "/user");
  });
  const outer = boundedGitHubOperation(() => Promise.allSettled([inner(), inner()]));
  const results = await outer();
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(results.every((result) => result.reason instanceof GitHubWorkLimitError)).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(40);
});

test("simultaneous independent operations do not spend each other's allowance", async () => {
  globalThis.fetch = mock(async () => Response.json({ id: 1 }));
  const operation = boundedGitHubOperation(async () => {
    for (let count = 0; count < 40; count++) await githubRequest("token", "/user");
    return "complete";
  });
  expect(await Promise.all([operation(), operation()])).toEqual(["complete", "complete"]);
  expect(globalThis.fetch).toHaveBeenCalledTimes(80);
});

test("failed provider requests consume work allowance rather than enabling unlimited retries", async () => {
  globalThis.fetch = mock(async () => new Response(null, { status: 503 }));
  const operation = boundedGitHubOperation(async () => {
    for (let count = 0; count < 40; count++) await githubRequest("token", "/user").catch(() => {});
    return githubRequest("token", "/user");
  });
  await expect(operation()).rejects.toBeInstanceOf(GitHubWorkLimitError);
  expect(globalThis.fetch).toHaveBeenCalledTimes(40);
});

test("one operation bounds total response bytes across unrelated provider endpoints", async () => {
  const page = JSON.stringify({ body: "界".repeat(1000000) });
  globalThis.fetch = mock(async () => new Response(page));
  const operation = boundedGitHubOperation(async () => {
    for (let count = 0; count < 40; count++) await githubRequest("token", `/endpoint/${count}`);
  });
  await expect(operation()).rejects.toBeInstanceOf(GitHubWorkLimitError);
  expect(globalThis.fetch).toHaveBeenCalledTimes(9);
});

test("an expired operation cannot begin a new nested provider request", async () => {
  const timeout = new AbortController();
  AbortSignal.timeout = (duration) =>
    duration === 30000 ? timeout.signal : originalTimeout(duration);
  globalThis.fetch = mock(async () => Response.json({ id: 1 }));
  const inner = boundedGitHubOperation(() => githubRequest("token", "/user"));
  const operation = boundedGitHubOperation(async () => {
    await inner();
    timeout.abort(new Error("Operation expired"));
    return inner();
  });
  await expect(operation()).rejects.toThrow("Operation expired");
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("OAuth exchange and authenticated API reads use Worker-compatible requests", async () => {
  process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
  const requests = [];
  globalThis.fetch = mock(async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    expect(request.redirect).toBe("manual");
    return Response.json(
      request.method === "POST" ? { access_token: "test-token" } : { id: 1, login: "reviewer" },
    );
  });

  const token = await exchangeToken({ code: "test-code", code_verifier: "test-verifier" });
  expect(await githubRequest(token.access_token, "/user")).toEqual({ id: 1, login: "reviewer" });
  expect(requests.map((request) => request.url)).toEqual([
    "https://github.com/login/oauth/access_token",
    "https://api.github.com/user",
  ]);
  expect(await requests[0].json()).toMatchObject({
    client_secret: "test-client-secret",
    code: "test-code",
    code_verifier: "test-verifier",
  });
  expect(requests[1].headers.get("authorization")).toBe("Bearer test-token");
});

for (const status of [301, 302, 303, 307, 308]) {
  for (const operation of ["token exchange", "API request"]) {
    test(`${operation} rejects HTTP ${status} without following or reading the redirect`, async () => {
      process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
      const cancel = mock(() => {});
      globalThis.fetch = mock(async (_url, init) => {
        expect(init.redirect).toBe("manual");
        return new Response(new ReadableStream({ cancel }), {
          status,
          headers: { Location: "https://untrusted.example/collect" },
        });
      });
      // A caller must not be able to opt back into forwarding credentials.
      const result =
        operation === "token exchange"
          ? exchangeToken({ code: "test-code" })
          : githubRequest("test-token", "/user", { redirect: "follow" });
      const error = await result.catch((error) => error);
      expect(error).toBeInstanceOf(GitHubError);
      expect(error.status).toBe(status);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  }
}
