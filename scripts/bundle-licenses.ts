import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import reviewed from "../licenses/bundled/manifest.json";

/** Notices travel with the code, including standalone HTML and code handoffs. */
export async function bundleLicenseBanner(build: Pick<Bun.BuildOutput, "metafile">) {
  if (!build.metafile) throw new Error("Bundle licence generation requires build metadata.");
  const packages = new Map<string, string>();
  for (const output of Object.values(build.metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput === 0) continue;
      const root = resolve(input)
        .replaceAll("\\", "/")
        .match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/|$)/)?.[1];
      if (!root) continue;
      const { name, version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
      const id = `${name}@${version}`;
      if (packages.has(id)) continue;
      if (!Object.hasOwn(reviewed, name))
        throw new Error(`Add reviewed licence notices for bundled dependency ${id}.`);
      const entry = reviewed[name as keyof typeof reviewed];
      const upstream = (await readFile(resolve(root, entry.source), "utf8")).trim();
      const notice = (
        await readFile(new URL(`../licenses/bundled/${entry.notice}`, import.meta.url), "utf8")
      ).trim();
      if (upstream !== notice)
        throw new Error(`Bundled licence for ${id} changed; review and update ${entry.notice}.`);
      packages.set(id, notice);
    }
  }
  if (!packages.size) return "";
  const groups = new Map<string, string[]>();
  for (const id of [...packages.keys()].sort()) {
    const notice = packages.get(id)!;
    groups.set(notice, [...(groups.get(notice) ?? []), id]);
  }
  const projectLicense = (await readFile(new URL("../LICENSE", import.meta.url), "utf8")).trim();
  const notices = [
    `Tidy runtime code — Apache-2.0\n${projectLicense}`,
    ...[...groups].map(([notice, ids]) => `${ids.join(", ")}\n\n${notice}`),
  ].join("\n\n---\n\n");
  if (notices.includes("*/")) throw new Error("Bundle licence text cannot close a JS comment.");
  return `/*!\n${notices}\n*/\n`;
}
