import { createHash } from "node:crypto";
import { ptyPackages } from "../terminal/pty-packages";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { preparedHostSchema } from "../../shared/remote";
import { installedHostScript } from "./installed-host";
import { installHostScript } from "./install-host";
import { shouldUpdateHost } from "./host-service";
import { RemoteFailure } from "./errors";
import { shellQuote, type SshSession } from "./ssh";

type HostDirectories = { runtime: string; state: string };
const hashBundle = (bundle: Buffer) => createHash("sha256").update(bundle).digest("hex");

function hostEnvironment(directories?: HostDirectories) {
  return `root=${directories ? shellQuote(directories.runtime) : '"$HOME/.local/share/tidy/runtime"'}
export TIDY_HOST_STATE=${directories ? shellQuote(directories.state) : '"$HOME/.local/state/tidy-host"'}
export TIDY_HOST_SERVICE=${directories ? "off" : "auto"}
PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/opt/homebrew/bin:$PATH"
for nodebin in "$HOME"/.nvm/versions/node/*/bin; do [ ! -d "$nodebin" ] || PATH="$PATH:$nodebin"; done
export PATH`;
}

export function reconnectScript({
  buildId,
  clientId,
  expectedHostId,
  update = false,
  directories,
}: {
  buildId: string;
  clientId: string;
  expectedHostId?: string;
  update?: boolean;
  directories?: HostDirectories;
}) {
  z.string().uuid().parse(clientId);
  if (expectedHostId) z.string().uuid().parse(expectedHostId);
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(buildId);
  return `set -eu
umask 077
${hostEnvironment(directories)}
printf 'TIDY_PHASE:checking\\n' >&2
selected=""
for node in "$root"/node-*/bin/node "$root"/*/bin/node; do
  if [ -x "$node" ] && "$node" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' >/dev/null 2>&1; then
    selected="$node"
    break
  fi
done
if [ -z "$selected" ] && command -v node >/dev/null 2>&1 && node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' >/dev/null 2>&1; then
  selected="$(command -v node)"
fi
if [ -n "$selected" ]; then
  exec "$selected" -e ${shellQuote(installedHostScript)} "$root" "$TIDY_HOST_STATE" '${buildId}' '${clientId}' '${expectedHostId ?? ""}' '${update ? "yes" : "no"}'
fi
printf 'TIDY_INSTALL_REQUIRED\\n'
`;
}

