import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

export async function browserStreamingUnavailable() {
  if (process.platform !== "linux") return "Video streaming requires a Linux browser host.";
  const tools = [
    ["Voxl", process.env.TIDY_VOXL_EXECUTABLE ?? "voxl"],
    ["Xvfb", process.env.TIDY_XVFB_EXECUTABLE ?? "Xvfb"],
    ["xrandr", process.env.TIDY_XRANDR_EXECUTABLE ?? "xrandr"],
    ["Openbox", process.env.TIDY_BROWSER_WINDOW_MANAGER_EXECUTABLE ?? "openbox"],
    ...(process.env.TIDY_BROWSER_EXECUTABLE
      ? [["Chrome", process.env.TIDY_BROWSER_EXECUTABLE]]
      : []),
  ];
  const missing = await Promise.all(
    tools.map(async ([name, executable]) => {
      const candidates = executable.includes("/")
        ? [executable]
        : (process.env.PATH ?? "")
            .split(delimiter)
            .map((directory) => join(directory || ".", executable));
      for (const candidate of candidates) {
        try {
          await access(candidate, constants.X_OK);
          if ((await stat(candidate)).isFile()) return undefined;
        } catch {}
      }
      return name;
    }),
  );
  const names = missing.filter((name) => name !== undefined);
  return names.length
    ? `Install or configure ${names.join(", ")} on this host before enabling video streaming.`
    : undefined;
}
