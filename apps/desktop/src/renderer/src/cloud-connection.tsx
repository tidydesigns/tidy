import { useEffect, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { CloudAPI, CloudAccount, CloudFile, CloudState } from "../../shared/cloud-sync";
import type { DesignSummary } from "../../shared/contracts";

/** One quiet home for opt-in cloud access; transfers never interrupt canvas work. */
export function CloudConnection({
  api,
  projectId,
  designs,
}: {
  api?: CloudAPI;
  projectId?: string;
  designs: DesignSummary[];
}) {
  const [state, setState] = useState<CloudState>();
  const [expanded, setExpanded] = useState(false);
  const [account, setAccount] = useState<CloudAccount>();
  const [organization, setOrganization] = useState("");
  const [files, setFiles] = useState<Record<string, CloudFile[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    if (!api) return;
    let active = true,
      received = false;
    const unsubscribe = api.onState((value) => {
      received = true;
      setState(value);
    });
    void api
      .state()
      .then((value) => {
        if (active && !received) setState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);
  useEffect(() => {
    const version = ++epoch.current;
    setAccount(undefined);
    setFiles({});
    setOrganization("");
    if (!api || !state?.signedIn) return;
    void api
      .account()
      .then((value) => {
        if (epoch.current !== version) return;
        setAccount(value);
        setOrganization(value.organizations.find((o) => o.canEdit)?.id ?? "");
      })
      .catch((cause: unknown) => {
        if (epoch.current === version)
          setError(cause instanceof Error ? cause.message : "Could not load cloud workspaces.");
      });
    return () => {
      epoch.current++;
    };
  }, [api, state?.signedIn, state?.accountId]);
  useEffect(() => {
    if (!api || !organization || files[organization]) return;
    const version = epoch.current;
    void api
      .files(organization)
      .then((value) => {
        if (epoch.current === version)
          setFiles((current) => ({ ...current, [organization]: value }));
      })
      .catch((cause: unknown) => {
        if (epoch.current === version)
          setError(cause instanceof Error ? cause.message : "Could not load cloud designs.");
      });
  }, [api, organization, files]);
  if (!api || !state?.available) return null;
  const bindings = state.bindings.filter((b) => b.projectId === projectId);
  const attention = bindings.find((b) => b.status === "conflict" || b.status === "paused");
  const label = !state.signedIn
    ? "Cloud sync"
    : attention
      ? "Sync needs attention"
      : bindings.some((b) => b.status === "offline")
        ? "Offline · stored locally"
        : bindings.some((b) => b.status === "syncing")
          ? "Syncing…"
          : bindings.length
            ? "Synced"
            : "Cloud connected";
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Cloud sync could not complete this action.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="cloud-connection">
      <Button
        className="cloud-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {label}
      </Button>
      {expanded && (
        <div className="cloud-panel">
          {!state.signedIn ? (
            <>
              <Button
                className="cloud-action"
                disabled={busy}
                onClick={() => void run(() => api.signIn())}
              >
                {busy ? "Complete sign-in in your browser…" : "Sign in to Tidy"}
              </Button>
              {busy && (
                <Button className="cloud-action" onClick={() => void api.signOut().catch(() => {})}>
                  Cancel sign-in
                </Button>
              )}
            </>
          ) : (
            <>
              {projectId && account && (
                <>
                  <SelectMenu
                    label="Cloud workspace"
                    value={organization}
                    options={account.organizations
                      .filter((o) => o.canEdit)
                      .map((o) => ({ value: o.id, label: o.name }))}
                    onChange={(id) => {
                      setError("");
                      setOrganization(id);
                    }}
                  />
                  {organization &&
                    designs.some((d) => !bindings.some((b) => b.designId === d.id)) && (
                      <SelectMenu
                        label="Sync local design"
                        value=""
                        disabled={busy}
                        options={[
                          { value: "", label: "Sync a local design…" },
                          ...designs
                            .filter((d) => !bindings.some((b) => b.designId === d.id))
                            .map((d) => ({ value: d.id, label: d.name })),
                        ]}
                        onChange={(id) => {
                          if (id) void run(() => api.connectLocal(projectId, id, organization));
                        }}
                      />
                    )}
                  <div className="cloud-files">
                    {(files[organization] ?? []).map((file) => {
                      const linked = bindings.some((b) => b.fileId === file.id);
                      return (
                        <Button
                          className="cloud-action"
                          key={file.id}
                          disabled={busy || linked}
                          onClick={() => void run(() => api.open(projectId, file.id, file.name))}
                        >
                          {file.name}
                          {linked ? " · Connected" : " · Open locally"}
                        </Button>
                      );
                    })}
                  </div>
                </>
              )}
              {bindings.length > 0 && (
                <div className="cloud-files">
                  {bindings.map((binding) => (
                    <div key={binding.designId} className="cloud-binding">
                      <span title={binding.message}>
                        {designs.find((d) => d.id === binding.designId)?.name ?? "Design"} ·{" "}
                        {binding.status}
                      </span>
                      {binding.status === "conflict" && (
                        <Button
                          className="cloud-action"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const name =
                                designs.find((d) => d.id === binding.designId)?.name ?? "Design";
                              await api.disconnect(binding.projectId, binding.designId);
                              await api.open(
                                binding.projectId,
                                binding.fileId,
                                `${name.slice(0, 105)} (cloud)`,
                              );
                            })
                          }
                        >
                          Keep both copies
                        </Button>
                      )}
                      <Button
                        className="cloud-action"
                        disabled={busy}
                        onClick={() =>
                          void run(() => api.disconnect(binding.projectId, binding.designId))
                        }
                      >
                        Disconnect
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {bindings.some((b) => b.status === "paused") && (
                <Button
                  className="cloud-action"
                  disabled={busy}
                  onClick={() => void run(() => api.signIn())}
                >
                  Reconnect
                </Button>
              )}
              <Button
                className="cloud-action"
                disabled={busy}
                onClick={() => void run(() => api.signOut())}
              >
                Sign out
              </Button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