export function bootstrapScript({
  bundle,
  clientId,
  directories,
  expectedHostId,
  update = false,
}: {
  bundle: Buffer;
  clientId: string;
  directories?: HostDirectories;
  expectedHostId?: string;
  update?: boolean;
}) {
  z.string().uuid().parse(clientId);
  if (expectedHostId) z.string().uuid().parse(expectedHostId);
  const hash = hashBundle(bundle);
  const ptyCases = Object.entries(ptyPackages)
    .filter(([name]) => name !== "node-pty")
    .map(
      ([name, value]) =>
        `  ${name.replace("node-pty-", "")}) pty_url=${shellQuote(value.url)}; pty_checksum=${shellQuote(value.sha256)};;`,
    )
    .join("\n");
  return `set -eu
umask 077
printf 'TIDY_PHASE:checking\\n' >&2
case "$(uname -s)" in
  Linux) platform=linux; hash_file() { sha256sum "$1" | cut -d' ' -f1; };;
  Darwin) platform=darwin; hash_file() { shasum -a 256 "$1" | cut -d' ' -f1; };;
  *) echo 'Automatic setup supports macOS and Linux remote machines. This operating system needs a separate installer.' >&2; exit 1;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64;;
  aarch64|arm64) arch=arm64;;
  *) echo 'Unsupported remote architecture. Use an Intel/AMD 64-bit or ARM64 machine.' >&2; exit 1;;
esac
case "$platform-$arch" in
  linux-x64) checksum=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c;;
  linux-arm64) checksum=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3;;
  darwin-x64) checksum=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035;;
  darwin-arm64) checksum=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7;;
esac
${hostEnvironment(directories)}
mkdir -p "$root"
[ ! -L "$root" ] || { echo 'Backend runtime directory must not be a symlink.' >&2; exit 1; }
chmod 700 "$root"
runtime="$root/${hash}"
node_runtime="$root/node-v24.22.1-$platform-$arch"
stage="$(mktemp -d "$root/.stage-XXXXXX")"
node_stage=""
trap 'rm -rf "$stage"; if [ -n "$node_stage" ]; then rm -rf "$node_stage"; fi' EXIT
trap 'exit 1' HUP INT TERM
printf 'TIDY_PHASE:installing\\n' >&2
cat > "$stage/tidy-host.mjs"
actual="$(hash_file "$stage/tidy-host.mjs")"
[ "$actual" = '${hash}' ] || { echo 'Backend checksum mismatch. Retry to transfer the backend again.' >&2; exit 1; }
node="$node_runtime/bin/node"
if [ ! -f "$node_runtime/complete" ] || [ "$(cat "$node_runtime/complete")" != "$checksum" ] || ! "$node" -e 'require("node:sqlite")' >/dev/null 2>&1; then
  node_stage="$(mktemp -d "$root/.node-stage-XXXXXX")"
  url="https://nodejs.org/dist/v24.22.1/node-v24.22.1-$platform-$arch.tar.gz"
  if command -v curl >/dev/null 2>&1; then curl -fLsS --connect-timeout 30 --max-time 300 "$url" -o "$node_stage/node.tar.gz"
  elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$url" -O "$node_stage/node.tar.gz"
  else echo 'Install curl or wget to download the backend runtime.' >&2; exit 1; fi
  actual="$(hash_file "$node_stage/node.tar.gz")"
  [ "$actual" = "$checksum" ] || { echo 'Node runtime checksum mismatch.' >&2; exit 1; }
  tar -xzf "$node_stage/node.tar.gz" -C "$node_stage" --strip-components=1 "node-v24.22.1-$platform-$arch/bin/node" "node-v24.22.1-$platform-$arch/LICENSE"
  rm "$node_stage/node.tar.gz"
  [ "$("$node_stage/bin/node" --version)" = 'v24.22.1' ] || { echo 'Node runtime version mismatch.' >&2; exit 1; }
  printf '%s\\n' "$checksum" > "$node_stage/complete"
  node="$node_stage/bin/node"
fi
download() {
  if command -v curl >/dev/null 2>&1; then curl -fLsS --connect-timeout 30 --max-time 120 "$1" -o "$2"
  else wget -q --timeout=30 --tries=1 "$1" -O "$2"; fi
}
case "$platform-$arch" in
${ptyCases}
esac
download '${ptyPackages["node-pty"].url}' "$stage/pty.tgz"
[ "$(hash_file "$stage/pty.tgz")" = '${ptyPackages["node-pty"].sha256}' ] || { echo 'PTY package checksum mismatch.' >&2; exit 1; }
mkdir -p "$stage/node_modules/@lydell/node-pty"
tar -xzf "$stage/pty.tgz" -C "$stage/node_modules/@lydell/node-pty" --strip-components=1
download "$pty_url" "$stage/pty-platform.tgz"
[ "$(hash_file "$stage/pty-platform.tgz")" = "$pty_checksum" ] || { echo 'PTY binary checksum mismatch.' >&2; exit 1; }
mkdir -p "$stage/node_modules/@lydell/node-pty-$platform-$arch"
tar -xzf "$stage/pty-platform.tgz" -C "$stage/node_modules/@lydell/node-pty-$platform-$arch" --strip-components=1
rm "$stage/pty.tgz" "$stage/pty-platform.tgz"
"$node" -e 'require(process.argv[1])' "$stage/node_modules/@lydell/node-pty"
"$node" -e ${shellQuote(installHostScript)} "$root" "$stage" "$node_stage" "$node_runtime" "$checksum" '${hash}' "$TIDY_HOST_STATE"
trap - EXIT HUP INT TERM
printf 'TIDY_PHASE:starting\\n' >&2
exec "$runtime/bin/node" -e ${shellQuote(installedHostScript)} "$root" "$TIDY_HOST_STATE" '${hash}' '${clientId}' '${expectedHostId ?? ""}' '${update ? "apply" : "installed"}'
`;
}

export async function prepareHost({
  ssh,
  bundlePath,
  clientId,
  signal,
  progress,
  expectedHostId,
  update = false,
}: {
  ssh: Pick<SshSession, "execute">;
  bundlePath: string;
  clientId: string;
  signal: AbortSignal;
  progress(phase: string): void;
  expectedHostId?: string;
  update?: boolean;
}) {
  const bundle = await readFile(bundlePath);
  const buildId = hashBundle(bundle);
  let sourceTimestamp: number | undefined;
  try {
    const metadata = z
      .object({ buildId: z.literal(buildId), sourceTimestamp: z.number().int().nonnegative() })
      .parse(JSON.parse(await readFile(bundlePath + ".json", "utf8")));
    sourceTimestamp = metadata.sourceTimestamp;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new RemoteFailure(
        "setup",
        "The desktop backend metadata is invalid. Rebuild or reinstall the desktop app, then retry.",
      );
  }
  let output = await ssh.execute({
    script: reconnectScript({ buildId, clientId, expectedHostId, update }),
    signal,
    progress,
    timeout: 120_000,
  });
  if (output.trim() === "TIDY_INSTALL_REQUIRED") {
    signal.throwIfAborted();
    output = await ssh.execute({
      script: bootstrapScript({ bundle, clientId, expectedHostId, update }),
      input: bundle,
      timeout: 900_000,
      signal,
      progress,
    });
  }
  const line = output.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("The remote machine did not return a backend address.");
  const host = preparedHostSchema.parse(JSON.parse(line));
  return {
    ...host,
    updatePending:
      host.managed &&
      (sourceTimestamp === undefined
        ? host.buildId !== buildId || host.updatePending === true
        : shouldUpdateHost({ current: host, candidate: { buildId, sourceTimestamp } })),
  };
}
