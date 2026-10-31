import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readLocalFile } from "../platform/local-files";

const projectIdSchema = z.uuid();
const bindingSchema = z
  .object({
    path: z.string().min(1).max(4096),
    directory: z
      .object({ device: z.string(), inode: z.string(), createdAt: z.string() })
      .strict()
      .optional(),
  })
  .strict();
type Binding = z.infer<typeof bindingSchema>;

export class ProjectIdentity {
  constructor(private directory: string) {}

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Private project identities must use a real directory.");
  }

  async claim(projectId: string, projectPath: string) {
    const path = join(this.directory, `${projectIdSchema.parse(projectId)}.json`);
    const binding = await this.binding(projectPath);
    try {
      const previous = await this.read(path);
      return this.accept(path, previous, binding);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (await this.write(path, binding, false)) return true;
    return this.accept(path, await this.read(path), binding);
  }

  private async binding(path: string): Promise<Binding> {
    try {
      if ((await realpath(path)) !== path)
        throw new Error("The project directory changed. Open its canonical directory again.");
      const info = await stat(path, { bigint: true });
      if (!info.isDirectory()) throw new Error("Select a project directory.");
      return bindingSchema.parse({
        path,
        ...(info.ino > 0n && info.birthtimeNs > 0n
          ? {
              directory: {
                device: info.dev.toString(),
                inode: info.ino.toString(),
                createdAt: info.birthtimeNs.toString(),
              },
            }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      return bindingSchema.parse({ path });
    }
  }

  private async accept(path: string, previous: Binding, binding: Binding) {
    if (previous.directory && binding.directory) {
      if (
        previous.directory.device !== binding.directory.device ||
        previous.directory.inode !== binding.directory.inode ||
        previous.directory.createdAt !== binding.directory.createdAt
      )
        return false;
    } else if (previous.path !== binding.path) return false;
    if (binding.directory && JSON.stringify(previous) !== JSON.stringify(binding))
      await this.write(path, binding, true);
    return true;
  }

  private async write(path: string, binding: Binding, replace: boolean) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(binding));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        if (replace) await rename(temporary, path);
        else await link(temporary, path);
        return true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return false;
  }

  private async read(path: string) {
    return bindingSchema.parse(JSON.parse((await readLocalFile(path, 16 * 1024)).toString("utf8")));
  }
}
