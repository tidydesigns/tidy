import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sessionTokenSchema } from "../../shared/remote";

const clientIdSchema = z.string().uuid();
export class SessionStore {
  constructor(private directory: string) {}
  async issue(clientId: string) {
    clientIdSchema.parse(clientId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, clientId);
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
    if (!clientIdSchema.safeParse(clientId).success || !sessionTokenSchema.safeParse(token).success)
      return false;
    try {
      const stored = sessionTokenSchema.parse(
        await readFile(join(this.directory, clientId), "utf8"),
      );
      return timingSafeEqual(
        createHash("sha256").update(stored).digest(),
        createHash("sha256").update(token).digest(),
      );
    } catch {
      return false;
    }
  }
  async revoke(clientId: string) {
    await rm(join(this.directory, clientIdSchema.parse(clientId)), { force: true });
  }
}
export async function writePrivateJSON(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
