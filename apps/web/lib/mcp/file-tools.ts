import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import {
  duplicateFileForUser,
  duplicateFolderForUser,
  archiveFileForUser,
} from "@/lib/design/file-management";
import { deleteArchivedDesignFileForUser } from "@/lib/design/service";
import { PublicActionError } from "@/lib/security/public-error";
import { mcpSchema } from "./schema";
import { mcpToolPolicy } from "./tool-policy";
import { toolOperation } from "./tool-result";
const id = z.string().min(1).max(120);
export function registerFileTools(server: McpServer, userId: string) {
  server.registerTool(
    "duplicate_file",
    {
      ...mcpToolPolicy("duplicate_file"),
      description:
        "Duplicate a file and its design into an active copy in the same organization/folder. Does not copy comment threads. Check list_files before retrying an uncertain response.",
      inputSchema: mcpSchema("duplicate_file", () => z.object({ file_id: id })),
    },
    ({ file_id }) =>
      toolOperation(async () => {
        const copied = await duplicateFileForUser(userId, file_id);
        if (copied.error) throw new PublicActionError(copied.error);
        return { fileId: copied.id };
      }, "Could not duplicate the file."),
  );
  server.registerTool(
    "duplicate_folder",
    {
      ...mcpToolPolicy("duplicate_folder"),
      description:
        "Duplicate a folder and its files within the same organization, preserving their archive status. Existing copy/plan limits apply. Check list_folders before retrying an uncertain response.",
      inputSchema: mcpSchema("duplicate_folder", () => z.object({ folder_id: id })),
    },
    ({ folder_id }) =>
      toolOperation(async () => {
        const copied = await duplicateFolderForUser(userId, folder_id);
        if (copied.error) throw new PublicActionError(copied.error);
        return copied;
      }, "Could not duplicate the folder."),
  );
  for (const name of ["archive_file", "restore_file"] as const)
    server.registerTool(
      name,
      {
        ...mcpToolPolicy(name),
        description:
          name === "archive_file"
            ? "Archive a file. Its document and comments are preserved. Requires edit access."
            : "Restore an archived file to the active file list. Requires edit access.",
        inputSchema: mcpSchema(name, () => z.object({ file_id: id })),
      },
      ({ file_id }) =>
        toolOperation(async () => {
          const updated = await archiveFileForUser(userId, file_id, name === "archive_file");
          if (updated.error) throw new PublicActionError(updated.error);
          return { fileId: file_id, archived: name === "archive_file" };
        }, "Could not update the file."),
    );
  server.registerTool(
    "delete_file",
    {
      ...mcpToolPolicy("delete_file"),
      description:
        "Permanently delete an already archived file and its dependent records. Requires edit access. Active files must be archived first.",
      inputSchema: mcpSchema("delete_file", () => z.object({ file_id: id })),
    },
    ({ file_id }) =>
      toolOperation(async () => {
        await deleteArchivedDesignFileForUser(userId, file_id);
        return { deleted: true };
      }, "Could not delete the archived file."),
  );
}
