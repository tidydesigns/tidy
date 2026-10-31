import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, mkdtemp, mkdir, opendir, writeFile, utimes, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isUtf8 } from "node:buffer";
import { openRepositoryPath } from "./repository-path";

export type GitView = {
  directory: string;
  index: string;
  objects: string;
  workTree: string;
  head: string | null;
  prefix: string;
};
export class OutputLimitError extends Error {
  constructor() {
    super("Git output exceeds the repository preview limit. Open this repository in your editor.");
  }
}

export async function git(
  cwd: string,
  args: string[],
  input?: string,
  limit = 2 * 1024 * 1024,
  view?: GitView,
  pathspecs: "literal" | "attributes" = "literal",
) {
  const directory = await openRepositoryPath(cwd, "", true);
  try {
    return await new Promise<{ code: number; text: string; utf8: boolean }>((resolve, reject) => {
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      );
      const child = spawn(
        "git",
        [
          "--no-pager",
          "--no-lazy-fetch",
          ...(view ? [`--git-dir=${view.directory}`, `--work-tree=${view.workTree}`] : []),
          ...(args[0] === "check-ignore" || pathspecs === "attributes"
            ? []
            : ["--literal-pathspecs"]),
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
          ...args,
        ],
        {
          cwd:
            process.platform === "linux"
              ? `/proc/${process.pid}/fd/${directory.file.fd}`
              : directory.descriptor,
          env: {
            ...environment,
            LC_ALL: "C",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_NO_LAZY_FETCH: "1",
            ...(view
              ? {
                  GIT_INDEX_FILE: view.index,
                  GIT_OBJECT_DIRECTORY: view.objects,
                  GIT_CONFIG_NOSYSTEM: "1",
                  GIT_CONFIG_GLOBAL: "/dev/null",
                }
              : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error("Git took too long. Try refreshing this repository.");
        child.kill("SIGKILL");
      }, 10000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          failure = new OutputLimitError();
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code === 129)
          reject(new Error("Could not run safe Git inspection. Update Git and retry."));
        else {
          const output = Buffer.concat(chunks);
          resolve({ code: code ?? -1, text: output.toString("utf8"), utf8: isUtf8(output) });
        }
      });
      child.stdin.end(input);
    });
  } finally {
    await directory.file.close();
  }
}

const configurationKeys = [
  "core.autocrlf",
  "core.eol",
  "core.filemode",
  "core.ignorecase",
  "core.symlinks",
  "core.precomposeunicode",
  "core.attributesfile",
  "core.excludesfile",
  "core.sparsecheckout",
  "core.sparsecheckoutcone",
  "index.sparse",
];
const metadataLimit = 1024 * 1024;
async function copyMetadata(source: string, destination: string, limit = metadataLimit) {
  const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!file) return 0;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Git metadata cannot be previewed safely.");
    if (info.size > limit) throw new OutputLimitError();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ end: limit, autoClose: false })) {
      size += chunk.length;
      if (size > limit) throw new OutputLimitError();
      chunks.push(chunk);
    }
    await writeFile(destination, Buffer.concat(chunks, size), { mode: 0o600 });
    // Git's racy-index checks require the snapshot timestamp to be no newer than the original.
    await utimes(destination, info.atime, Math.floor(info.mtimeMs / 1000));
    return size;
  } finally {
    await file.close();
  }
}
async function copyIndex(source: string, directory: string, format: string) {
  const index = join(directory, "index");
  let remaining = 64 * 1024 * 1024;
  const size = await copyMetadata(source, index, remaining);
  if (!size) return index;
  remaining -= size;
  const sharedName = new RegExp(`^sharedindex\\.[a-f0-9]{${format === "sha256" ? 64 : 40}}$`);
  const entries = await opendir(dirname(source));
  let count = 0;
  for await (const entry of entries) {
    if (++count > 4096) throw new OutputLimitError();
    if (sharedName.test(entry.name)) {
      if (!entry.isFile()) throw new Error("Git metadata cannot be previewed safely.");
      remaining -= await copyMetadata(
        join(dirname(source), entry.name),
        join(directory, entry.name),
        remaining,
      );
    }
  }
  return index;
}
export async function createGitView(root: string): Promise<GitView> {
  const [metadata, settings] = await Promise.all([
    git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
      "--git-path",
      "objects",
      "--git-path",
      "info/attributes",
      "--git-path",
      "info/exclude",
      "--git-path",
      "info/sparse-checkout",
      "--show-object-format",
      "--show-toplevel",
      "--verify",
      "HEAD",
    ]),
    git(
      root,
      [
        "config",
        "--null",
        "--path",
        "--get-regexp",
        "^(core\\.(autocrlf|eol|filemode|ignorecase|symlinks|precomposeunicode|attributesfile|excludesfile|sparsecheckout|sparsecheckoutcone)|index\\.sparse)$",
      ],
      undefined,
      metadataLimit,
    ),
  ]);
  const fields = metadata.text.replace(/\r?\n$/, "").split("\n");
  const [index, objects, attributes, exclude, sparse, format, workTree, head] = fields;
  if (
    ![0, 128].includes(metadata.code) ||
    !metadata.utf8 ||
    !settings.utf8 ||
    ![0, 1].includes(settings.code) ||
    ![7, 8].includes(fields.length) ||
    ![index, objects, attributes, exclude, sparse, workTree].every(
      (path) => path && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path),
    ) ||
    !["sha1", "sha256"].includes(format) ||
    (head !== undefined && !new RegExp(`^[a-f0-9]{${format === "sha256" ? 64 : 40}}$`).test(head))
  )
    throw new Error("Could not create a safe Git preview.");
  const values = new Map<string, string>();
  for (const entry of settings.text.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const key = entry.slice(0, separator),
      value = entry.slice(separator + 1);
    if (separator < 0 || !configurationKeys.includes(key) || /[\x00-\x1f\x7f]/.test(value))
      throw new Error("Git settings cannot be previewed safely.");
    values.set(key, value);
  }
  let config = `[core]\nrepositoryformatversion=${format === "sha256" ? 1 : 0}\nbare=false\n`;
  if (format === "sha256") config += "[extensions]\nobjectformat=sha256\n";
  for (const [key, value] of values) {
    const [section, name] = key.split(".");
    config += `[${section}]\n${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`;
  }
  const directory = await mkdtemp(join(tmpdir(), "tidy-git-preview-"));
  try {
    await mkdir(join(directory, "objects"));
    await mkdir(join(directory, "refs"));
    await mkdir(join(directory, "info"));
    const writes = await Promise.allSettled([
      writeFile(join(directory, "HEAD"), head ? `${head}\n` : "ref: refs/heads/preview\n", {
        mode: 0o600,
      }),
      writeFile(join(directory, "config"), config, { mode: 0o600 }),
      copyMetadata(attributes, join(directory, "info/attributes")),
      copyMetadata(exclude, join(directory, "info/exclude")),
      copyMetadata(sparse, join(directory, "info/sparse-checkout")),
    ]);
    for (const result of writes) {
      if (result.status === "rejected") throw result.reason;
    }
    const path = relative(workTree, await realpath(root))
      .split(sep)
      .join("/");
    if (path === ".." || path.startsWith("../") || isAbsolute(path))
      throw new Error("Git's working tree is outside the selected project.");
    return {
      directory,
      index: await copyIndex(index, directory, format),
      objects,
      workTree,
      head: head ?? null,
      prefix: path ? `${path}/` : "",
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export function closeGitView(view: GitView) {
  return rm(view.directory, { recursive: true, force: true });
}
