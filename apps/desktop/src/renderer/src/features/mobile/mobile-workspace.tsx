import { useState } from "react";
import { z } from "zod";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import type { MobileAPI, MobileCommand } from "../../../../shared/contracts/mobile";
import { useSessionState } from "../../app/session-state";
import { useMobile } from "./use-mobile";
import { DeviceScreen } from "./device-screen";
import "./mobile-workspace.css";
import { DeviceGlyph } from "./device-glyph";

function Glyph({
  name,
}: {
  name: "play" | "stop" | "reload" | "home" | "back" | "rotate" | "disconnect";
}) {
  const paths = {
    play: <path d="m9 5 10 7-10 7Z" fill="currentColor" stroke="none" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
    reload: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" />
      </>
    ),
    home: (
      <>
        <path d="m3 10 9-7 9 7M6 9v11h12V9" />
        <path d="M10 20v-6h4v6" />
      </>
    ),
    back: <path d="m14 5-7 7 7 7" />,
    rotate: (
      <>
        <path d="M20 9a8 8 0 0 0-14-4L3 8m0-5v5h5" />
        <rect x="9" y="8" width="9" height="14" rx="2" transform="rotate(-30 13.5 15)" />
      </>
    ),
    disconnect: (
      <>
        <path d="m9 3-6 6m6-3 9 9-3 3-9-9M15 21l6-6M3 21l4-4m10-10 4-4" />
      </>
    ),
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const frameworkNames = {
  expo: "Expo",
  "react-native": "React Native",
  flutter: "Flutter",
  xcode: "Xcode",
  gradle: "Android",
};

export function MobileWorkspace({
  api,
  projectId,
  active,
  connected,
  onOpenLink,
}: {
  api: MobileAPI;
  projectId: string;
  active: boolean;
  connected: boolean;
  onOpenLink(url: string): void;
}) {
  const { state, error, busy, command, refresh } = useMobile(api, projectId, active && connected);
  const [rememberedDevice, setRememberedDevice] = useSessionState(
    `mobile-device:${projectId}`,
    z.string(),
    "",
  );
  const [targetId, setTargetId] = useSessionState(`mobile-target:${projectId}`, z.string(), "");
  const [displayError, setDisplayError] = useState<string>();
  const session = state?.session;
  const selectedId = session?.deviceId ?? rememberedDevice;
  const selected = state?.devices.find((device) => device.id === selectedId) ?? state?.devices[0];
  const targets =
    state?.targets.filter((target) => target.platforms.includes(selected?.platform ?? "ios")) ?? [];
  const target = targets.find((target) => target.id === targetId) ?? targets[0];
  const ready = session?.phase === "ready" && connected;
  const building = session?.run?.phase === "building";
  const running = session?.run?.phase === "running";
  const issue = error ?? displayError ?? (session?.phase === "error" ? session.message : undefined);
  const act = (input: MobileCommand) => {
    setDisplayError(undefined);
    void command(input);
  };
  const control = (kind: "home" | "back" | "rotate" | "reload" | "disconnect" | "stop") => {
    if (session) act({ kind, projectId, sessionId: session.id });
  };
  const connect = () => {
    if (selected) {
      setRememberedDevice(selected.id);
      act({ kind: "connect", projectId, deviceId: selected.id });
    }
  };
  return (
    <section className="mobile-workspace" aria-label="Mobile devices">
      <div className="mobile-device-bar">
        <SelectMenu
          label="Device"
          value={selected?.id ?? ""}
          triggerContent={
            <>
              <DeviceGlyph />
              <span>{selected?.name ?? "Choose a device"}</span>
            </>
          }
          triggerClassName="mobile-device-picker"
          options={(state?.devices ?? []).map((device) => ({
            value: device.id,
            label: device.name,
            description: `${device.runtime}${device.state === "running" ? " · Running" : ""}`,
            icon: <DeviceGlyph />,
            disabled: !state?.requirements.find(
              (requirement) => requirement.platform === device.platform,
            )?.ready,
          }))}
          disabled={busy || !connected}
          onChange={(value) => {
            setRememberedDevice(value);
            setDisplayError(undefined);
            if (session) act({ kind: "connect", projectId, deviceId: value });
          }}
        />
        <Button
          className="mobile-icon-button"
          aria-label="Refresh devices"
          title="Refresh devices"
          disabled={busy || !connected}
          onClick={() => {
            setDisplayError(undefined);
            void refresh(true);
          }}
        >
          <Glyph name="reload" />
        </Button>
      </div>
      {ready && (
        <div className="mobile-run-bar">
          {target ? (
            <SelectMenu
              label="App target"
              size="sm"
              value={target.id}
              disabled={building || busy}
              triggerClassName="mobile-target-picker"
              options={targets.map((target) => ({
                value: target.id,
                label: target.name,
                description: `${frameworkNames[target.kind]}${target.directory !== "." ? ` · ${target.directory}` : ""}`,
              }))}
              onChange={setTargetId}
            />
          ) : (
            <span className="mobile-no-target">No mobile app in this project</span>
          )}
          <Button
            className="mobile-run-button"
            disabled={busy || (!building && !running && !target)}
            aria-label={building || running ? "Stop app run" : "Run app"}
            onClick={() => {
              if (building || running) control("stop");
              else if (target && session)
                act({ kind: "run", projectId, sessionId: session.id, targetId: target.id });
            }}
          >
            <Glyph name={building || running ? "stop" : "play"} />
            {building || running ? "Stop" : "Run"}
          </Button>
        </div>
      )}
      {issue && (
        <div className="mobile-issue" role="alert">
          <span>{issue}</span>
          <Button className="quiet-button" disabled={busy || !connected} onClick={connect}>
            Reconnect
          </Button>
        </div>
      )}
      {!connected ? (
        <div className="mobile-empty" role="status">
          <DeviceGlyph size={28} />
          <p>Reconnect this machine to use its devices.</p>
        </div>
      ) : ready && session && !issue ? (
        <DeviceScreen
          key={session.id}
          api={api}
          projectId={projectId}
          sessionId={session.id}
          name={selected?.name ?? "Device"}
          active={active && connected}
          onError={setDisplayError}
        />
      ) : (
        <div className="mobile-empty">
          <DeviceGlyph size={32} />
          {session?.phase === "starting" ? (
            <>
              <p role="status">{session.message}</p>
              <Button
                className="quiet-button"
                disabled={busy}
                onClick={() => control("disconnect")}
              >
                Cancel connection
              </Button>
            </>
          ) : selected ? (
            <>
              <p>
                {selected.runtime} · {selected.state === "running" ? "Running" : "Ready to start"}
              </p>
              {!issue && (
                <Button
                  className="mobile-connect-button"
                  disabled={
                    busy ||
                    !state?.requirements.find(
                      (requirement) => requirement.platform === selected.platform,
                    )?.ready
                  }
                  onClick={connect}
                >
                  {selected.state === "running" ? "Connect device" : "Start device"}
                </Button>
              )}
              {session?.phase === "error" && (
                <Button
                  className="quiet-button"
                  disabled={busy}
                  onClick={() => control("disconnect")}
                >
                  Disconnect preview
                </Button>
              )}
            </>
          ) : (
            <p role="status">
              {state ? "Set up a simulator to preview your app here." : "Finding devices…"}
            </p>
          )}
        </div>
      )}
      {ready && (
        <div className="mobile-controls" aria-label="Device controls">
          {selected?.platform === "android" && (
            <Button
              className="mobile-icon-button"
              aria-label="Android back"
              title="Back"
              onClick={() => control("back")}
              disabled={busy}
            >
              <Glyph name="back" />
            </Button>
          )}
          <Button
            className="mobile-icon-button"
            aria-label="Device home"
            title="Home"
            onClick={() => control("home")}
            disabled={busy}
          >
            <Glyph name="home" />
          </Button>
          <Button
            className="mobile-icon-button"
            aria-label="Rotate device"
            title="Rotate"
            onClick={() => control("rotate")}
            disabled={busy}
          >
            <Glyph name="rotate" />
          </Button>
          <Button
            className="mobile-icon-button"
            aria-label="Reload app"
            title={target?.kind === "flutter" ? "Hot reload" : "Reload app"}
            onClick={() => control("reload")}
            disabled={busy || !running}
          >
            <Glyph name="reload" />
          </Button>
          <span className="mobile-control-spacer" />
          <Button
            className="mobile-icon-button"
            aria-label="Disconnect device"
            title="Disconnect preview"
            onClick={() => control("disconnect")}
            disabled={busy}
          >
            <Glyph name="disconnect" />
          </Button>
        </div>
      )}
      {session?.run && (
        <details className="mobile-build-output" open={session.run.phase === "failed" || undefined}>
          <summary>
            <span className="mobile-status-dot" data-phase={session.run.phase} />
            <span>{session.run.message}</span>
            <span className="mobile-output-label">Output</span>
          </summary>
          {session.run.output && (
            <pre tabIndex={0} aria-label="App build output">
              {session.run.output}
            </pre>
          )}
        </details>
      )}
      {state?.requirements.some((requirement) => !requirement.ready) && (
        <details className="mobile-setup">
          <summary>Device setup</summary>
          {state.requirements
            .filter((requirement) => !requirement.ready)
            .map((requirement) => (
              <div key={requirement.platform}>
                <p>{requirement.message}</p>
                <Button className="quiet-button" onClick={() => onOpenLink(requirement.helpURL)}>
                  {requirement.platform === "ios" ? "iOS setup" : "Android setup"} ↗
                </Button>
              </div>
            ))}
        </details>
      )}
    </section>
  );
}
