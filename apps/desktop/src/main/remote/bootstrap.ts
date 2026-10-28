import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { preparedHostSchema } from "../../shared/remote";
import type { SshSession } from "./ssh";

export function bootstrapScript({
  bundle,
  clientId,
  directories,
}: {
  bundle: Buffer;
  clientId: string;
  directories?: { runtime: string; state: string };
}) {
  z.string().uuid().parse(clientId);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const hash = createHash("sha256").update(bundle).digest("hex");
  const payload =
    bundle
      .toString("base64")
      .match(/.{1,120}/g)
      ?.join("\n") ?? "";
  return `set -eu
umask 077
printf 'TIDY_PHASE:checking\\n' >&2
case "$(uname -s)" in
  Linux) platform=linux; hash_file() { sha256sum "$1" | cut -d' ' -f1; }; decode_file() { base64 -d "$1"; };;
  Darwin) platform=darwin; hash_file() { shasum -a 256 "$1" | cut -d' ' -f1; }; decode_file() { base64 -D "$1"; };;
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
root=${directories ? quote(directories.runtime) : '"$HOME/.local/share/tidy/runtime"'}
${directories ? `export TIDY_HOST_STATE=${quote(directories.state)}` : ""}
mkdir -p "$root"
runtime="$root/${hash}"
lock="$root/install.lock"
waited=0
until (set -C; printf '%s\\n' "$$" > "$lock") 2>/dev/null; do
  owner="$(cat "$lock" 2>/dev/null || true)"
  case "$owner" in ''|*[!0-9]*) ;; *) if ! kill -0 "$owner" 2>/dev/null; then rm -f "$lock"; continue; fi;; esac
  waited=$((waited + 1))
  if [ "$waited" -gt 480 ]; then echo 'Another installation is still running. Retry shortly.' >&2; exit 1; fi
  sleep 1
done
stage=""
trap 'if [ -n "$stage" ]; then rm -rf "$stage"; fi; rm -f "$lock"' EXIT
if [ ! -f "$runtime/complete" ]; then
  printf 'TIDY_PHASE:installing\\n' >&2
  stage="$(mktemp -d "$root/.stage-XXXXXX")"
  cat > "$stage/bundle.b64" <<'TIDY_BUNDLE'
${payload}
TIDY_BUNDLE
  decode_file "$stage/bundle.b64" > "$stage/tidy-host.mjs"
  rm "$stage/bundle.b64"
  actual="$(hash_file "$stage/tidy-host.mjs")"
  [ "$actual" = '${hash}' ] || { echo 'Backend checksum mismatch.' >&2; exit 1; }
  url="https://nodejs.org/dist/v24.22.1/node-v24.22.1-$platform-$arch.tar.gz"
  if command -v curl >/dev/null 2>&1; then curl -fLsS --connect-timeout 30 --max-time 300 "$url" -o "$stage/node.tar.gz"
  elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$url" -O "$stage/node.tar.gz"
  else echo 'Install curl or wget to download the backend runtime.' >&2; exit 1; fi
  actual="$(hash_file "$stage/node.tar.gz")"
  [ "$actual" = "$checksum" ] || { echo 'Node runtime checksum mismatch.' >&2; exit 1; }
  tar -xzf "$stage/node.tar.gz" -C "$stage" --strip-components=1
  rm "$stage/node.tar.gz"
  "$stage/bin/node" "$stage/tidy-host.mjs" version >/dev/null
  printf '${hash}\\n' > "$stage/complete"
  mv "$stage" "$runtime"
  stage=""
fi
rm -f "$lock"
trap - EXIT
printf 'TIDY_PHASE:starting\\n' >&2
PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.volta/bin:$HOME/.local/share/mise/shims:/usr/local/bin:/opt/homebrew/bin:$PATH"
for nodebin in "$HOME"/.nvm/versions/node/*/bin; do [ ! -d "$nodebin" ] || PATH="$PATH:$nodebin"; done
export PATH
exec "$runtime/bin/node" "$runtime/tidy-host.mjs" ensure '${clientId}'
`;
}
export async function prepareHost({
  ssh,
  bundlePath,
  clientId,
  signal,
  progress,
}: {
  ssh: SshSession;
  bundlePath: string;
  clientId: string;
  signal: AbortSignal;
  progress(phase: string): void;
}) {
  const bundle = await readFile(bundlePath);
  const output = await ssh.execute({
    script: bootstrapScript({ bundle, clientId }),
    signal,
    progress,
  });
  const line = output.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("The remote machine did not return a backend address.");
  const host = preparedHostSchema.parse(JSON.parse(line));
  return {
    ...host,
    updatePending: host.buildId !== createHash("sha256").update(bundle).digest("hex"),
  };
}
