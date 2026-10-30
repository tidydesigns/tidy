import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { sessionTokenSchema } from "../../shared/remote";

const clientIdSchema = z.string().uuid();
export class SessionStore {
  private readonly cached = new Map<string, { digest: Buffer; expires: number }>();
  private readonly revoking = new Set<string>();
  private cacheGeneration = 0;
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
  async validate(clientId: string, token: string, { cached = false } = {}): Promise<boolean> {
    if (!sessionTokenSchema.safeParse(token).success || this.revoking.has(clientId)) return false;
    try {
      const path = this.path(clientId);
      const digest = createHash("sha256").update(token).digest();
      const entry = cached ? this.cached.get(clientId) : undefined;
      if (entry && entry.expires > performance.now()) return timingSafeEqual(entry.digest, digest);
      this.cached.delete(clientId);
      const generation = this.cacheGeneration;
      const stored = sessionTokenSchema.parse(await readFile(path, "utf8"));
      if (this.revoking.has(clientId)) return false;
      if (generation !== this.cacheGeneration) return this.validate(clientId, token, { cached });
      const storedDigest = createHash("sha256").update(stored).digest();
      const valid = timingSafeEqual(storedDigest, digest);
      if (valid && cached) {
        if (this.cached.size >= 256) {
          const oldest = this.cached.keys().next().value;
          if (oldest) this.cached.delete(oldest);
        }
        this.cached.set(clientId, { digest: storedDigest, expires: performance.now() + 1000 });
      }
      return valid;
    } catch {
      return false;
    }
  }
  async revoke(clientId: string) {
    const path = this.path(clientId);
    this.revoking.add(clientId);
    this.cacheGeneration++;
    this.cached.delete(clientId);
    try {
      await rm(path, { force: true });
    } finally {
      this.cacheGeneration++;
      this.cached.delete(clientId);
      this.revoking.delete(clientId);
    }
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
