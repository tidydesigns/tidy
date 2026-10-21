"use server";

import {
  createBrowserFileForUser,
  duplicateFolderForUser,
  duplicateFileForUser,
  archiveFileForUser,
} from "@/lib/design/file-management";
import { actionError } from "@/lib/action-error";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { deleteArchivedDesignFileForUser, renameDesignFileForUser } from "@/lib/design/service";
import {
  createDesignFolderForUser,
  deleteDesignFolderForUser,
  moveDesignFileForUser,
  renameDesignFolderForUser,
} from "@/lib/design/folder-service";

export async function createDesignFile(
  folderId: string | null = null,
  organizationId?: string,
): Promise<{ error: string }> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { error: "Sign in to create a file." };

  // Files already knows its workspace. The service still checks current edit
  // authority, folder ownership and quota; this is only a lookup shortcut.
  const targetOrganizationId =
    organizationId ??
    session.session.activeOrganizationId ??
    (await auth.api.listOrganizations({ headers: requestHeaders }))[0]?.id;
  if (!targetOrganizationId) return { error: "Create an organisation first." };

  const result = await createBrowserFileForUser(session.user.id, targetOrganizationId, folderId);
  if (result.error !== undefined) return { error: result.error };
  revalidatePath("/files");
  // Redirect in the action so revalidation does not render the Files listing
  // before the client can start a second request for the editor.
  redirect(`/files/${encodeURIComponent(result.id)}`);
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
  } catch (error) {
    return { error: actionError(error, "Could not create the folder. Please try again.") };
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
  } catch (error) {
    return { error: actionError(error, "Could not rename the folder.") };
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
  } catch (error) {
    return { error: actionError(error, "Could not delete the folder.") };
  }
  revalidatePath("/files");
  return {};
}

export async function renameDesignFile(fileId: string, name: string): Promise<{ error?: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { error: "Sign in to rename this file." };
  try {
    await renameDesignFileForUser(session.user.id, fileId, name);
  } catch (error) {
    return { error: actionError(error, "Could not rename the file.") };
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
  } catch (error) {
    return { error: actionError(error, "Could not move the file.") };
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
