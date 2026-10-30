import { useErrorNotice } from "@tidy/ui/use-error-notice";
import { useEffect, useId, useState } from "react";
import { browser } from "wxt/browser";
import {
  extensionAccountSchema,
  ExtensionReplyError,
  destinationSchema,
  readImportJob,
  type ExtensionAccount,
  readExtensionReply,
  parseExtensionResponse,
  type ImportJob,
} from "@tidy/design/web-capture";
import { SelectMenu } from "@tidy/ui/select-menu";
import { Button } from "@tidy/ui/button";
import { Avatar } from "@tidy/ui/avatar";
import { TidyLogo } from "@tidy/ui/tidy-logo";
import { TIDY_URL } from "../../lib/config";
import { applyTheme } from "../../lib/theme";

async function send(message: object): Promise<unknown> {
  return readExtensionReply(await browser.runtime.sendMessage(message));
}

export function App() {
  const workspaceLabel = useId();
  const fileLabel = useId();
  const [account, setAccount] = useState<ExtensionAccount>();
  const [selection, setSelection] = useState({ userId: "", organizationId: "", fileId: "" });
  const { organizationId, fileId } = selection;
  const [job, setJob] = useState<ImportJob>();
  const [, setError] = useErrorNotice();
  const [signInRequired, setSignInRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let live = true;
    let refreshing = false;
    let jobChanged = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      const notifyError = setError("");
      try {
        const data = parseExtensionResponse(
          extensionAccountSchema,
          await send({ type: "bella:account" }),
        );
        const stored = await browser.storage.local.get("destination");
        if (!live) return;
        setAccount(data);

        const last = destinationSchema.safeParse(stored.destination).data;
        setSelection((current) => {
          const preferred =
            current.userId === data.user.id
              ? current
              : last?.userId === data.user.id
                ? last
                : undefined;
          const organization =
            data.organizations.find((item) => item.id === preferred?.organizationId) ??
            data.organizations[0];
          return {
            userId: data.user.id,
            organizationId: organization?.id ?? "",
            fileId: organization?.files.some((file) => file.id === preferred?.fileId)
              ? preferred!.fileId!
              : "",
          };
        });
      } catch (error) {
        if (live) {
          const signedOut = error instanceof ExtensionReplyError && error.status === 401;
          setSignInRequired(signedOut);
          // Keep usable content visible during transient platform outages.
          if (
            signedOut ||
            (error instanceof ExtensionReplyError && [403, 409].includes(error.status ?? 0))
          )
            setAccount(undefined);
          notifyError(error, "Could not connect to Tidy.");
        }
      } finally {
        refreshing = false;
        if (live) setLoading(false);
      }
    };
    void refresh();
    void browser.storage.session
      .get("job")
      .then((value) => {
        if (live && !jobChanged) setJob(readImportJob(value.job));
      })
      .catch(() => undefined);
    const changed = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "local" && changes.theme) applyTheme(changes.theme.newValue);
      if (area === "session" && changes.job) {
        jobChanged = true;
        setJob(readImportJob(changes.job.newValue));
      }
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
  const busy =
    checking || starting || activeJob?.state === "importing" || activeJob?.state === "selecting";
  const status =
    starting || activeJob?.state === "importing"
      ? "Importing into Tidy…"
      : activeJob?.state === "selecting"
        ? "Select elements on the page, then choose Copy elements."
        : activeJob?.state === "done"
          ? "Import complete. Open imported design is available."
          : "";
  const copy = async (mode: "page" | "element") => {
    const notifyError = setError("");
    if (!account) return;

    setStarting(true);
    const destination = { organizationId, fileId: fileId || undefined, userId: account.user.id };
    try {
      await browser.storage.local.set({ destination });
      await send({ type: "bella:start", mode, destination });
      if (mode === "element") window.close();
    } catch (error) {
      notifyError(error, "Could not copy page.");
    } finally {
      setStarting(false);
    }
  };
  return (
    <main>
      <header>
        <TidyLogo className="brand-name" />
        {account && (
          <span
            className="profile"
            role="img"
            aria-label={account.user.name}
            title={account.user.name}
          >
            <Avatar
              image={account.user.image ? new URL(account.user.image, TIDY_URL).href : null}
              name={account.user.name}
              className="profile-avatar"
            />
          </span>
        )}
      </header>
      {loading ? (
        <p role="status">Connecting to Tidy…</p>
      ) : !account ? (
        <>
          <p>{signInRequired ? "Sign in to import designs." : "Could not connect to Tidy."}</p>
          <Button
            className="primary"
            onClick={() => {
              if (!signInRequired) {
                setLoading(true);
                window.dispatchEvent(new Event("focus"));
                return;
              }
              void send({ type: "bella:login" })
                .then(() => window.close())
                .catch((error) =>
                  setError(error, "Could not complete the action. Please try again."),
                );
            }}
          >
            {signInRequired ? "Sign in to Tidy" : "Reconnect to Tidy"}
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
                      setSelection((current) => ({
                        ...current,
                        organizationId: value,
                        fileId: "",
                      }));
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
                  onChange={(fileId) => setSelection((current) => ({ ...current, fileId }))}
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
                  Select elements
                </Button>
              </div>
            </>
          )}
          <p role="status" aria-atomic="true">
            {status}
          </p>
          {activeJob?.state === "selecting" && (
            <div className="status">
              <Button
                className="secondary"
                onClick={() =>
                  void send({ type: "bella:cancel" }).catch((error) =>
                    setError(error, "Could not complete the action. Please try again."),
                  )
                }
              >
                Cancel selection
              </Button>
            </div>
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
          {activeJob?.state === "error" && (
            <>
              <p role="alert">{activeJob.error}</p>
              {activeJob.recovery && (
                <Button
                  disabled={checking}
                  onClick={() => {
                    setChecking(true);
                    void send({ type: "bella:recover" })
                      .catch((error) => setError(error, "Could not check the import."))
                      .finally(() => setChecking(false));
                  }}
                >
                  {checking ? "Checking import…" : "Check import status"}
                </Button>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
