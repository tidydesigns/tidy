import { constants } from "node:fs";
import { open } from "node:fs/promises";

const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

export async function openProjectVideo(path: string) {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK;
  if (process.platform === "darwin") return open(path, flags | DARWIN_O_NOFOLLOW_ANY);
  if (process.platform !== "linux")
    throw new Error("Secure video previews require a macOS or Linux host.");
  const components = path.split("/").filter(Boolean);
  const name = components.pop();
  if (!name) throw new Error("Choose a video file.");
  let directory = await open(
    "/",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const component of components) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return await open(`/proc/self/fd/${directory.fd}/${name}`, flags | constants.O_NOFOLLOW);
  } finally {
    await directory.close();
  }
}
