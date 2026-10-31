import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { additionalProviderEnvironmentKeys, harnessEnvironmentKeys } from "../harnesses/harnesses";
import { readLocalFile } from "../platform/local-files";
import { writePrivateJSON } from "./session-store";

const temporaryKeys = new Set(["TMPDIR", "TMP", "TEMP"]);
const supportedKeys = new Set<string>([
  ...harnessEnvironmentKeys.filter((key) => !temporaryKeys.has(key)),
  ...additionalProviderEnvironmentKeys,
  "PATH",
  "TIDY_BROWSER_EXECUTABLE",
  "TIDY_BROWSER_SANDBOX",
]);
const environmentSchema = z.record(z.string(), z.string().max(64 * 1024));
const environmentPath = (directory: string) => join(directory, "service-environment.json");

export function hostEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    [...supportedKeys].flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export async function persistHostEnvironment(directory: string, environment: NodeJS.ProcessEnv) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && info.uid !== process.getuid?.())
  )
    throw new Error("Backend environment storage must be a private directory owned by this user.");
  await chmod(directory, 0o700);
  const selected = hostEnvironment(environment);
  if (
    !environmentSchema.safeParse(selected).success ||
    Buffer.byteLength(JSON.stringify(selected)) > 1024 * 1024
  )
    throw new Error("The backend environment exceeds its storage limit.");
  await writePrivateJSON(environmentPath(directory), selected, { durable: true });
}

export async function loadHostEnvironment(
  directory: string,
  target: NodeJS.ProcessEnv = process.env,
) {
  const path = environmentPath(directory);
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
    )
      throw new Error("Backend environment storage must be a private file owned by this user.");
    const contents = await readLocalFile(path, 1024 * 1024);
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new Error("The saved backend environment is invalid. Reconnect to recreate it.");
    }
    const environment = environmentSchema.safeParse(parsed);
    if (!environment.success)
      throw new Error("The saved backend environment is invalid. Reconnect to recreate it.");
    for (const key of supportedKeys) delete target[key];
    Object.assign(target, hostEnvironment(environment.data));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
