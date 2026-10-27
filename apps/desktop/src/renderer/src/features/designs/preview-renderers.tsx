import type { ComponentProps } from "react";
import { lazyView } from "../../components/lazy-view";

export const DocumentPreview = lazyView(
  async () => ({
    default: (await import("@tidy/editor/components/files/document-preview")).DocumentPreview,
  }),
  { label: "design preview" },
);

export const ThumbnailRenderer = lazyView(
  async () => ({
    default: (await import("@tidy/editor/components/files/thumbnail-renderer")).ThumbnailRenderer,
  }),
  {
    label: "thumbnail",
    fallback: () => null,
    errorFallback: null,
    onError: (props, error) => props.onError(error),
  },
);

type ArtworkProps = ComponentProps<typeof DocumentPreview> & { onError(error: unknown): void };

export const PreviewArtwork = lazyView(
  async () => {
    const { DocumentPreview } = await import("@tidy/editor/components/files/document-preview");
    return {
      default: function Artwork(props: ArtworkProps) {
        return <DocumentPreview {...props} />;
      },
    };
  },
  {
    label: "design preview",
    fallback: () => <span className="text-xs text-muted-ink">Loading preview…</span>,
    errorFallback: <span className="text-xs text-muted-ink">Preview unavailable</span>,
    onError: (props, error) => props.onError(error),
  },
);
