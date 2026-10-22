import { useEffect, useRef, useState } from "react";
import { errorMessage } from "@tidy/ui/errors";
import type { CloudAPI, CloudAccount, CloudState } from "../../shared/cloud-sync";

export function useCloud(api?: CloudAPI) {
  const [state, setState] = useState<CloudState>();
  const [account, setAccount] = useState<CloudAccount>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const loginAttempt = useRef(0);
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
    setError("");
    if (!api || !state?.signedIn) return;
    const apply = (value: CloudAccount) => {
      if (epoch.current === version) setAccount(value);
    };
    // Private, account-scoped metadata paints first; the network refresh stays in the background.
    void api
      .account(true)
      .then(apply)
      .catch(() => {})
      .then(async () => {
        try {
          apply(await api.account());
        } catch (cause) {
          if (epoch.current === version)
            setError(
              errorMessage(
                cause,
                "Could not refresh your workspaces. Cached files are still available.",
              ),
            );
        }
      });
    return () => {
      epoch.current++;
    };
  }, [api, state?.signedIn, state?.accountId]);
  async function signIn() {
    if (!api || busy) return;
    const attempt = ++loginAttempt.current;
    setBusy(true);
    setError("");
    try {
      await api.signIn();
    } catch (cause) {
      if (attempt === loginAttempt.current)
        setError(errorMessage(cause, "Could not sign in. Try again."));
    } finally {
      if (attempt === loginAttempt.current) setBusy(false);
    }
  }
  async function signOut() {
    if (!api) return;
    loginAttempt.current++;
    setBusy(false);
    setError("");
    try {
      await api.signOut();
    } catch (cause) {
      setError(errorMessage(cause, "Could not sign out. Try again."));
    }
  }
  return { state, account, busy, error, signIn, signOut };
}
export type CloudConnection = ReturnType<typeof useCloud>;
