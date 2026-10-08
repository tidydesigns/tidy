import { useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { ExtensionAccount } from "@bella/design/web-capture";
import type { Destination, ImportJob, Reply } from "../../lib/messages";

async function send<T>(message: object): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as Reply<T>;
  if ("error" in reply) throw new Error(reply.error);
  return reply.data;
}

export function App() {
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
        <img src="/icon/48.png" alt="" width="24" height="24" />
        <span className="brand-name">Tidy</span>
        {account && <small>{account.user.name}</small>}
      </header>
      {loading ? (
        <p role="status">Connecting to Tidy…</p>
      ) : !account ? (
        <>
          <p role="alert">{error}</p>
          <button
            onClick={() =>
              void send({ type: "bella:login" })
                .then(() => window.close())
                .catch((error) => setError(error.message))
            }
          >
            Sign in to Tidy
          </button>
        </>
      ) : (
        <>
          {!account.organizations.length ? (
            <p>Join a workspace in Tidy to import designs.</p>
          ) : (
            <>
              {account.organizations.length > 1 && (
                <label>
                  Workspace
                  <select
                    value={organizationId}
                    disabled={busy}
                    onChange={(event) => {
                      setOrganizationId(event.target.value);
                      setFileId("");
                    }}
                  >
                    {account.organizations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Design file
                <select
                  value={fileId}
                  disabled={busy}
                  onChange={(event) => setFileId(event.target.value)}
                >
                  <option value="">New design file</option>
                  {organization?.files.map((file) => (
                    <option key={file.id} value={file.id}>
                      {file.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button disabled={busy || !organizationId} onClick={() => void copy("page")}>
                  Copy page
                </button>
                <button
                  className="secondary"
                  disabled={busy || !organizationId}
                  onClick={() => void copy("element")}
                >
                  Select element
                </button>
              </div>
            </>
          )}
          {activeJob?.state === "selecting" && (
            <div className="status">
              <p role="status">Select an element on the page.</p>
              <button
                className="secondary"
                onClick={() =>
                  void send({ type: "bella:cancel" }).catch((error) => setError(error.message))
                }
              >
                Cancel selection
              </button>
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
