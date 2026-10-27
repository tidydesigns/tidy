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
    onError: (props, error) => props.onError(error),
  },
);
