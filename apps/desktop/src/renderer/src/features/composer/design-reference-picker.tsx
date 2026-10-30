import { useLayoutEffect, useRef, useState } from "react";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { DesignSummary } from "../../../../shared/contracts/desktop";
import {
  codeMenuClassName,
  codeContextTriggerClassName,
  codeScrollbarClassName,
} from "../../styles/code-ui";
import { ComposerChevron, ComposerIcon } from "./composer-icon";
import {
  cloudReferenceKey,
  type CloudDesignReference,
  type DraftCloudReference,
} from "./cloud-reference";
import type { CloudReferenceLibrary } from "./cloud-reference-catalogs";
import "./design-reference-picker.css";

export type CloudReferencePicker = {
  library: CloudReferenceLibrary;
  selected: DraftCloudReference[];
  onToggle(reference: CloudDesignReference): void;
  onRetry(token: string): void;
  canImport: boolean;
  unavailableReason?: string;
};
type FileRow = { value: string; name: string; path: string; checked: boolean } & (
  | { kind: "project"; id: string }
  | { kind: "cloud"; reference: CloudDesignReference; selection?: DraftCloudReference }
);

export function DesignReferencePicker({
  designs,
  selected,
  onChange,
  disabled,
  cloud,
}: {
  designs: Pick<DesignSummary, "id" | "name">[];
  selected: string[];
  onChange(ids: string[]): void;
  disabled: boolean;
  cloud?: CloudReferencePicker;
}) {
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const workspaces = cloud?.library.workspaces ?? [];
  const cloudSelected = cloud?.selected ?? [];
  const selectedByKey = new Map(
    cloudSelected.map((reference) => [cloudReferenceKey(reference), reference]),
  );
  const imported = new Set(
    cloudSelected.flatMap((reference) => (reference.kind === "ready" ? [reference.designId] : [])),
  );
  const localDesigns = designs.filter((design) => !imported.has(design.id));
  const count = new Set(selected.filter((id) => !imported.has(id))).size + cloudSelected.length;
  const limit = count >= 20;
  const rows: FileRow[] = localDesigns.map((design) => ({
    kind: "project",
    id: design.id,
    value: `project:${design.id}`,
    name: design.name,
    path: "This project",
    checked: selected.includes(design.id),
  }));
  for (const workspace of workspaces) {
    if (workspace.catalog.kind !== "ready") continue;
    const folders = new Map(
      workspace.catalog.catalog.folders.map((folder) => [folder.id, folder.name]),
    );
    for (const file of workspace.catalog.catalog.files) {
      const reference = {
        accountId: cloud?.library.accountId ?? "",
        organizationId: workspace.id,
        fileId: file.id,
        name: file.name,
      };
      const key = cloudReferenceKey(reference);
      const selection = selectedByKey.get(key);
      rows.push({
        kind: "cloud",
        value: key,
        reference,
        selection,
        name: file.name,
        path: [workspace.name, file.folderId ? folders.get(file.folderId) : undefined]
          .filter(Boolean)
          .join(" / "),
        checked: Boolean(selection),
      });
    }
  }
  const known = new Set(rows.map((row) => row.value));
  for (const reference of cloudSelected) {
    const key = cloudReferenceKey(reference);
    if (known.has(key)) continue;
    rows.push({
      kind: "cloud",
      value: key,
      reference,
      selection: reference,
      checked: true,
      name: reference.name,
      path:
        workspaces.find((workspace) => workspace.id === reference.organizationId)?.name ??
        "Cloud workspace",
    });
  }
  const search = query.trim().toLocaleLowerCase();
  const options = rows.filter((row) =>
    `${row.name} ${row.path}`.toLocaleLowerCase().includes(search),
  );
  const optionsByValue = new Map(options.map((row) => [row.value, row]));
  useLayoutEffect(() => {
    if (document.activeElement === document.body)
      searchInput.current?.focus({ preventScroll: true });
  }, [count, options.length]);
  const failedWorkspace = workspaces.find(
    ({ catalog }) => catalog.kind === "error" || (catalog.kind === "ready" && catalog.error),
  );
  const loading = workspaces.some(({ catalog }) => catalog.kind === "loading");
  const notice = limit
    ? "20 reference limit reached"
    : (cloud?.unavailableReason ??
      (failedWorkspace && options.length ? "Some cloud designs are unavailable" : undefined));
  return (
    <SelectMenu
      label="Design references"
      actionMenu
      closeOnSelect={false}
      placement="top"
      align="start"
      value=""
      disabled={disabled || (!designs.length && !workspaces.length && !cloudSelected.length)}
      triggerClassName={`${codeContextTriggerClassName} reference-trigger`}
      triggerContent={
        <>
          <ComposerIcon name="reference" />
          <span>Design references{count ? ` · ${count}` : ""}</span>
          <ComposerChevron />
        </>
      }
      menuClassName={`${codeMenuClassName} reference-file-picker`}
      maxMenuHeight={360}
      onOpenChange={(open) => {
        if (!open) setQuery("");
        else cloud?.library.refresh();
      }}
      menuHeader={
        <>
          <div className="reference-search">
            <ComposerIcon name="search" />
            <input
              data-select-search
              ref={searchInput}
              data-ph-private
              aria-label="Search design references"
              placeholder="Search designs…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {notice && (
            <div className="reference-notice" role="status">
              {notice}
              {failedWorkspace && !limit && !cloud?.unavailableReason && (
                <button
                  type="button"
                  onClick={() => {
                    cloud?.library.retry(failedWorkspace.id);
                  }}
                >
                  Retry
                </button>
              )}
            </div>
          )}
        </>
      }
      optionsClassName={codeScrollbarClassName}
      options={options.map((row) => ({
        value: row.value,
        label: row.name,
        checked: row.checked,
        ariaLabel: row.checked ? `Remove ${row.name}` : row.name,
        title:
          row.kind === "cloud" && row.selection?.kind === "error"
            ? row.selection.message
            : `${row.name} — ${row.path}`,
        description: [
          row.path,
          row.kind === "cloud" && row.selection?.kind === "pending"
            ? "Preparing…"
            : row.kind === "cloud" && row.selection?.kind === "error"
              ? "Failed"
              : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        disabled: !row.checked && (limit || (row.kind === "cloud" && !cloud?.canImport)),
      }))}
      optionAction={(option) => {
        const row = optionsByValue.get(option.value);
        if (row?.kind !== "cloud" || row.selection?.kind !== "error") return null;
        const reference = row.selection;
        return (
          <button
            type="button"
            className="reference-retry"
            aria-label={`Retry ${row.name}`}
            disabled={!cloud?.canImport || cloud.library.accountId !== reference.accountId}
            onClick={() => cloud?.onRetry(reference.token)}
          >
            Retry
          </button>
        );
      }}
      emptyContent={
        <div className="reference-empty" role="status">
          {loading ? (
            "Loading designs…"
          ) : failedWorkspace ? (
            <>
              Could not load cloud designs
              <button
                type="button"
                onClick={() => {
                  cloud?.library.retry(failedWorkspace.id);
                }}
              >
                Try again
              </button>
            </>
          ) : search ? (
            "No matching designs"
          ) : (
            "No designs here"
          )}
        </div>
      }
      onChange={(value) => {
        const row = optionsByValue.get(value);
        if (!row) return;
        if (row.kind === "project")
          onChange(row.checked ? selected.filter((id) => id !== row.id) : [...selected, row.id]);
        else cloud?.onToggle(row.reference);
      }}
    />
  );
}
