import { z } from "zod";
import type { DesignDocument, DesignNode } from "./document";
import { componentFamily } from "./component-variants";

const target = z.string().min(1).max(120);
export const prototypeStateSchema = z.enum(["default", "hover", "pressed", "focus", "disabled"]);
export type PrototypeState = z.infer<typeof prototypeStateSchema>;
export const prototypeTransitionSchema = z
  .object({
    type: z.enum(["instant", "fade", "slide"]),
    duration: z.number().int().min(0).max(2000),
  })
  .strict();
export const prototypeInteractionSchema = z
  .object({
    id: z.string().uuid(),
    trigger: z.discriminatedUnion("type", [
      z.object({ type: z.literal("click") }).strict(),
      z.object({ type: z.literal("hover") }).strict(),
      z.object({ type: z.literal("key"), key: z.string().min(1).max(30) }).strict(),
      z
        .object({ type: z.literal("afterDelay"), delay: z.number().int().min(100).max(60000) })
        .strict(),
    ]),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("navigate"), target }).strict(),
      z
        .object({
          type: z.literal("openOverlay"),
          target,
          position: z.enum(["center", "top", "bottom"]),
          dismissOutside: z.boolean(),
        })
        .strict(),
      z.object({ type: z.literal("closeOverlay") }).strict(),
      z.object({ type: z.literal("back") }).strict(),
      z.object({ type: z.literal("setState"), target, state: prototypeStateSchema }).strict(),
      z
        .object({ type: z.literal("setVariant"), target, variant: z.string().min(1).max(40) })
        .strict(),
    ]),
    transition: prototypeTransitionSchema,
  })
  .strict();
export type PrototypeInteraction = z.infer<typeof prototypeInteractionSchema>;
export type PrototypeTransition = z.infer<typeof prototypeTransitionSchema>;

export function validatePrototype(nodes: DesignNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes)
    for (const { action } of node.interactions ?? []) {
      if (!("target" in action)) continue;
      const destination = byId.get(action.target);
      if (!destination) throw new Error(`Interaction on ${node.id} targets a missing layer.`);
      if (["navigate", "openOverlay"].includes(action.type) && destination.type !== "artboard")
        throw new Error(`Interaction on ${node.id} needs a frame destination.`);
      if (action.type === "setVariant") {
        if (!componentFamily(nodes, destination)?.variants.options[action.variant])
          throw new Error(`Interaction on ${node.id} targets an unavailable variant.`);
      }
    }
}

/** References stay local when copied; references outside the copied set need an explicit resolver. */
export function remapInteractions(
  interactions: DesignNode["interactions"],
  resolve: (id: string) => string | undefined,
): DesignNode["interactions"] {
  return interactions?.flatMap((interaction) => {
    const action = interaction.action;
    if (!("target" in action)) return [interaction];
    const target = resolve(action.target);
    return target ? [{ ...interaction, action: { ...action, target } }] : [];
  });
}

type Overlay = { frameId: string; position: "center" | "top" | "bottom"; dismissOutside: boolean };
export type PrototypeSession = {
  frameId: string;
  history: string[];
  overlays: Overlay[];
  states: Record<string, PrototypeState>;
  variants: Record<string, string>;
  entry: number;
  transition: PrototypeTransition;
};
export function startPrototype(frameId: string): PrototypeSession {
  return {
    frameId,
    history: [],
    overlays: [],
    states: {},
    variants: {},
    entry: 0,
    transition: { type: "instant", duration: 0 },
  };
}
export function playInteraction(
  session: PrototypeSession,
  interaction: PrototypeInteraction,
): PrototypeSession {
  const { action, transition } = interaction;
  const next = { ...session, transition };
  switch (action.type) {
    case "navigate":
      return {
        ...next,
        frameId: action.target,
        history: [...session.history, session.frameId].slice(-100),
        overlays: [],
        entry: session.entry + 1,
      };
    case "openOverlay":
      return {
        ...next,
        overlays: [
          ...session.overlays,
          {
            frameId: action.target,
            position: action.position,
            dismissOutside: action.dismissOutside,
          },
        ].slice(-10),
        entry: session.entry + 1,
      };
    case "closeOverlay":
      return session.overlays.length
        ? { ...next, overlays: session.overlays.slice(0, -1), entry: session.entry + 1 }
        : session;
    case "back":
      return session.overlays.length
        ? { ...next, overlays: session.overlays.slice(0, -1), entry: session.entry + 1 }
        : session.history.length
          ? {
              ...next,
              frameId: session.history.at(-1)!,
              history: session.history.slice(0, -1),
              entry: session.entry + 1,
            }
          : session;
    case "setState":
      return { ...session, states: { ...session.states, [action.target]: action.state } };
    case "setVariant":
      return { ...session, variants: { ...session.variants, [action.target]: action.variant } };
  }
}
export function prototypeInteraction(
  node: DesignNode,
  type: "click" | "hover" | "key",
  key?: string,
): PrototypeInteraction | undefined {
  return prototypeInteractions(node, type, key)[0];
}
export function prototypeInteractions(
  node: DesignNode,
  type: "click" | "hover" | "key",
  key?: string,
): PrototypeInteraction[] {
  const authored =
    node.interactions?.filter(
      (item) =>
        item.trigger.type === type && (item.trigger.type !== "key" || item.trigger.key === key),
    ) ?? [];
  if (authored.length || type !== "click" || !node.linkTo) return authored;
  return [
    {
      id: "legacy-link",
      trigger: { type: "click" },
      action: { type: "navigate", target: node.linkTo },
      transition: { type: "instant", duration: 0 },
    },
  ];
}
export function prototypeFrameNodes(document: DesignDocument, frameId: string) {
  const ids = new Set([frameId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of document.nodes)
      if (node.visible && node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
  }
  return document.nodes.filter((node) => ids.has(node.id) && node.visible);
}
