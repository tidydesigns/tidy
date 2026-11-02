import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executablePath } from "../platform/executable-path";

const execute = promisify(execFile);

/** Preserve gh authentication/configuration while finding standard desktop CLI installs. */
export function readGitHub(args: string[]) {
  return execute("gh", args, {
    timeout: 8000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: executablePath(),
      GH_PROMPT_DISABLED: "1",
      GH_PAGER: "cat",
    },
  });
}
