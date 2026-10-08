"use client";
import { Dialog } from "@/components/ui/dialog";
import { useId, useRef, useState } from "react";
import { ImmediateField } from "@/components/ui/immediate-field";
import { editVaultLogin } from "./actions";

export function EditLogin({
  login,
  onRename,
}: {
  login: { id: string; name: string };
  onRename: (id: string, name: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [pendingCount, setPendingCount] = useState(0);
  const [notice, setNotice] = useState("");
  async function update(field: "name" | "username" | "password", draft: string) {
    setPendingCount((count) => count + 1);
    setNotice("");
    try {
      const result = await editVaultLogin(login.id, field, draft);
      if (result.error || !result.login)
        throw new Error(result.error ?? "Could not update this login.");
      if (field === "name") onRename(login.id, result.login.name);
      setNotice(
        field === "name"
          ? "Name updated."
          : field === "username"
            ? "Username updated."
            : "Password updated.",
      );
      return field === "name" ? result.login.name : "";
    } finally {
      setPendingCount((count) => count - 1);
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNotice("");
          dialog.current?.showModal();
        }}
        className="text-sm underline decoration-primary-orange underline-offset-4"
      >
        Edit
      </button>
      <Dialog
        ref={dialog}
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (pendingCount) event.preventDefault();
        }}
        size="lg"
        className="space-y-6"
      >
        <h2 id={titleId} className="text-xl font-semibold">
          Edit login
        </h2>
        <ImmediateField
          label="Name"
          value={login.name}
          maxLength={100}
          disabled={Boolean(pendingCount)}
          onCommit={(draft) => update("name", draft)}
        />
        <ImmediateField
          label="New username or email"
          value=""
          placeholder="Leave blank to keep existing"
          autoComplete="off"
          maxLength={320}
          disabled={Boolean(pendingCount)}
          onCommit={(draft) => update("username", draft)}
        />
        <ImmediateField
          label="New password"
          value=""
          type="password"
          placeholder="Leave blank to keep existing"
          autoComplete="new-password"
          maxLength={4096}
          disabled={Boolean(pendingCount)}
          onCommit={(draft) => update("password", draft)}
        />
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        <button
          type="button"
          disabled={Boolean(pendingCount)}
          onClick={() => dialog.current?.close()}
          className="rounded-lg border border-primary-grey px-4 py-2 text-sm disabled:opacity-50"
        >
          Close
        </button>
      </Dialog>
    </>
  );
}
