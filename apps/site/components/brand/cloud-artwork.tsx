import manifest from "../../public/artwork/manifest.json";

type ArtworkName = keyof typeof manifest.assets;

export function CloudArtwork({
  name,
  sizes,
  className = "",
  eager = false,
}: {
  name: ArtworkName;
  sizes: string;
  className?: string;
  eager?: boolean;
}) {
  const artwork = manifest.assets[name];
  const sourceSet = (format: string) =>
    artwork.outputs
      .filter((file) => file.format === format)
      .map((file) => `${file.src} ${file.width}w`)
      .join(", ");
  return (
    <picture className={className}>
      <source type="image/avif" srcSet={sourceSet("avif")} sizes={sizes} />
      {/* Static export: prebuilt responsive sources avoid an image optimization server. */}
      <img
        src={
          artwork.outputs.find((file) => file.format === "webp" && file.width === artwork.width)
            ?.src
        }
        srcSet={sourceSet("webp")}
        sizes={sizes}
        width={artwork.width}
        height={artwork.height}
        alt=""
        loading={eager ? "eager" : "lazy"}
        decoding="async"
      />
    </picture>
  );
}
