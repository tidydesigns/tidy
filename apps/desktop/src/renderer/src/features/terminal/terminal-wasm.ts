// Compile once, instantiate separately. A closed terminal can release its heap,
// and a replacement never shares mutable native state with the current renderer.
export function terminalWasm(load: () => Promise<ArrayBuffer>) {
  let compiled: Promise<WebAssembly.Module> | undefined;
  return async () => {
    compiled ??= load()
      .then((bytes) => WebAssembly.compile(bytes))
      .catch((error: unknown) => {
        compiled = undefined;
        throw error;
      });
    return WebAssembly.instantiate(await compiled, { env: { log() {} } });
  };
}
