import { useEffect, useRef } from "react";
import { z } from "zod";
import { useSessionState } from "../../app/session-state";

const scrollSchema = z.array(z.tuple([z.string(), z.number().nonnegative()])).max(32);

export function useRepositoryScroll(projectId: string) {
  const [saved, save] = useSessionState(`repository-scroll:${projectId}`, scrollSchema, []);
  const positions = useRef(new Map(saved));
  useEffect(() => () => save([...positions.current]), [save]);
  return positions.current;
}

export function rememberScroll(positions: Map<string, number>, key: string, top: number) {
  positions.delete(key);
  positions.set(key, top);
  if (positions.size > 32) {
    const first = positions.keys().next().value;
    if (first !== undefined) positions.delete(first);
  }
}
