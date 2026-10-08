export const MAX_CAPTURE_BYTES = 16_000_000;

export function captureSourceUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}
