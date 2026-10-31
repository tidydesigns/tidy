import type { DesktopAPI } from "../../../../shared/contracts/desktop";

async function imagePng(input: {
  api: Pick<DesktopAPI, "readAttachment">;
  projectId: string;
  attachmentId: string;
}) {
  const file = await input.api.readAttachment(input.projectId, input.attachmentId);
  if (!file.previewUrl || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(file.previewUrl))
    throw new Error("This image is unavailable.");
  const blob = await (await fetch(file.previewUrl)).blob();
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width * bitmap.height > 64_000_000)
      throw new Error("This image is too large to copy.");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image copying is unavailable.");
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

export function copyAttachmentImage(input: Parameters<typeof imagePng>[0]) {
  return navigator.clipboard.write([new ClipboardItem({ "image/png": imagePng(input) })]);
}
