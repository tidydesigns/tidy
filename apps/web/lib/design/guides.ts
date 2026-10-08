import { parseDesignDocument, type DesignDocument } from "./document";

export type CanvasGuide = NonNullable<DesignDocument["pages"][number]["guides"]>[number];

export function addGuide(
  document: DesignDocument,
  pageId: string,
  guide: CanvasGuide,
): DesignDocument {
  if (!document.pages.some((page) => page.id === pageId))
    throw new Error("Choose a page for this guide.");
  return parseDesignDocument({
    ...document,
    pages: document.pages.map((page) =>
      page.id === pageId ? { ...page, guides: [...(page.guides ?? []), guide] } : page,
    ),
  });
}

export function moveGuide(
  document: DesignDocument,
  pageId: string,
  guideId: string,
  position: number,
): DesignDocument {
  if (
    !document.pages.some(
      (page) => page.id === pageId && page.guides?.some((guide) => guide.id === guideId),
    )
  )
    return document;
  return parseDesignDocument({
    ...document,
    pages: document.pages.map((page) =>
      page.id === pageId
        ? {
            ...page,
            guides: page.guides?.map((guide) =>
              guide.id === guideId ? { ...guide, position } : guide,
            ),
          }
        : page,
    ),
  });
}

export function removeGuide(
  document: DesignDocument,
  pageId: string,
  guideId: string,
): DesignDocument {
  if (
    !document.pages.some(
      (page) => page.id === pageId && page.guides?.some((guide) => guide.id === guideId),
    )
  )
    return document;
  return parseDesignDocument({
    ...document,
    pages: document.pages.map((page) =>
      page.id === pageId
        ? { ...page, guides: page.guides?.filter((guide) => guide.id !== guideId) }
        : page,
    ),
  });
}
