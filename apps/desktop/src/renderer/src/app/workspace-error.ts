import {
  branchSwitchMessages,
  type BranchSwitchResult,
} from "../../../shared/contracts/repository-context";
import { UserFacingError, errorMessage } from "@tidy/ui/errors";

export type WorkspaceError = {
  original?: unknown;
  projectId?: string;
  text: string;
};

export const errorText = (error: unknown) =>
  errorMessage(error, "The operation could not be completed. Please try again.");

export function branchSwitchContext(result: BranchSwitchResult) {
  if (result.kind === "blocked") throw new UserFacingError(branchSwitchMessages[result.reason]);
  return result.context;
}
