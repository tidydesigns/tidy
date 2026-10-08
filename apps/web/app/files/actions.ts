"use server";

import {
  createBrowserFileForUser,
  duplicateFolderForUser,
  duplicateFileForUser,
  archiveFileForUser,
} from "@/lib/design/file-management";
import { actionError } from "@/lib/action-error";
import type { DesignNodeChanges } from "@/lib/design/document";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import {
  addDocumentNode,
  deleteDocumentNode,
  drawDocumentNode,
  duplicateDocumentNode,
  patchDocumentNode,
  replaceDocumentForHistory,
} from "@/lib/design/document-service";
import { type DesignDocument, type DesignNode } from "@/lib/design/document";
import { deleteArchivedDesignFileForUser, renameDesignFileForUser } from "@/lib/design/service";
import {
  createDesignFolderForUser,
  deleteDesignFolderForUser,
  moveDesignFileForUser,
  renameDesignFolderForUser,
} from "@/lib/design/folder-service";

export async function createDesignFile(
  folderId: string | null = null,
): Promise<{ id?: string; error?: string }> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { error: "Sign in to create a file." };

  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const organization =
    organizations.find((item) => item.id === session.session.activeOrganizationId) ??
    organizations[0];
  if (!organization) return { error: "Create an organisation first." };

  const result = await createBrowserFileForUser(session.user.id, organization.id, folderId);
  if ("error" in result) return result;
  const { id } = result;
  revalidatePath("/files");
  return { id };
}

function validName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : null;
}

export async function createDesignFolder(name: string): Promise<{ id?: string; error?: string }> {
  const cleanName = validName(name);
  if (!cleanName) return { error: "Enter a name of up to 120 characters." };
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { error: "Sign in to create a folder." };
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const organization =
    organizations.find((item) => item.id === session.session.activeOrganizationId) ??
    organizations[0];
  if (!organization) return { error: "Create an organisation first." };

  let id: string;
  try {
    ({ id } = await createDesignFolderForUser(session.user.id, organization.id, cleanName));
  } catch {
    return { error: "Could not create the folder. Please try again." };
  }
  revalidatePath("/files");
  return { id };
}

export async function renameDesignFolder(
  folderId: string,
  name: string,
): Promise<{ error?: string }> {
  const cleanName = validName(name);
  if (!cleanName) return { error: "Enter a name of up to 120 characters." };
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to rename this folder." };
  try {
    await renameDesignFolderForUser(session.user.id, folderId, cleanName);
  } catch {
    return { error: "Could not rename the folder." };
  }
  revalidatePath("/files");
  return {};
}

export async function duplicateDesignFolder(
  folderId: string,
): Promise<{ id?: string; error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to duplicate this folder." };
  const result = await duplicateFolderForUser(session.user.id, folderId);
  if ("error" in result) return result;
  const { id } = result;
  revalidatePath("/files");
  return { id };
}

export async function deleteDesignFolder(folderId: string): Promise<{ error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to delete this folder." };
  try {
    await deleteDesignFolderForUser(session.user.id, folderId);
  } catch {
    return { error: "Could not delete the folder." };
  }
  revalidatePath("/files");
  return {};
}

export async function renameDesignFile(fileId: string, name: string): Promise<{ error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to rename this file." };
  try {
    await renameDesignFileForUser(session.user.id, fileId, name);
  } catch {
    return { error: "Could not rename the file." };
  }
  revalidatePath("/files");
  revalidatePath(`/files/${fileId}`);
  return {};
}

export async function moveDesignFile(
  fileId: string,
  folderId: string | null,
): Promise<{ error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to move this file." };
  try {
    await moveDesignFileForUser(session.user.id, fileId, folderId);
  } catch {
    return { error: "Could not move the file." };
  }
  revalidatePath("/files");
  return {};
}

export async function setDesignFileArchived(
  fileId: string,
  archived: boolean,
): Promise<{ error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  const result = await archiveFileForUser(session.user.id, fileId, archived);
  if ("error" in result) return result;
  revalidatePath("/files");
  return {};
}

export async function duplicateDesignFile(
  fileId: string,
): Promise<{ id?: string; error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to duplicate this file." };
  const result = await duplicateFileForUser(session.user.id, fileId);
  if ("error" in result) return result;
  const { id } = result;
  revalidatePath("/files");
  return { id };
}

export async function editDesignNode(
  fileId: string,
  revision: number,
  nodeId: string,
  changes: DesignNodeChanges,
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  try {
    const updated = await patchDocumentNode(session.user.id, fileId, revision, nodeId, changes);
    revalidatePath(`/files/${fileId}`);
    return updated;
  } catch (error) {
    return { error: actionError(error, "Could not edit node.") };
  }
}

export async function restoreDesignDocument(
  fileId: string,
  revision: number,
  content: DesignDocument,
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  try {
    const result = await replaceDocumentForHistory(session.user.id, fileId, revision, content);
    revalidatePath(`/files/${fileId}`);
    revalidatePath("/files");
    return result;
  } catch (error) {
    return { error: actionError(error, "Could not restore the file.") };
  }
}

export async function addDesignNode(
  fileId: string,
  revision: number,
  parentId: string | null,
  type: "text" | "container",
  pageId = "page-1",
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  try {
    const created = await addDocumentNode(
      session.user.id,
      fileId,
      revision,
      parentId,
      type,
      pageId,
    );
    revalidatePath(`/files/${fileId}`);
    return created;
  } catch (error) {
    return { error: actionError(error, "Could not add node.") };
  }
}

export async function drawDesignNode(
  fileId: string,
  revision: number,
  nodeId: string,
  type: "artboard" | "container" | "text",
  parentId: string | null,
  box: DesignNode["box"],
  pageId = "page-1",
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  try {
    const created = await drawDocumentNode(
      session.user.id,
      fileId,
      revision,
      nodeId,
      type,
      parentId,
      box,
      pageId,
    );
    revalidatePath(`/files/${fileId}`);
    revalidatePath("/files");
    return created;
  } catch (error) {
    return { error: actionError(error, "Could not draw the layer.") };
  }
}

export async function removeDesignNode(fileId: string, revision: number, nodeId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  try {
    const removed = await deleteDocumentNode(session.user.id, fileId, revision, nodeId);
    revalidatePath(`/files/${fileId}`);
    return removed;
  } catch (error) {
    return { error: actionError(error, "Could not delete node.") };
  }
}

export async function duplicateDesignNode(fileId: string, revision: number, nodeId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to edit this file." };
  try {
    const copied = await duplicateDocumentNode(session.user.id, fileId, revision, nodeId);
    revalidatePath(`/files/${fileId}`);
    revalidatePath("/files");
    return copied;
  } catch (error) {
    return { error: actionError(error, "Could not duplicate layer.") };
  }
}

export async function deleteArchivedDesignFile(fileId: string): Promise<{ error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to delete this file." };
  try {
    await deleteArchivedDesignFileForUser(session.user.id, fileId);
  } catch (error) {
    return { error: actionError(error, "Could not delete this archived file.") };
  }
  revalidatePath("/files");
  revalidatePath(`/files/${fileId}`);
  return {};
}
