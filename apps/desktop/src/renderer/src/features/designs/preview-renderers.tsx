import { lazy, Suspense, type ComponentProps } from "react";

const Preview = lazy(() =>
  import("@tidy/editor/components/files/document-preview").then((module) => ({
    default: module.DocumentPreview,
  })),
);
const Thumbnail = lazy(() =>
  import("@tidy/editor/components/files/thumbnail-renderer").then((module) => ({
    default: module.ThumbnailRenderer,
  })),
);

export function DocumentPreview(props: ComponentProps<typeof Preview>) {
  return (
    <Suspense fallback={null}>
      <Preview {...props} />
    </Suspense>
  );
}

export function ThumbnailRenderer(props: ComponentProps<typeof Thumbnail>) {
  return (
    <Suspense fallback={null}>
      <Thumbnail {...props} />
    </Suspense>
  );
}
