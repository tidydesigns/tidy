import { UserFacingError } from "@tidy/ui/errors";

const complexityMessage =
  "This image has too many small details to vectorise. Try cropping to a simpler area.";

const messages = new Map([
  ["This trace has too many points. Try fewer colours or a simpler image.", complexityMessage],
  ["This trace has too many shapes. Try fewer colours or a simpler image.", complexityMessage],
  [
    "This trace exceeds the editable path limits. Try fewer colours or a simpler image.",
    complexityMessage,
  ],
  ["This trace is too large to verify. Try fewer colours or a simpler image.", complexityMessage],
  ["This trace is too large for the canvas. Try fewer colours.", complexityMessage],
  [
    "Vectorisation took too long. Try a simpler image.",
    "Vectorisation took too long. Try cropping to a simpler area.",
  ],
  [
    "Choose an image under 2 MB.",
    "This image is too large to vectorise. Choose an image under 2 MB.",
  ],
  [
    "Choose an image with at most 16 million source pixels.",
    "This image has too many pixels to vectorise. Resize it to 16 megapixels or less.",
  ],
  [
    "Image bounds must be between 1 and 5,000 pixels.",
    "This image's bounds are outside the vectorisation limits. Resize it to between 1 and 5,000 pixels on each side.",
  ],
  [
    "Vectorisation supports PNG, JPEG and WebP images.",
    "Vectorisation supports PNG, JPEG and WebP images. Convert this image to one of these formats first.",
  ],
  [
    "This image loses too much detail when vectorised. Try more colours or a cleaner source image.",
    "Vectorisation would lose too much detail. Try more colours or a cleaner source image.",
  ],
  [
    "No shapes survived tracing. Try a larger image.",
    "No visible shapes could be traced. Try a clearer or higher-resolution image.",
  ],
  [
    "Could not decode this image.",
    "This image could not be opened for vectorisation. Try replacing it with a new PNG, JPEG or WebP copy.",
  ],
  [
    "Could not read the image. Check your file access.",
    "This image could not be read for vectorisation. Check your file access and try again.",
  ],
]);

export function vectorisationError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof UserFacingError) return error;
  const message = messages.get(error.message);
  return message ? new UserFacingError(message, { cause: error }) : error;
}
