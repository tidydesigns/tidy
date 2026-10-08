import { createRoot } from "react-dom/client";
import { DesignImage } from "../../components/design/design-image";
import { ImageMimeProvider } from "@tidy/design-renderer/image-context";
import { buildDrawnNode } from "../../lib/design/document";
import { embedDesignImages } from "../../lib/design/export-images";
import { initialImageCrop, loadedImageSize } from "../../lib/design/image-crop";
const root = createRoot(document.getElementById("root")!);
const node = (id: string, width: number, crop: boolean) => ({
  ...buildDrawnNode(id, "container", null, { x: 0, y: 0, width, height: width }),
  type: "image" as const,
  assetId: "00000000-0000-4000-8000-000000000001",
  style: crop
    ? {
        imageCrop: {
          x: 0.25,
          y: 0.25,
          width: 0.5,
          height: 0.5,
          sourceWidth: 100,
          sourceHeight: 100,
        },
      }
    : {},
});
function render(source: string) {
  root.render(
    <ImageMimeProvider types={{ "00000000-0000-4000-8000-000000000001": "image/svg+xml" }}>
      {Array.from({ length: 2 }, (_, index) => (
        <div
          key={index}
          id={`image-${index}`}
          style={{ width: index ? 44 : 18, height: index ? 44 : 18 }}
        >
          <DesignImage node={node(`node-${index}`, index ? 44 : 18, index === 1)} src={source} />
        </div>
      ))}
    </ImageMimeProvider>,
  );
}
Object.assign(window, {
  renderImages: render,
  clearImages: () => root.render(null),
  captureCrop: () => {
    const size = loadedImageSize(document.querySelector<HTMLImageElement>("#image-0 img"));
    const image = node("node-0", 18, false);
    return size ? initialImageCrop(image, image.box, size.width, size.height) : null;
  },
  exportImages: async () => {
    const clone = document.getElementById("root")!.cloneNode(true) as HTMLElement;
    await embedDesignImages(clone);
    return clone.innerHTML;
  },
});
render("/api/assets/recover");
