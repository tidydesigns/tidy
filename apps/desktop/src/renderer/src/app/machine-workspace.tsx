import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { DesktopAPI, LocalDesign } from "../../../shared/contracts/desktop";
import type { ProjectSetupResult } from "../../../shared/contracts/workspace-response";
import type { WorkspaceMachine } from "../../../shared/remote";
import { App } from "./app";
import { NavigationScope, useSessionState } from "./session-state";
import { readNavigation, writeNavigation } from "./navigation-storage";
import { machineIdSchema } from "../../../shared/remote";
import { chooseBrowserProject } from "../platform/browser-project-picker";
import { ProjectSetupDialog } from "../features/composer/project-setup-dialog";
import { useCloud } from "../features/cloud/use-cloud";
import { useDesktopDiagnostics } from "../features/settings/use-diagnostics";
import type {
  Draft,
  MachineSelection,
  PreparedWorkspace,
} from "../features/composer/machine-context";

const local: WorkspaceMachine = { id: "local", label: "This machine", status: null };

export function MachineWorkspace() {
  useDesktopDiagnostics(window.tidy?.analytics);
  const cloud = useCloud(window.tidy?.cloud);
  const bridge = window.tidyMachines;
  const [machines, setMachines] = useState<WorkspaceMachine[]>([local]);
  const [id, setId] = useSessionState("machine", machineIdSchema, "local");
  const [links, setLinks] = useState<Record<string, string>>(() => {
    try {
      return readNavigation({
        storage: localStorage,
        key: "checkout-links",
        schema: z.record(z.string(), z.string().uuid()),
        fallback: {},
      });
    } catch {
      return {};
    }
  });
  const [prepared, setPrepared] = useState<PreparedWorkspace>();
  const [setup, setSetup] = useState<{ id: string; source: MachineSelection | null } | null>(null);
  const drafts = useRef(new Map<string, Record<string, Draft>>());
  const machineLabels = useRef(machines);
  machineLabels.current = machines;
  const apis = useRef(new Map<string, DesktopAPI>());
  const projectSetups = useRef(new Map<string, Promise<ProjectSetupResult>>());
  const pendingList = useRef(0);
  const apiFor = (machineId: string) => {
    if (machineId === "local") return window.tidy;
    const cached = apis.current.get(machineId);
    if (cached) return cached;
    if (!bridge) return undefined;
    const workspace = bridge.workspace(machineId);
    const portable = (projectId: string, design: LocalDesign) =>
      workspace.api.exportDesign
        ? workspace.api.exportDesign(projectId, design.id)
        : Promise.resolve(design);
    const api: DesktopAPI = {
      ...workspace.api,
      cloud: undefined,
      readDesign: (projectId, designId) =>
        workspace.api.exportDesign
          ? workspace.api.exportDesign(projectId, designId)
          : workspace.api.readDesign(projectId, designId),
      previewDesign: (projectId, designId) =>
        workspace.api.exportDesign
          ? workspace.api.exportDesign(projectId, designId)
          : workspace.api.previewDesign(projectId, designId),
      refreshDesign: async (projectId, designId, version) => {
        const design = await workspace.api.refreshDesign(projectId, designId, version);
        return design ? portable(projectId, design) : null;
      },
      createDesign: async (projectId, folderId) =>
        portable(projectId, await workspace.api.createDesign(projectId, folderId)),
      updateDesign: async (input) =>
        portable(input.projectId, await workspace.api.updateDesign(input)),
      importDesign: async (projectId, folderId) => {
        const design = await workspace.api.importDesign(projectId, folderId);
        return design ? portable(projectId, design) : null;
      },
      uploadDesignAsset: async (projectId, dataUrl) => ({
        ...(await workspace.api.uploadDesignAsset(projectId, dataUrl)),
        url: dataUrl,
      }),
      openProject: () =>
        chooseBrowserProject(workspace.remote.openProject, {
          directories: workspace.remote.directories,
          machine:
            machineLabels.current.find((machine) => machine.id === machineId)?.label ??
            "Remote machine",
        }),
    };
    apis.current.set(machineId, api);
    return api;
  };
  useEffect(() => {
    if (!bridge) return;
    let mounted = true;
    const refresh = () => {
      const version = ++pendingList.current;
      void bridge
        .list()
        .then((items) => {
          if (mounted && version === pendingList.current && items) setMachines(items);
        })
        .catch(() => {});
    };
    refresh();
    const unsubscribe = bridge.onChanged(refresh);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [bridge]);
  const current = machines.find((machine) => machine.id === id) ?? {
    id,
    label: "Machine unavailable",
    status: { kind: "closed", target: "" } as const,
  };
  const api = useMemo(() => apiFor(id), [id]);
  const destination = setup
    ? (machines.find((machine) => machine.id === setup.id) ?? {
        id: setup.id,
        label: "Machine unavailable",
        status: { kind: "closed", target: "" } as const,
      })
    : undefined;
  const target = setup ? apiFor(setup.id) : undefined;
  const setupKey = setup ? `${setup.id}:${setup.source?.project.id ?? ""}` : "";
  const connected = id === "local" || current.status?.kind === "connected";
  return (
    <>
      <NavigationScope key={id} value={id === "local" ? "" : id}>
        <App
          workspaceAPI={api}
          initial={prepared}
          draftCache={drafts.current}
          cloud={cloud}
          machine={{
            current,
            machines,
            connected,
            switching: Boolean(setup),
            select: (next, source) => {
              if (next !== id) setSetup({ id: next, source });
            },
            navigate: (next) => {
              if (next !== id) setSetup({ id: next, source: null });
            },
          }}
        />
      </NavigationScope>
      {setup && destination && target && api && (
        <ProjectSetupDialog
          key={setup.id}
          machine={destination}
          api={target}
          preferredProjectId={
            setup.source ? links[`${id}:${setup.source.project.id}:${setup.id}`] : undefined
          }
          destinationDrafts={drafts.current.get(setup.id)}
          source={setup.source}
          sourceAPI={api}
          pendingSetup={projectSetups.current.get(setupKey)}
          onSetup={(work) => {
            projectSetups.current.set(setupKey, work);
            void work
              .finally(() => {
                if (projectSetups.current.get(setupKey) === work)
                  projectSetups.current.delete(setupKey);
              })
              .catch(() => {});
          }}
          onClose={() => setSetup(null)}
          onReady={(value) => {
            const project = value.bootstrap.activeProject?.project;
            if (setup.source && project && value.relation === "matching") {
              const next = {
                ...links,
                [`${id}:${setup.source.project.id}:${setup.id}`]: project.id,
                [`${setup.id}:${project.id}:${id}`]: setup.source.project.id,
              };
              setLinks(next);
              try {
                writeNavigation({ storage: localStorage, key: "checkout-links", value: next });
              } catch {}
            }
            setPrepared(value);
            setId(setup.id);
            setSetup(null);
          }}
        />
      )}
    </>
  );
}
