import {
  readEditableRichText,
  richTextElements,
  sanitizeRichPaste,
} from "@/app/files/[uid]/rich-text-dom";
Object.assign(globalThis, {
  richTextDOM: { readEditableRichText, richTextElements, sanitizeRichPaste },
});
