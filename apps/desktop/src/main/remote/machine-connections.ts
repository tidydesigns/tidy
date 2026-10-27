import { remoteTargetSchema } from "../../shared/remote";

export function machineConnections(connect: (target: string) => Promise<void>) {
  const pending = new Map<string, Promise<void>>();
  return (input: string) => {
    const target = remoteTargetSchema.parse(input);
    const existing = pending.get(target);
    if (existing) return existing;
    const operation = connect(target).finally(() => pending.delete(target));
    pending.set(target, operation);
    return operation;
  };
}
