import { access, cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const source = new URL("../../desktop/demo-dist/", import.meta.url);
const destination = new URL("../public/desktop-demo/", import.meta.url);

// Fail before touching the staged demo if the prerequisite build is unavailable.
await access(new URL("index.html", source), constants.R_OK).catch(() => {
  throw new Error(
    "Desktop demo output is missing or unreadable. Run the desktop build:demo first.",
  );
});
const parent = fileURLToPath(new URL("../", destination));
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(path.join(parent, ".desktop-demo-stage-"));
const staged = path.join(temporary, "next");
const backup = path.join(temporary, "previous");
let cleanup = true;
try {
  // Finish every source read before replacing the currently usable output.
  await cp(source, staged, { recursive: true });
  let previous = false;
  try {
    await rename(destination, backup);
    previous = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staged, destination);
  } catch (error) {
    if (previous) {
      try {
        await rename(backup, destination);
      } catch (restoreError) {
        cleanup = false; // Retain the previous build for recovery if restoration itself fails.
        throw new AggregateError(
          [error, restoreError],
          `Could not restore desktop demo; retained at ${backup}`,
        );
      }
    }
    throw error;
  }
} finally {
  if (cleanup) await rm(temporary, { recursive: true, force: true });
}
