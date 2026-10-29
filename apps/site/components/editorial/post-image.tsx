import type { BlogPost } from "../../lib/blog";
import { CloudArtwork } from "../brand/cloud-artwork";
import styles from "./editorial.module.css";

export function PostImage({ post, hero = false }: { post: BlogPost; hero?: boolean }) {
  const cover = post.coverImage;
  if (!cover)
    return (
      <div
        className={hero ? styles.articleArtwork : styles.postArtwork}
        data-artwork={post.artwork}
        aria-hidden="true"
      >
        <CloudArtwork
          name={post.artwork}
          sizes={hero ? "(max-width: 640px) 60vw, 520px" : "(max-width: 640px) 60vw, 230px"}
          eager={hero}
        />
      </div>
    );
  const sizes = hero
    ? "(max-width: 640px) calc(100vw - 40px), (max-width: 1184px) calc(100vw - 64px), 1120px"
    : "(max-width: 640px) calc(100vw - 40px), (max-width: 900px) 220px, 280px";
  return (
    <picture className={hero ? styles.coverHero : styles.coverCard}>
      <source
        type="image/avif"
        srcSet={cover.sources.avif.map((file) => `${file.src} ${file.width}w`).join(", ")}
        sizes={sizes}
      />
      {/* Prebuilt variants work on the static host without a runtime image service. */}
      <img
        src={cover.sources.webp.at(-1)!.src}
        srcSet={cover.sources.webp.map((file) => `${file.src} ${file.width}w`).join(", ")}
        sizes={sizes}
        width={cover.width}
        height={cover.height}
        alt={hero ? post.coverAlt : ""}
        loading={hero ? "eager" : "lazy"}
        fetchPriority={hero ? "high" : undefined}
        decoding="async"
      />
    </picture>
  );
}
