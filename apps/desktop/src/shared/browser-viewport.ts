// Bound Retina capture work even when a large preview is expanded or used remotely.
export function browserDeviceScaleFactor(width: number, height: number, density: number) {
  return Math.max(
    1,
    Math.min(2, density || 1, 3840 / width, 2160 / height, Math.sqrt(4_194_304 / (width * height))),
  );
}

export function browserFrameSize(tab: {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}) {
  const scale = tab.deviceScaleFactor ?? 1;
  return { width: Math.round(tab.width * scale), height: Math.round(tab.height * scale) };
}
