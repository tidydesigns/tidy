import type { BrowserInput } from "../../../../shared/contracts/browser";

type Command = NonNullable<Extract<BrowserInput, { kind: "key" }>["command"]>;

const movement = {
  ArrowLeft: {
    option: ["moveWordLeft", "moveWordLeftAndModifySelection"],
    command: ["moveToLeftEndOfLine", "moveToLeftEndOfLineAndModifySelection"],
  },
  ArrowRight: {
    option: ["moveWordRight", "moveWordRightAndModifySelection"],
    command: ["moveToRightEndOfLine", "moveToRightEndOfLineAndModifySelection"],
  },
  ArrowUp: {
    option: ["moveParagraphBackward", "moveParagraphBackwardAndModifySelection"],
    command: ["moveToBeginningOfDocument", "moveToBeginningOfDocumentAndModifySelection"],
  },
  ArrowDown: {
    option: ["moveParagraphForward", "moveParagraphForwardAndModifySelection"],
    command: ["moveToEndOfDocument", "moveToEndOfDocumentAndModifySelection"],
  },
} satisfies Record<string, { option: [Command, Command]; command: [Command, Command] }>;

export function browserEditingCommand(event: {
  key: string;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): Command | undefined {
  if (event.ctrlKey || event.altKey === event.metaKey) return;
  if (event.key === "Backspace")
    return event.metaKey ? "deleteToBeginningOfLine" : "deleteWordBackward";
  if (event.key === "Delete") return event.metaKey ? "deleteToEndOfLine" : "deleteWordForward";
  const key = event.key;
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown")
    return;
  return movement[key][event.metaKey ? "command" : "option"][event.shiftKey ? 1 : 0];
}
