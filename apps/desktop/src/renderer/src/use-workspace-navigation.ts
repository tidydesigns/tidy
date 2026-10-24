import { useCallback, useEffect, useRef, useState } from "react";
import { restoreWorkspaceTarget, workspaceTargetSchema } from "../../shared/navigation-state";
import { useSessionState } from "./session-state";
import type { CloudConnection } from "./use-cloud";

export function useWorkspaceNavigation({
  cloud,
  hasCloudAPI,
}: {
  cloud: Pick<CloudConnection, "state" | "account">;
  hasCloudAPI: boolean;
}) {
  const [target, setTarget] = useSessionState("workspace", workspaceTargetSchema, null);
  const [lastCloudTarget, setLastCloudTarget] = useState(target?.kind === "cloud" ? target : null);
  useEffect(() => {
    if (target?.kind === "cloud") setLastCloudTarget(target);
  }, [target]);
  const cloudTarget = target?.kind === "cloud" ? target : lastCloudTarget;
  const cloudAccount = useRef<string | undefined>(undefined);
  const navigation = useRef(0);
  const cloudOrganizationId =
    cloudTarget &&
    cloudTarget.accountId === cloud.state?.accountId &&
    cloudTarget.accountId === cloud.account?.id &&
    cloud.account.organizations.some((o) => o.id === cloudTarget.organizationId && o.canEdit)
      ? cloudTarget.organizationId
      : "";
  const location = target?.kind === "cloud" ? "cloud" : "local";
  useEffect(() => {
    if (!hasCloudAPI) {
      if (target?.kind === "cloud") setTarget({ kind: "local" });
      return;
    }
    if (!cloud.state) return;
    if (!cloud.state.signedIn) {
      cloudAccount.current = undefined;
      if (target?.kind === "cloud") setTarget({ kind: "local" });
      return;
    }
    if (!cloud.account || cloud.account.id !== cloud.state.accountId) return;
    const account = cloud.account;
    const changedAccount =
      cloudAccount.current !== undefined && cloudAccount.current !== account.id;
    cloudAccount.current = account.id;
    const next = restoreWorkspaceTarget({
      target,
      account,
      changedAccount,
      navigated: navigation.current !== 0,
    });
    if (next !== target) setTarget(next);
  }, [hasCloudAPI, cloud.state, cloud.account, target, setTarget]);

  const selectLocalWorkspace = useCallback(() => setTarget({ kind: "local" }), [setTarget]);
  const selectCloudWorkspace = useCallback(
    (organizationId: string) => {
      navigation.current++;
      if (cloud.account) setTarget({ kind: "cloud", accountId: cloud.account.id, organizationId });
    },
    [cloud.account, setTarget],
  );

  return {
    target,
    location,
    cloudOrganizationId,
    navigation,
    selectLocalWorkspace,
    selectCloudWorkspace,
  } as const;
}
