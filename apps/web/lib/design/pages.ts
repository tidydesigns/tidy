import { DEFAULT_PAGE_ID, nodePageId, type DesignDocument } from "./document";
import { remapComponentVariants, removeComponentReferences } from "./component-variants";

export function documentPages(document: DesignDocument) {
  return document.pages ?? [{ id: DEFAULT_PAGE_ID, name: "Page 1" }];
}

export function pageNodes(document: DesignDocument, pageId: string) {
  return document.nodes.filter((node) => nodePageId(node) === pageId);
}

export function nextPageName(document: DesignDocument) {
  const names = new Set(documentPages(document).map((page) => page.name));
  let index = documentPages(document).length + 1;
  while (names.has(`Page ${index}`)) index++;
  return `Page ${index}`;
}

export function duplicatePage(
  document: DesignDocument,
  pageId: string,
  newPageId: string,
  newId: () => string,
): DesignDocument {
  const pages = documentPages(document);
  const source = pages.find((page) => page.id === pageId);
  if (!source) return document;
  const sourceNodes = pageNodes(document, pageId);
  const ids = new Map(sourceNodes.map((node) => [node.id, newId()]));
  const copies = sourceNodes.map((node) => ({
    ...node,
    id: ids.get(node.id)!,
    pageId: newPageId,
    parentId: node.parentId ? (ids.get(node.parentId) ?? null) : null,
    linkTo: node.linkTo ? (ids.get(node.linkTo) ?? node.linkTo) : undefined,
    instanceOf: node.instanceOf ? (ids.get(node.instanceOf) ?? node.instanceOf) : undefined,
    componentSourceId: node.componentSourceId
      ? (ids.get(node.componentSourceId) ?? node.componentSourceId)
      : undefined,
    variants: remapComponentVariants(node.variants, ids),
    sourceKey: undefined,
    sourcePath: undefined,
    importKey: undefined,
  }));
  const index = pages.findIndex((page) => page.id === pageId);
  return {
    ...document,
    pages: [
      ...pages.slice(0, index + 1),
      {
        id: newPageId,
        name: `${source.name.slice(0, 115)} copy`,
        guides: source.guides?.map((guide) => ({ ...guide, id: newId() })),
      },
      ...pages.slice(index + 1),
    ],
    nodes: [...document.nodes, ...copies],
  };
}

export function deletePage(document: DesignDocument, pageId: string): DesignDocument {
  const pages = documentPages(document);
  if (pages.length <= 1 || !pages.some((page) => page.id === pageId)) return document;
  const removed = new Set(pageNodes(document, pageId).map((node) => node.id));
  return {
    ...document,
    pages: pages.filter((page) => page.id !== pageId),
    nodes: removeComponentReferences(document.nodes, removed),
    editedNodeIds: document.editedNodeIds.filter((id) => !removed.has(id)),
  };
}
