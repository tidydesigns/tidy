let pending: Promise<typeof import("./conversation")> | undefined;

export function loadConversation() {
  return (pending ??= import("./conversation").catch((error: unknown) => {
    pending = undefined;
    throw error;
  }));
}
