import { useEffect, useId, useState } from "react";
import { browser } from "wxt/browser";
import type { ExtensionAccount } from "@bella/design/web-capture";
import type { Destination, ImportJob, Reply } from "../../lib/messages";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Button } from "@tidy/ui/button";
import { applyTheme } from "../../lib/theme";

async function send<T>(message: object): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as Reply<T>;
  if ("error" in reply) throw new Error(reply.error);
  return reply.data;
}

export function App() {
  const workspaceLabel = useId();
  const fileLabel = useId();
  const [account, setAccount] = useState<ExtensionAccount>();
  const [organizationId, setOrganizationId] = useState("");
  const [fileId, setFileId] = useState("");
  const [job, setJob] = useState<ImportJob>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const data = await send<ExtensionAccount>({ type: "bella:account" });
        const stored = await browser.storage.local.get("destination");
        if (!live) return;
        setAccount(data);
        setError("");
        const last = stored.destination as Destination | undefined;
        const organization =
          data.organizations.find(
            (item) => last?.userId === data.user.id && item.id === last.organizationId,
          ) ?? data.organizations[0];
        setOrganizationId((id) =>
          data.organizations.some((item) => item.id === id) ? id : (organization?.id ?? ""),
        );
        setFileId((id) =>
          organization?.files.some((file) => file.id === id)
            ? id
            : organization?.files.some((file) => file.id === last?.fileId)
              ? (last?.fileId ?? "")
              : "",
        );
      } catch (error) {
        if (live) {
          setAccount(undefined);
          setError(error instanceof Error ? error.message : "Could not connect to Tidy.");
        }
      } finally {
        if (live) setLoading(false);
      }
    };
    void refresh();
    void browser.storage.session.get("job").then((value) => {
      if (live) setJob(value.job as ImportJob | undefined);
    });
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && changes.theme) applyTheme(changes.theme.newValue);
      if (area === "session" && changes.job) setJob(changes.job.newValue as ImportJob | undefined);
    };
    browser.storage.onChanged.addListener(changed);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(changed);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const organization = account?.organizations.find((item) => item.id === organizationId);
  const activeJob = job?.userId === account?.user.id ? job : undefined;
  const busy = starting || activeJob?.state === "importing" || activeJob?.state === "selecting";
  const copy = async (mode: "page" | "element") => {
    if (!account) return;
    setError("");
    setStarting(true);
    const destination = { organizationId, fileId: fileId || undefined, userId: account.user.id };
    try {
      await browser.storage.local.set({ destination });
      await send({ type: "bella:start", mode, destination });
      if (mode === "element") window.close();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not copy page.");
    } finally {
      setStarting(false);
    }
  };
  return (
    <main>
      <header>
        <span className="brand-name">Tidy</span>
        {account && <small>{account.user.name}</small>}
      </header>
      {loading ? (
        <p role="status">Connecting to Tidy…</p>
      ) : !account ? (
        <>
          <p role="alert">{error}</p>
          <Button
            className="primary"
            onClick={() =>
              void send({ type: "bella:login" })
                .then(() => window.close())
                .catch((error) => setError(error.message))
            }
          >
            Sign in to Tidy
          </Button>
        </>
      ) : (
        <>
          {!account.organizations.length ? (
            <p>Join a workspace in Tidy to import designs.</p>
          ) : (
            <>
              {account.organizations.length > 1 && (
                <div className="field">
                  <span id={workspaceLabel}>Workspace</span>
                  <SelectMenu
                    label="Workspace"
                    labelledBy={workspaceLabel}
                    className="select-menu"
                    triggerClassName="select-trigger"
                    value={organizationId}
                    disabled={busy}
                    onChange={(value) => {
                      setOrganizationId(value);
                      setFileId("");
                    }}
                    options={account.organizations.map((item) => ({
                      value: item.id,
                      label: item.name,
                    }))}
                  />
                </div>
              )}
              <div className="field">
                <span id={fileLabel}>Design file</span>
                <SelectMenu
                  label="Design file"
                  labelledBy={fileLabel}
                  className="select-menu"
                  triggerClassName="select-trigger"
                  value={fileId}
                  disabled={busy}
                  onChange={setFileId}
                  options={[
                    { value: "", label: "New design file" },
                    ...(organization?.files.map((file) => ({ value: file.id, label: file.name })) ??
                      []),
                  ]}
                />
              </div>
              <div className="actions">
                <Button
                  className="primary"
                  disabled={busy || !organizationId}
                  onClick={() => void copy("page")}
                >
                  Copy page
                </Button>
                <Button
                  className="secondary"
                  disabled={busy || !organizationId}
                  onClick={() => void copy("element")}
                >
                  Select element
                </Button>
              </div>
            </>
          )}
          {activeJob?.state === "selecting" && (
            <div className="status">
              <p role="status">Select an element on the page.</p>
              <Button
                className="secondary"
                onClick={() =>
                  void send({ type: "bella:cancel" }).catch((error) => setError(error.message))
                }
              >
                Cancel selection
              </Button>
            </div>
          )}
          {(starting || activeJob?.state === "importing") && (
            <p role="status">Importing into Tidy…</p>
          )}
          {activeJob?.state === "done" && (
            <div className="status">
              <a href={activeJob.url} target="_blank" rel="noreferrer">
                Open imported design ↗
              </a>
              {!!activeJob.warnings?.length && (
                <details>
                  <summary>
                    {activeJob.warnings.length} capture{" "}
                    {activeJob.warnings.length === 1 ? "note" : "notes"}
                  </summary>
                  <ul>
                    {activeJob.warnings.map((warning, index) => (
                      <li key={index}>{warning.message}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {(error || activeJob?.state === "error") && (
            <p role="alert">{error || activeJob?.error}</p>
          )}
        </>
      )}
    </main>
  );
}
