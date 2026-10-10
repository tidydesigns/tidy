import { Client } from "pg";
import { writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { designNodeSchema, blankDesignDocument } from "../design/document";
import { linearReadFixture } from "./linear-read-fixture.mjs";

// Called only inside the disposable PostgreSQL harness. All HTTP calls go to
// loopback; the same authenticated POST handler serves both protocol revisions.
export async function benchmarkMcp({ POST, auth, admin, grant, fetch }) {
  await admin.query('update "billingDeployment" set "selfHosted"=true');
  const linear = await linearReadFixture(admin, () => Bun.sleep(100));
  const { token } = await auth.api.signJWT({
    body: { payload: grant({ scope: linear.scope }).claims },
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: POST });
  const originalQuery = Client.prototype.query;
  let queries = 0;
  const profileQueries = process.env.MCP_BENCHMARK_PROFILE === "1";
  let queryProfile = new Map();
  const queryDelayMs = Number(process.env.MCP_BENCHMARK_QUERY_DELAY_MS ?? 0);
  Client.prototype.query = function (...args) {
    if (this !== admin) queries++;
    const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
    const started = performance.now();
    const record = () => {
      if (!profileQueries || this === admin) return;
      // Fixture queries only, without bound parameters or document contents.
      const key = String(sql)
        .replace(/tidy_scope_\d+/g, "tidy_scope_N")
        .replace(/\s+/g, " ")
        .trim();
      const row = queryProfile.get(key) ?? { sql: key, count: 0, elapsedMs: 0 };
      row.count++;
      row.elapsedMs += performance.now() - started;
      queryProfile.set(key, row);
    };
    if (profileQueries && this !== admin) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = (...result) => {
          record();
          if (queryDelayMs > 0) setTimeout(() => callback(...result), queryDelayMs);
          else callback(...result);
        };
        return originalQuery.apply(this, args);
      }
      return originalQuery
        .apply(this, args)
        .finally(record)
        .then(async (result) => {
          if (queryDelayMs > 0) await Bun.sleep(queryDelayMs);
          return result;
        });
    }
    if (this !== admin && queryDelayMs > 0) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = (...result) => setTimeout(() => callback(...result), queryDelayMs);
      } else {
        return originalQuery.apply(this, args).then(async (result) => {
          await Bun.sleep(queryDelayMs);
          return result;
        });
      }
    }
    return originalQuery.apply(this, args);
  };
  const samples = Number(process.env.MCP_BENCHMARK_SAMPLES ?? 40);
  const results = [];
  async function call(method, params, modern = false) {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": modern ? "2026-07-28" : "2025-06-18",
        ...(modern
          ? { "Mcp-Method": method, ...(params?.name ? { "Mcp-Name": params.name } : {}) }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          ...(modern
            ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientInfo": {
                    name: "tidy-benchmark",
                    version: "1.0.0",
                  },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              }
            : {}),
        },
      }),
    });
    const body = await response.text();
    const message = response.headers.get("content-type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)))
          .find((value) => value.id === 1)
      : JSON.parse(body);
    if (!response.ok || message?.error || message?.result?.isError)
      throw new Error(`Benchmark request failed: ${body.slice(0, 500)}`);
    return { bytes: Buffer.byteLength(body), result: message.result };
  }
  async function measure(name, work, concurrency = 1) {
    for (let i = 0; i < 5; i++) await work();
    queries = 0;
    queryProfile = new Map();
    const latency = [];
    let bytes = 0;
    const cpu = process.cpuUsage();
    const started = performance.now();
    for (let i = 0; i < samples; i += concurrency) {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, samples - i) }, async () => {
          const start = performance.now();
          const response = await work();
          latency.push(performance.now() - start);
          bytes += response.bytes;
        }),
      );
    }
    const elapsed = performance.now() - started;
    const used = process.cpuUsage(cpu);
    latency.sort((a, b) => a - b);
    const round = (n) => Math.round(n * 100) / 100;
    const row = {
      name,
      samples,
      concurrency,
      p50Ms: round(latency[Math.ceil(samples * 0.5) - 1]),
      p95Ms: round(latency[Math.ceil(samples * 0.95) - 1]),
      requestsPerSecond: round((samples / elapsed) * 1000),
      sqlPerRequest: round(queries / samples),
      bytesPerResponse: Math.round(bytes / samples),
      processCpuMsPerRequest: round((used.user + used.system) / 1000 / samples),
      ...(profileQueries
        ? {
            queryProfile: [...queryProfile.values()]
              .map((query) => ({
                sql: query.sql,
                countPerRequest: query.count / samples,
                elapsedMsPerRequest: round(query.elapsedMs / samples),
              }))
              .sort((a, b) => b.elapsedMsPerRequest - a.elapsedMsPerRequest),
          }
        : {}),
    };
    results.push(row);
    console.info("MCP_BENCHMARK", JSON.stringify(row));
  }
  async function measureLoad(concurrency) {
    for (let i = 0; i < 5; i++)
      await call("tools/call", { name: "get_document", arguments: { file_id: "file-a" } });
    const latencies = [];
    let bytes = 0,
      sequence = 0;
    queries = 0;
    const cpu = process.cpuUsage(),
      started = performance.now(),
      deadline = started + 5000;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (performance.now() < deadline) {
          const index = sequence++,
            start = performance.now();
          const response = await call(
            "tools/call",
            index % 5 === 0
              ? { name: "rename_file", arguments: { file_id: "file-a", name: `Load ${index}` } }
              : { name: "get_document", arguments: { file_id: "file-a" } },
          );
          latencies.push(performance.now() - start);
          bytes += response.bytes;
        }
      }),
    );
    const elapsed = performance.now() - started,
      used = process.cpuUsage(cpu),
      count = latencies.length;
    latencies.sort((a, b) => a - b);
    const round = (value) => Math.round(value * 100) / 100;
    const row = {
      name: "sustained mixed 80% reads / 20% writes",
      samples: count,
      concurrency,
      durationMs: round(elapsed),
      p50Ms: round(latencies[Math.ceil(count * 0.5) - 1]),
      p95Ms: round(latencies[Math.ceil(count * 0.95) - 1]),
      p99Ms: round(latencies[Math.ceil(count * 0.99) - 1]),
      requestsPerSecond: round((count / elapsed) * 1000),
      sqlPerRequest: round(queries / count),
      bytesPerResponse: Math.round(bytes / count),
      processCpuMsPerRequest: round((used.user + used.system) / 1000 / count),
    };
    results.push(row);
    console.info("MCP_BENCHMARK", JSON.stringify(row));
  }
  try {
    if (process.env.MCP_BENCHMARK_LOAD === "1") {
      for (const concurrency of [1, 5, 20, 50]) await measureLoad(concurrency);
    } else {
      await measure("tools/list legacy", () => call("tools/list", {}));
      await measure("tools/list modern", () => call("tools/list", {}, true));
      await measure("get_document small", () =>
        call("tools/call", { name: "get_document", arguments: { file_id: "file-a" } }),
      );
      await measure(
        "get_document concurrent",
        () => call("tools/call", { name: "get_document", arguments: { file_id: "file-a" } }),
        5,
      );
      await measure("rename_file", () =>
        call("tools/call", {
          name: "rename_file",
          arguments: { file_id: "file-a", name: "Benchmark" },
        }),
      );
      await measure(
        "linear read 100ms provider concurrent",
        () => call("tools/call", linear.params),
        5,
      );
      const document = blankDesignDocument();
      document.nodes = Array.from({ length: 5000 }, (_, i) =>
        designNodeSchema.parse({
          id: `node-${i}`,
          name: `Layer ${i}`,
          type: "container",
          parentId: null,
          box: { x: (i % 100) * 10, y: Math.floor(i / 100) * 10, width: 8, height: 8 },
        }),
      );
      await admin.query(
        'update "designDocument" set "content"=$1,"revision"=1 where "fileId"=\'file-a\'',
        [document],
      );
      await measure("get_document 5000 nodes", () =>
        call("tools/call", { name: "get_document", arguments: { file_id: "file-a" } }),
      );
      await measure("get_document page 50/5000", () =>
        call("tools/call", {
          name: "get_document",
          arguments: { file_id: "file-a", offset: 2500, limit: 50 },
        }),
      );
      let revision = 1;
      await measure("patch_document 5000 nodes", async () => {
        const response = await call("tools/call", {
          name: "patch_document",
          arguments: {
            file_id: "file-a",
            expected_revision: revision,
            node_id: "node-2500",
            changes: { name: `Changed ${revision}` },
          },
        });
        revision = response.result.structuredContent.revision;
        return response;
      });
      if (process.env.MCP_BENCHMARK_COMPACT === "1") {
        await measure("patch_document compact 5000 nodes", async () => {
          const response = await call("tools/call", {
            name: "patch_document",
            arguments: {
              file_id: "file-a",
              expected_revision: revision,
              node_id: "node-2500",
              changes: { name: `Changed ${revision}` },
              include_document: false,
            },
          });
          revision = response.result.structuredContent.revision;
          return response;
        });
      }
      if (process.env.MCP_BENCHMARK_WORKFLOWS === "1") {
        await measure("import guidance", () =>
          call("tools/call", { name: "get_import_guidance", arguments: {} }),
        );
        await measure("design guidance", () =>
          call("tools/call", { name: "get_design_guidance", arguments: {} }),
        );
        // User outcome: update 20 layers and read back all resulting values. Both
        // implementations return the same final content; the batch commits once.
        const batched = process.env.MCP_BENCHMARK_BATCH === "1";
        const batchSizes = (process.env.MCP_BENCHMARK_BATCH_SIZES ?? "20").split(",").map(Number);
        if (batchSizes.some((size) => !Number.isInteger(size) || size < 1 || size > 250))
          throw new Error("Invalid benchmark batch size");
        for (const batchSize of batchSizes)
          await measure(`edit ${batchSize} layers and verify / 5000 nodes`, async () => {
            const edits = Array.from({ length: batchSize }, (_, i) => ({
              node_id: `node-${2500 + i}`,
              changes: { name: `Variation ${revision}-${i}` },
            }));
            let bytes = 0;
            if (batched) {
              const response = await call("tools/call", {
                name: "patch_document",
                arguments: {
                  file_id: "file-a",
                  expected_revision: revision,
                  ...edits[0],
                  additional_edits: edits.slice(1),
                  include_document: false,
                },
              });
              revision = response.result.structuredContent.revision;
              bytes += response.bytes;
            } else
              for (const edit of edits) {
                const response = await call("tools/call", {
                  name: "patch_document",
                  arguments: {
                    file_id: "file-a",
                    expected_revision: revision,
                    ...edit,
                    include_document: false,
                  },
                });
                revision = response.result.structuredContent.revision;
                bytes += response.bytes;
              }
            const read = await call("tools/call", {
              name: "get_document",
              arguments: { file_id: "file-a", offset: 2500, limit: batchSize },
            });
            if (
              read.result.structuredContent.revision !== revision ||
              read.result.structuredContent.nodes.some(
                (node, i) => node.name !== edits[i].changes.name,
              )
            )
              throw new Error("Workflow lost a layer edit");
            return { bytes: bytes + read.bytes };
          });
        const master = designNodeSchema.parse({
          id: "master",
          name: "Button",
          type: "container",
          parentId: null,
          isComponent: true,
          box: { x: 0, y: 0, width: 100, height: 32 },
        });
        const linked = {
          ...blankDesignDocument(),
          nodes: [
            master,
            ...Array.from({ length: 1499 }, (_, i) => ({
              ...master,
              id: `copy-${i}`,
              isComponent: undefined,
              instanceOf: "master",
              componentSourceId: "master",
              instanceOverrides: [],
            })),
          ],
        };
        await admin.query(
          'update "designDocument" set "content"=$1,"revision"=1 where "fileId"=\'file-a\'',
          [linked],
        );
        revision = 1;
        await measure("edit master / 1500 linked nodes", async () => {
          const response = await call("tools/call", {
            name: "patch_document",
            arguments: {
              file_id: "file-a",
              expected_revision: revision,
              node_id: "master",
              changes: { style: { fill: revision % 2 ? "#112233" : "#334455" } },
              include_document: false,
            },
          });
          revision = response.result.structuredContent.revision;
          return response;
        });
        const saved = (
          await admin.query('select "content" from "designDocument" where "fileId"=\'file-a\'')
        ).rows[0].content;
        if (saved.nodes.some((node) => node.style.fill !== saved.nodes[0].style.fill))
          throw new Error("Workflow lost component inheritance");
      }
    }
    const report = {
      at: new Date().toISOString(),
      runtime: `Bun ${Bun.version}`,
      platform: `${platform()} ${arch()}`,
      cpu: cpus()[0].model,
      queryDelayMs,
      results,
    };
    if (process.env.MCP_BENCHMARK_OUTPUT)
      await writeFile(process.env.MCP_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    Client.prototype.query = originalQuery;
    linear.restore();
    await server.stop(true);
  }
}
