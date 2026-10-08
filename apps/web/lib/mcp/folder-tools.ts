import type { McpServer } from "@modelcontextprotocol/server";
import { revalidatePath } from "next/cache";
import * as z from "zod";
import {
  createDesignFolderForUser,
  deleteDesignFolderForUser,
  listDesignFolders,
  moveDesignFileForUser,
  renameDesignFolderForUser,
} from "@/lib/design/folder-service";

const result = (value: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});
const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true as const,
});

export function registerFolderTools(server: McpServer, userId: string) {
  server.registerTool(
    "list_folders",
    {
      description:
        "List folders and their IDs in a Tidy organization you belong to. Folders are flat; files expose folderId through list_files.",
      inputSchema: z.object({ organization_id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    async ({ organization_id }) => {
      try {
        return result({ folders: await listDesignFolders(userId, organization_id) });
      } catch {
        return failure("Could not list folders. Check organization access.");
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      description:
        "Create a named folder in a Tidy organization. Requires an Editor, Admin or Owner role.",
      inputSchema: z.object({
        organization_id: z.string().min(1),
        name: z.string().min(1).max(120),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ organization_id, name }) => {
      try {
        const folder = await createDesignFolderForUser(userId, organization_id, name);
        revalidatePath("/files");
        return result({ folder });
      } catch {
        return failure("Could not create the folder. Check the name and organization access.");
      }
    },
  );

  server.registerTool(
    "rename_folder",
    {
      description: "Rename an existing Tidy folder. Requires edit access to its organization.",
      inputSchema: z.object({ folder_id: z.string().min(1), name: z.string().min(1).max(120) }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ folder_id, name }) => {
      try {
        const folder = await renameDesignFolderForUser(userId, folder_id, name);
        revalidatePath("/files");
        return result({ folder });
      } catch {
        return failure("Could not rename the folder. Check the name and folder access.");
      }
    },
  );

  server.registerTool(
    "delete_folder",
    {
      description:
        "Delete a Tidy folder and move all its files to the organization root. Files and their archive status are preserved. Requires edit access.",
      inputSchema: z.object({ folder_id: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ folder_id }) => {
      try {
        const deleted = await deleteDesignFolderForUser(userId, folder_id);
        revalidatePath("/files");
        return result({ deleted });
      } catch {
        return failure("Could not delete the folder. Check folder access.");
      }
    },
  );

  server.registerTool(
    "move_file",
    {
      description:
        "Move a Tidy file into a folder in the same organization, or to the organization root with folder_id: null. Use after commit_import to organize a new imported file. Requires edit access.",
      inputSchema: z.object({
        file_id: z.string().min(1),
        folder_id: z.string().min(1).nullable(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ file_id, folder_id }) => {
      try {
        const file = await moveDesignFileForUser(userId, file_id, folder_id);
        revalidatePath("/files");
        revalidatePath(`/files/${file_id}`);
        return result({ file });
      } catch {
        return failure(
          "Could not move the file. Check file and folder access; both must belong to the same organization.",
        );
      }
    },
  );
}
