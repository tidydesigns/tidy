import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sessionTokenSchema } from "../../shared/remote";

const clientIdSchema = z.string().uuid();
export class SessionStore {
  constructor(private directory: string) {}
  private path(clientId: string) {
    const directory = resolve(this.directory);
    const path = resolve(directory, clientIdSchema.parse(clientId));
    if (!path.startsWith(directory + sep)) throw new Error("Invalid session path.");
    return path;
  }
  async issue(clientId: string) {
    const path = this.path(clientId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      return sessionTokenSchema.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const token = randomBytes(32).toString("hex");
    try {
      await writeFile(path, token, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      return sessionTokenSchema.parse(await readFile(path, "utf8"));
    }
    return token;
  }
  async validate(clientId: string, token: string) {
    if (!sessionTokenSchema.safeParse(token).success) return false;
    try {
      const stored = sessionTokenSchema.parse(await readFile(this.path(clientId), "utf8"));
      return timingSafeEqual(
        createHash("sha256").update(stored).digest(),
        createHash("sha256").update(token).digest(),
      );
    } catch {
      return false;
    }
  }
  async revoke(clientId: string) {
    await rm(this.path(clientId), { force: true });
  }
}
export async function writePrivateJSON(
  path: string,
  value: unknown,
  { durable = false }: { durable?: boolean } = {},
) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: durable });
    await rename(temporary, path);
    if (durable && process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
