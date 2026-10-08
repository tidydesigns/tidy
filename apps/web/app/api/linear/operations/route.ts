import { z } from "zod";
import { connectorError, connectorJson, connectorUser, json } from "@/lib/connectors/http";
import {
  addLinearComment,
  createLinearIssue,
  getLinearIssue,
  listLinearComments,
  listLinearTeams,
  searchLinearIssues,
  updateLinearIssue,
} from "@/lib/linear/operations";
const operations = {
  teams: listLinearTeams,
  search: searchLinearIssues,
  issue: getLinearIssue,
  comments: listLinearComments,
  create: createLinearIssue,
  comment: addLinearComment,
  update: updateLinearIssue,
};
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const userId = await connectorUser(request, true);
    const { operation, input } = z
      .object({
        operation: z.enum(["teams", "search", "issue", "comments", "create", "comment", "update"]),
        input: z.unknown(),
      })
      .parse(await connectorJson(request));
    return json(await operations[operation](userId, input));
  } catch (error) {
    return connectorError(error);
  }
}
