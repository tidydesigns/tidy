import { boundedRequest, RequestBodyError } from "@/lib/http/request-body";

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_REQUEST_BYTES = MAX_IMAGES * MAX_IMAGE_BYTES + 64_000;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FeedbackError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function validateImages(files: File[]) {
  if (!files.length || files.length > MAX_IMAGES) throw new FeedbackError("Attach up to 3 images.");
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type))
      throw new FeedbackError("Choose PNG, JPEG or WebP images.");
    if (!file.size || file.size > MAX_IMAGE_BYTES)
      throw new FeedbackError("Each image must be under 5 MB.");
  }
}

export function validateSignature(type: string, bytes: Uint8Array) {
  const starts = (values: number[], offset = 0) =>
    values.every((value, i) => bytes[offset + i] === value);
  const valid =
    type === "image/png"
      ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : type === "image/jpeg"
        ? starts([255, 216, 255])
        : type === "image/webp" && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8);
  if (!valid) throw new FeedbackError("The image contents do not match its file type.");
}

export function canReadAttachment(
  ownerId: string,
  user: { id: string; email: string; emailVerified: boolean },
  reviewers: string,
) {
  return (
    ownerId === user.id ||
    (user.emailVerified &&
      reviewers.split(",").some((email) => email.trim().toLowerCase() === user.email.toLowerCase()))
  );
}

// Enforce the limit while streaming, including requests without Content-Length.
export async function readUploadForm(request: Request, maxBytes = MAX_REQUEST_BYTES) {
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data;"))
    throw new FeedbackError("Expected image attachments.");
  if (!request.body) throw new FeedbackError("Missing attachments.");
  try {
    return await (await boundedRequest(request, maxBytes)).formData();
  } catch (error) {
    if (error instanceof RequestBodyError) throw new FeedbackError(error.message, error.status);
    throw new FeedbackError("Could not read image attachments.");
  }
}
