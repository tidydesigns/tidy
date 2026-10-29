import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { randomUUID } from "expo-crypto";
import { useFonts } from "expo-font";
import { InstrumentSans_400Regular } from "@expo-google-fonts/instrument-sans/400Regular";
import { InstrumentSans_600SemiBold } from "@expo-google-fonts/instrument-sans/600SemiBold";
import { nativeColors } from "@tidy/design/native-theme";
import { mobilePairingSchema, type MobilePairing } from "@tidy/agent-protocol/mobile";
import type {
  Bootstrap,
  HarnessId,
  Message,
  Project,
  Thread,
  ThreadSummary,
} from "@tidy/agent-protocol/contracts/desktop";
import type {
  HarnessDetails,
  HarnessSettings,
} from "@tidy/agent-protocol/contracts/harness-settings";
import { permissionModes, type ApprovalDecision } from "@tidy/agent-protocol/contracts/permissions";
import type { Directory } from "@tidy/agent-protocol/contracts/browser-directory";
import { readPairing, writePairing } from "./credentials";
import { RemoteConnection, type ConnectionState } from "./connection";
import { ThreadCache } from "./thread-cache";
import { Button, SelectMenu, Sheet, Text, ThemeContext, styles, useTheme } from "./ui";

type Send = {
  id: string;
  threadId: string;
  projectId: string;
  messageId: string;
  text: string;
  harness: HarnessId;
  settings: HarnessSettings;
  fresh: boolean;
  state: "sending" | "failed";
  error?: string;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";
const names: Record<HarnessId, string> = { codex: "Codex", claude: "Claude", opencode: "OpenCode" };

export default function App() {
  const dark = useColorScheme() === "dark";
  const [fonts] = useFonts({ InstrumentSans_400Regular, InstrumentSans_600SemiBold });
  return (
    <SafeAreaProvider>
      <ThemeContext.Provider
        value={{
          colors: dark ? nativeColors.dark : nativeColors.light,
          font: fonts ? "InstrumentSans_400Regular" : undefined,
          medium: fonts ? "InstrumentSans_600SemiBold" : undefined,
        }}
      >
        <StatusBar style={dark ? "light" : "dark"} />
        <Workspace />
      </ThemeContext.Provider>
    </SafeAreaProvider>
  );
}

function Workspace() {
  const { colors, font } = useTheme();
  const [pairing, setPairing] = useState<MobilePairing | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>("paused");
  const [connectionMessage, setConnectionMessage] = useState<string>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [harnesses, setHarnesses] = useState<Bootstrap["harnesses"]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [route, setRoute] = useState<string | null>(null); // null = list; "new" = composer
  const [panel, setPanel] = useState<"projects" | "connection" | "settings" | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sends, setSends] = useState<Record<string, Send>>({});
  const [harness, setHarness] = useState<HarnessId>("codex");
  const [settings, setSettings] = useState<HarnessSettings>({ permissionMode: "default" });
  const [settingOverrides, setSettingOverrides] = useState<Record<string, HarnessSettings>>({});
  const [details, setDetails] = useState<HarnessDetails>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [loadingThread, setLoadingThread] = useState(false);
  const [, render] = useState(0);
  const cache = useRef(new ThreadCache());
  const client = useRef<RemoteConnection | null>(null);
  const selection = useRef({ projectId, route });
  selection.current = { projectId, route };
  const sendsRef = useRef(sends);
  sendsRef.current = sends;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const publish = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      if (mounted.current) render((value) => value + 1);
    }, 40);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(refreshTimer.current);
    };
  }, []);
  useEffect(() => {
    let active = true;
    void readPairing()
      .then((value) => {
        if (active) setPairing(value);
      })
      .catch(() => {
        if (active) setNotice("Could not restore your connection. Paste a new pairing code.");
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!pairing) return;
    let disposed = false;
    const remote = new RemoteConnection(
      pairing,
      {
        state: (state, message) => {
          if (!disposed) {
            setConnection(state);
            setConnectionMessage(message);
          }
        },
        event: (event) => {
          if (!disposed) {
            cache.current.event(event);
            publish();
          }
        },
        ready: () => {
          void remote
            .request("bootstrap")
            .then(async (bootstrap) => {
              if (disposed) return;
              setProjects(bootstrap.projects);
              setHarnesses(bootstrap.harnesses);
              setHarness(
                (current) =>
                  bootstrap.harnesses.find((item) => item.id === current && item.status === "ready")
                    ?.id ??
                  bootstrap.harnesses.find((item) => item.status === "ready")?.id ??
                  current,
              );
              if (bootstrap.activeProject) cache.current.putProject(bootstrap.activeProject);
              const selected = selection.current.projectId;
              if (!selected && bootstrap.activeProject)
                setProjectId(bootstrap.activeProject.project.id);
              else if (selected) {
                const snapshot = await remote.request("select-project", selected);
                if (disposed) return;
                cache.current.putProject(snapshot);
              }
              publish();
              const current = selection.current;
              if (current.projectId && current.route && current.route !== "new") {
                const thread = await remote.request("read-thread", {
                  projectId: current.projectId,
                  threadId: current.route,
                });
                if (!disposed) {
                  cache.current.putThread(thread);
                  publish();
                }
              }
            })
            .catch((error) => {
              if (!disposed) setNotice(errorText(error));
            });
        },
      },
      { uuid: randomUUID, fetch, socket: (url) => new WebSocket(url) },
    );
    client.current = remote;
    if (AppState.currentState !== "background") remote.start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") remote.start();
      else remote.pause();
    });
    return () => {
      disposed = true;
      subscription.remove();
      remote.close();
      if (client.current === remote) client.current = null;
    };
  }, [pairing, publish]);

  const snapshot = projectId ? cache.current.projects.get(projectId) : undefined;
  const thread = route ? cache.current.threads.get(route) : undefined;
  const send = route ? sends[route] : undefined;
  const effectiveHarness = thread?.harness ?? send?.harness ?? harness;
  const effectiveSettings =
    (thread && settingOverrides[thread.id]) ?? thread?.settings ?? send?.settings ?? settings;
  const draftKey = `${projectId}:${route ?? "new"}`;
  const draft = drafts[draftKey] ?? "";
  const connected = connection === "connected";

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (panel) {
        setPanel(null);
        return true;
      }
      if (route) {
        setRoute(null);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [panel, route]);

  useEffect(() => {
    if (!projectId || !connected || panel !== "settings") return;
    let current = true;
    setDetails(undefined);
    void client.current
      ?.request("harness-details", { projectId, harness: effectiveHarness })
      .then((value) => {
        if (current) setDetails(value);
      })
      .catch((error) => {
        if (current) setNotice(errorText(error));
      });
    return () => {
      current = false;
    };
  }, [projectId, effectiveHarness, panel, connected]);

  async function chooseProject(id: string) {
    const remote = client.current;
    if (!remote) return;
    setProjectId(id);
    setRoute(null);
    setPanel(null);
    try {
      const value = await remote.request("select-project", id);
      if (remote !== client.current) return;
      cache.current.putProject(value);
      publish();
    } catch (error) {
      if (remote === client.current) setNotice(errorText(error));
    }
  }
  async function openThread(id: string) {
    const remote = client.current;
    if (!remote || !projectId) return;
    setRoute(id);
    setLoadingThread(!cache.current.threads.has(id));
    try {
      const value = await remote.request("read-thread", { projectId, threadId: id });
      if (remote !== client.current) return;
      cache.current.putThread(value);
      publish();
    } catch (error) {
      if (remote === client.current) setNotice(errorText(error));
    } finally {
      if (remote === client.current && selection.current.route === id) setLoadingThread(false);
    }
  }
  function updateSend(value: Send) {
    sendsRef.current = { ...sendsRef.current, [value.threadId]: value };
    setSends(sendsRef.current);
  }
  async function deliver(value: Send) {
    const remote = client.current;
    if (!remote) return;
    updateSend({ ...value, state: "sending", error: undefined });
    try {
      const common = {
        projectId: value.projectId,
        threadId: value.threadId,
        messageId: value.messageId,
      };
      const result = value.fresh
        ? await remote.request(
            "start-thread",
            {
              ...common,
              prompt: value.text,
              harness: value.harness,
              settings: value.settings,
              designIds: [],
            },
            { id: value.id },
          )
        : await remote.request(
            "send-message",
            { ...common, text: value.text, delivery: "queue" },
            { id: value.id },
          );
      if (remote !== client.current) return;
      cache.current.putThread(result);
      publish();
      const next = { ...sendsRef.current };
      delete next[value.threadId];
      sendsRef.current = next;
      setSends(next);
    } catch (error) {
      if (remote === client.current)
        updateSend({ ...value, state: "failed", error: errorText(error) });
    }
  }
  function submit() {
    if (!projectId || !draft.trim() || !connected || (route && sendsRef.current[route])) return;
    const id = route === "new" ? randomUUID() : route;
    if (!id) return;
    const value: Send = {
      id: randomUUID(),
      projectId,
      threadId: id,
      messageId: randomUUID(),
      text: draft.trim(),
      harness: effectiveHarness,
      settings: effectiveSettings,
      fresh: route === "new",
      state: "sending",
    };
    setDrafts((previous) => ({ ...previous, [draftKey]: "" }));
    setRoute(id);
    setLoadingThread(false);
    void deliver(value);
  }
  async function threadAction(
    key: string,
    action: (remote: RemoteConnection) => Promise<Thread | unknown>,
  ) {
    const remote = client.current;
    if (!remote || busy[key]) return;
    setBusy((value) => ({ ...value, [key]: true }));
    try {
      const result = await action(remote);
      if (remote !== client.current) return;
      if (result && typeof result === "object" && "messages" in result)
        cache.current.putThread(result as Thread);
      publish();
    } catch (error) {
      if (remote === client.current) setNotice(errorText(error));
    } finally {
      if (remote === client.current) setBusy((value) => ({ ...value, [key]: false }));
    }
  }
  function approval(id: string, decision: ApprovalDecision) {
    if (!thread) return;
    void threadAction(id, (remote) =>
      remote.request("respond-approval", {
        projectId: thread.projectId,
        threadId: thread.id,
        approvalId: id,
        decision,
      }),
    );
  }
  function changeSettings(value: HarnessSettings) {
    if (busy.settings || !connected) return;
    if (!thread) {
      setSettings(value);
      return;
    }
    const remote = client.current;
    if (!remote) return;
    const id = thread.id;
    setSettingOverrides((previous) => ({ ...previous, [id]: value }));
    setBusy((previous) => ({ ...previous, settings: true }));
    void remote
      .request("thread-settings", { projectId: thread.projectId, threadId: id, settings: value })
      .then((result) => {
        if (remote === client.current) {
          cache.current.putThread(result);
          publish();
        }
      })
      .catch((error) => {
        if (remote === client.current) setNotice(errorText(error));
      })
      .finally(() => {
        if (remote !== client.current) return;
        setSettingOverrides((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
        setBusy((previous) => ({ ...previous, settings: false }));
      });
  }
  async function disconnect() {
    // Delete the secure credential first so a failed deletion cannot silently reconnect next launch.
    try {
      await writePairing(null);
      client.current?.close();
      client.current = null;
      setPairing(null);
      setProjects([]);
      setProjectId(undefined);
      setRoute(null);
      setPanel(null);
      cache.current = new ThreadCache();
      setDrafts({});
      setSettingOverrides({});
      setBusy({});
      sendsRef.current = {};
      setSends({});
      setNotice(undefined);
    } catch {
      setNotice("Could not remove the stored connection. Try disconnecting again.");
    }
  }

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.surface }]}>
      {!pairing ? (
        <PairScreen
          restoring={restoring}
          connect={async (value) => {
            await writePairing(value);
            setPairing(value);
          }}
          report={setNotice}
        />
      ) : (
        <KeyboardAvoidingView
          style={styles.fill}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <View style={styles.page}>
            <View style={[styles.header, styles.row, { borderColor: colors.border }]}>
              {route ? (
                <Button label="‹ Threads" compact onPress={() => setRoute(null)} />
              ) : (
                <Button
                  label={`${snapshot?.project.name ?? projects.find((item) => item.id === projectId)?.name ?? "Projects"} ⌄`}
                  onPress={() => setPanel("projects")}
                />
              )}
              <View style={{ flex: 1 }} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Connection settings"
                onPress={() => setPanel("connection")}
                style={{ minHeight: 44, minWidth: 44, padding: 12, justifyContent: "center" }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: connected ? colors.success : colors.warning,
                  }}
                />
              </Pressable>
              {!route && (
                <Button
                  label="+ Thread"
                  disabled={!projectId}
                  onPress={() => {
                    setRoute("new");
                    setLoadingThread(false);
                    setSettings({ permissionMode: "default" });
                  }}
                />
              )}
            </View>
            {!connected && (
              <Pressable
                accessibilityRole="button"
                onPress={() => client.current?.start()}
                style={{
                  backgroundColor: colors.navigation,
                  paddingHorizontal: 20,
                  paddingVertical: 9,
                }}
              >
                <Text muted style={{ fontSize: 13 }}>
                  {connectionMessage ??
                    (connection === "paused"
                      ? "Connection paused"
                      : "Connecting to your machine…")}{" "}
                  Tap to retry.
                </Text>
              </Pressable>
            )}
            {!route ? (
              <ThreadList
                threads={snapshot?.threads ?? []}
                pending={Object.values(sends).filter((value) => value.projectId === projectId)}
                open={openThread}
                chooseProject={() => setPanel("projects")}
                hasProject={!!projectId}
                loading={!!projectId && !snapshot}
              />
            ) : (
              <>
                <View style={{ paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 }}>
                  <Text strong style={styles.heading}>
                    {thread?.title ??
                      send?.text.slice(0, 80) ??
                      (route === "new" ? "New thread" : "Thread")}
                  </Text>
                  <View style={styles.row}>
                    <Text muted style={{ fontSize: 13 }}>
                      {snapshot?.project.name} · {names[effectiveHarness]}
                    </Text>
                    <Button label="Options" compact onPress={() => setPanel("settings")} />
                  </View>
                </View>
                <Conversation
                  thread={thread}
                  send={send}
                  loading={loadingThread && !thread}
                  retry={() => send && void deliver(send)}
                  connected={connected}
                  busy={busy}
                  approve={approval}
                  removeQueued={(id) => {
                    if (thread)
                      void threadAction(id, (remote) =>
                        remote.request("message-queue", {
                          projectId: thread.projectId,
                          threadId: thread.id,
                          action: { kind: "remove", messageId: id },
                        }),
                      );
                  }}
                />
                <View
                  style={{
                    padding: 16,
                    gap: 8,
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderColor: colors.border,
                  }}
                >
                  {thread?.error && <Text style={{ color: colors.danger }}>{thread.error}</Text>}
                  {thread?.status === "running" && (
                    <View style={styles.row}>
                      <Text muted style={{ flex: 1, fontSize: 13 }} numberOfLines={2}>
                        {thread.activity ?? "Working…"}
                      </Text>
                      <Button
                        label={busy.stop ? "Stopping…" : "Stop"}
                        disabled={busy.stop || !connected}
                        compact
                        onPress={() =>
                          void threadAction("stop", (remote) =>
                            remote.request("stop-thread", { projectId, threadId: thread.id }),
                          )
                        }
                      />
                    </View>
                  )}
                  <TextInput
                    accessibilityLabel="Message"
                    placeholder={
                      thread?.status === "running"
                        ? "Queue a follow-up…"
                        : "What would you like to work on?"
                    }
                    placeholderTextColor={colors.muted}
                    multiline
                    maxLength={32_000}
                    value={draft}
                    onChangeText={(value) =>
                      setDrafts((previous) => ({ ...previous, [draftKey]: value }))
                    }
                    style={[
                      styles.input,
                      {
                        backgroundColor: colors.panel,
                        color: colors.ink,
                        fontFamily: font,
                        borderColor: colors.border,
                        maxHeight: 160,
                        minHeight: 82,
                        textAlignVertical: "top",
                      },
                    ]}
                  />
                  <View style={styles.row}>
                    <Text muted style={{ fontSize: 12, flex: 1 }}>
                      {thread?.status === "running"
                        ? "Runs continue when you leave."
                        : connection === "connected"
                          ? "Connected through Tailscale"
                          : "Your draft stays here while reconnecting."}
                    </Text>
                    <Button
                      primary
                      label={thread?.status === "running" ? "Queue ↑" : "Send ↑"}
                      disabled={
                        !connected ||
                        !draft.trim() ||
                        !!send ||
                        (!thread && route !== "new") ||
                        (route === "new" &&
                          !harnesses.some((item) => item.id === harness && item.status === "ready"))
                      }
                      onPress={submit}
                    />
                  </View>
                </View>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      )}
      {panel === "connection" && pairing && (
        <Sheet title="Connection" close={() => setPanel(null)}>
          <Text strong>{new URL(pairing.origin).hostname}</Text>
          <Text muted>
            {connection === "connected"
              ? "Connected privately through Tailscale. Agents run on this machine, even when your phone is locked."
              : (connectionMessage ?? "Connecting…")}
          </Text>
          <Button
            label="Reconnect"
            onPress={() => {
              client.current?.start();
              setPanel(null);
            }}
          />
          <Button label="Disconnect this phone" danger onPress={() => void disconnect()} />
          <Text muted style={{ fontSize: 12 }}>
            Disconnect removes the key from this phone. Revoke its client ID on the host to
            invalidate copied keys.
          </Text>
        </Sheet>
      )}
      {panel === "projects" && (
        <ProjectsPanel
          projects={projects}
          remote={client.current}
          close={() => setPanel(null)}
          select={chooseProject}
          opened={(value) => {
            cache.current.putProject(value);
            setProjects((previous) => [
              value.project,
              ...previous.filter((item) => item.id !== value.project.id),
            ]);
            setProjectId(value.project.id);
            setRoute(null);
            setPanel(null);
            publish();
          }}
          report={setNotice}
        />
      )}
      {panel === "settings" && (
        <Sheet title="Thread options" close={() => setPanel(null)}>
          <ScrollView>
            {!thread && !send && (
              <SelectMenu
                label="Agent"
                value={harness}
                options={harnesses.map((item) => ({
                  value: item.id,
                  label: item.name,
                  description:
                    item.status === "ready"
                      ? undefined
                      : item.status === "signed-out"
                        ? "Sign in on your machine"
                        : "Install on your machine",
                  disabled: item.status !== "ready",
                }))}
                onChange={(value) => {
                  setHarness(value);
                  setSettings({ permissionMode: "default" });
                }}
              />
            )}
            <SelectMenu
              label="Access"
              value={effectiveSettings.permissionMode ?? "default"}
              options={permissionModes[effectiveHarness].map((item) => ({
                ...item,
                disabled: busy.settings || !connected,
              }))}
              onChange={(value) => changeSettings({ ...effectiveSettings, permissionMode: value })}
            />
            {details && details.models.length > 0 && (
              <SelectMenu
                label="Model"
                value={effectiveSettings.model ?? "__default"}
                options={[
                  { value: "__default", label: "Default" },
                  ...details.models.map((item) => ({
                    value: item.id,
                    label: item.name,
                    description: item.description,
                    disabled: busy.settings || !connected,
                  })),
                ]}
                onChange={(model) =>
                  changeSettings({
                    ...effectiveSettings,
                    model: model === "__default" ? undefined : model,
                    effort: undefined,
                  })
                }
              />
            )}
            {(() => {
              const efforts =
                details?.models.find(
                  (item) => item.id === (effectiveSettings.model ?? details.defaultModel),
                )?.efforts ?? [];
              return efforts.length ? (
                <SelectMenu
                  label="Reasoning"
                  value={effectiveSettings.effort ?? "__default"}
                  options={[
                    { value: "__default", label: "Default" },
                    ...efforts.map((value) => ({
                      value,
                      label: value,
                      disabled: busy.settings || !connected,
                    })),
                  ]}
                  onChange={(effort) =>
                    changeSettings({
                      ...effectiveSettings,
                      effort: effort === "__default" ? undefined : effort,
                    })
                  }
                />
              ) : null;
            })()}
            {!details && (
              <Text muted style={{ padding: 16 }}>
                Model options load from your machine.
              </Text>
            )}
          </ScrollView>
        </Sheet>
      )}
      {notice && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          onPress={() => setNotice(undefined)}
          style={[local.toast, { backgroundColor: colors.action }]}
        >
          <Text style={{ color: colors.onAction }}>{notice}</Text>
          <Text style={{ color: colors.onAction, fontSize: 12, marginTop: 4 }}>Dismiss</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

function PairScreen({
  restoring,
  connect,
  report,
}: {
  restoring: boolean;
  connect(pairing: MobilePairing): Promise<void>;
  report(message: string): void;
}) {
  const { colors, font } = useTheme();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  async function pair() {
    setBusy(true);
    try {
      const value = mobilePairingSchema.parse(JSON.parse(code));
      await connect(value);
      setCode("");
    } catch {
      report(
        "Could not connect. Paste the complete pairing code generated on your machine and check that secure storage is available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          padding: 28,
          gap: 22,
          maxWidth: 540,
          width: "100%",
          alignSelf: "center",
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text strong style={{ fontSize: 22 }}>
          tidy
        </Text>
        <View style={{ gap: 12 }}>
          <Text strong style={styles.title}>
            Connect your machine
          </Text>
          <Text muted>Start threads and follow agent work from your phone.</Text>
        </View>
        <View style={{ gap: 10 }}>
          <Text strong>Pairing code</Text>
          <Text muted>
            Connect both devices to Tailscale, then paste the private pairing code from your
            machine.
          </Text>
          <TextInput
            accessibilityLabel="Pairing code"
            value={code}
            onChangeText={setCode}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={2048}
            placeholder="Paste pairing code"
            placeholderTextColor={colors.muted}
            style={[
              styles.input,
              { color: colors.ink, borderColor: colors.border, fontFamily: font },
            ]}
          />
          <Button
            primary
            label={restoring ? "Restoring connection…" : busy ? "Connecting…" : "Connect machine"}
            disabled={restoring || busy || !code.trim()}
            onPress={() => void pair()}
          />
        </View>
        <Text muted style={{ fontSize: 13 }}>
          Generate a pairing code using Tidy’s mobile host on your computer. Your projects and agent
          credentials stay on that machine.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ThreadList({
  threads,
  pending,
  open,
  chooseProject,
  hasProject,
  loading,
}: {
  threads: ThreadSummary[];
  pending: Send[];
  open(id: string): void;
  chooseProject(): void;
  hasProject: boolean;
  loading: boolean;
}) {
  const { colors } = useTheme();
  const [search, setSearch] = useState("");
  const entries = threads
    .filter((item) => item.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <FlatList
      data={entries}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 6, flexGrow: 1 }}
      ListHeaderComponent={
        <View style={{ gap: 12, marginBottom: 12 }}>
          <Text strong style={styles.title}>
            Threads
          </Text>
          {threads.length > 5 && (
            <TextInput
              accessibilityLabel="Search threads"
              value={search}
              onChangeText={setSearch}
              placeholder="Search threads"
              placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.ink, borderColor: colors.border }]}
            />
          )}
          {pending
            .filter((item) => !threads.some((thread) => thread.id === item.threadId))
            .map((item) => (
              <Pressable
                key={item.threadId}
                onPress={() => open(item.threadId)}
                style={styles.option}
              >
                <Text strong numberOfLines={1}>
                  {item.text}
                </Text>
                <Text muted>{item.state === "sending" ? "Sending…" : "Needs retry"}</Text>
              </Pressable>
            ))}
        </View>
      }
      ListEmptyComponent={
        <View style={{ gap: 12, paddingVertical: 24 }}>
          <Text muted>
            {loading
              ? "Loading threads from your machine…"
              : search
                ? "No matching threads."
                : hasProject
                  ? "Start a thread to work with your agent."
                  : "Choose a project on your machine to get started."}
          </Text>
          {!hasProject && <Button label="Choose project" onPress={chooseProject} />}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.title}
          onPress={() => open(item.id)}
          style={({ pressed }) => ({
            padding: 14,
            gap: 7,
            borderRadius: 12,
            backgroundColor: pressed ? colors.hover : colors.panel,
            borderWidth: 1,
            borderColor: colors.border,
          })}
        >
          <View style={styles.row}>
            <Text strong numberOfLines={2} style={{ flex: 1 }}>
              {item.title}
            </Text>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: item.pendingApprovalCount
                  ? colors.warning
                  : item.status === "running"
                    ? colors.active
                    : item.status === "failed"
                      ? colors.danger
                      : colors.border,
              }}
            />
          </View>
          {item.preview && (
            <Text muted numberOfLines={2} style={{ fontSize: 14 }}>
              {item.preview}
            </Text>
          )}
          <View style={styles.row}>
            <Text muted style={{ fontSize: 12 }}>
              {names[item.harness]} · {item.pendingApprovalCount ? "Approval needed" : item.status}
            </Text>
            <Text muted style={{ fontSize: 12 }}>
              {new Date(item.updatedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const MessageView = memo(function MessageView({ message }: { message: Message }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        padding: 16,
        gap: 8,
        borderRadius: 12,
        backgroundColor: message.role === "user" ? colors.navigation : "transparent",
      }}
    >
      <Text strong muted style={{ fontSize: 12 }}>
        {message.role === "user" ? "You" : "Agent"}
      </Text>
      {message.text.split(/(```[\s\S]*?```)/g).map((part, index) =>
        part.startsWith("```") ? (
          <ScrollView
            key={index}
            horizontal
            style={{ backgroundColor: colors.hover, borderRadius: 8 }}
          >
            <Text
              selectable
              style={{
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                fontSize: 13,
                padding: 12,
              }}
            >
              {part.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
            </Text>
          </ScrollView>
        ) : (
          <Text selectable key={index} style={{ lineHeight: 24 }}>
            {part}
          </Text>
        ),
      )}
      {message.attachments?.map((item) => (
        <Text key={item.id} muted>
          {item.name}
        </Text>
      ))}
    </View>
  );
});

function Conversation({
  thread,
  send,
  loading,
  retry,
  connected,
  busy,
  approve,
  removeQueued,
}: {
  thread?: Thread;
  send?: Send;
  loading: boolean;
  retry(): void;
  connected: boolean;
  busy: Record<string, boolean>;
  approve(id: string, decision: ApprovalDecision): void;
  removeQueued(id: string): void;
}) {
  const { colors } = useTheme();
  const [toolsOpen, setToolsOpen] = useState(false);
  const list = useRef<FlatList<Message>>(null);
  const atBottom = useRef(true);
  const messages = thread?.messages ?? [];
  const optimistic =
    send &&
    !messages.some((message) => message.id === send.messageId) &&
    !thread?.queuedMessages?.some((message) => message.id === send.messageId);
  return (
    <FlatList
      ref={list}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={({ item }) => <MessageView message={item} />}
      contentContainerStyle={{ padding: 12, gap: 8, flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={100}
      onScroll={(event) => {
        const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
        atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
      }}
      onContentSizeChange={() => {
        if (atBottom.current) list.current?.scrollToEnd({ animated: false });
      }}
      ListEmptyComponent={
        !send ? (
          <View style={styles.empty}>
            <Text muted>
              {loading
                ? "Loading conversation…"
                : "Give your agent a task. Review its progress here as it works."}
            </Text>
          </View>
        ) : undefined
      }
      ListFooterComponent={
        <View style={{ gap: 12 }}>
          {optimistic && (
            <MessageView message={{ id: send.messageId, role: "user", text: send.text }} />
          )}
          {send && (
            <View style={{ paddingHorizontal: 16 }}>
              <Text muted>{send.state === "sending" ? "Sending…" : send.error}</Text>
              {send.state === "failed" && (
                <Button label="Retry delivery" disabled={!connected} onPress={retry} />
              )}
            </View>
          )}
          {!!thread?.toolActivities?.length && (
            <View>
              <Button
                label={`${toolsOpen ? "Hide" : "Show"} activity (${thread.toolActivities.length})`}
                onPress={() => setToolsOpen(!toolsOpen)}
              />
              {toolsOpen && (
                <ScrollView
                  nestedScrollEnabled
                  style={{ maxHeight: 240, backgroundColor: colors.panel, borderRadius: 10 }}
                >
                  {thread.toolActivities.map((tool) => (
                    <ToolRow key={tool.id} tool={tool} />
                  ))}
                </ScrollView>
              )}
            </View>
          )}
          {thread?.pendingApprovals?.map((request) => (
            <View
              key={request.id}
              style={{
                padding: 16,
                gap: 10,
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 12,
              }}
            >
              <Text strong>{request.title}</Text>
              {request.reason && <Text>{request.reason}</Text>}
              {request.details && (
                <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled>
                  <Text selectable muted style={{ fontSize: 13 }}>
                    {request.details}
                  </Text>
                </ScrollView>
              )}
              <View style={styles.wrap}>
                {request.choices.map((choice) => (
                  <Button
                    key={choice}
                    label={
                      choice === "allow"
                        ? "Allow once"
                        : choice === "deny"
                          ? "Deny"
                          : "Allow for session"
                    }
                    disabled={!connected || busy[request.id]}
                    primary={choice === "allow"}
                    onPress={() => approve(request.id, choice)}
                  />
                ))}
              </View>
              {busy[request.id] && <Text muted>Sending decision…</Text>}
            </View>
          ))}
          {thread?.queuedMessages
            ?.filter((item) => !busy[item.id])
            .map((item) => (
              <View
                key={item.id}
                style={{ padding: 16, backgroundColor: colors.panel, borderRadius: 12 }}
              >
                <View style={styles.row}>
                  <Text muted>Queued</Text>
                  <Button
                    label="Remove"
                    compact
                    disabled={!connected || busy[item.id]}
                    onPress={() => removeQueued(item.id)}
                  />
                </View>
                <Text>{item.text}</Text>
              </View>
            ))}
          {thread?.queueError && <Text style={{ color: colors.danger }}>{thread.queueError}</Text>}
        </View>
      }
    />
  );
}
function ToolRow({ tool }: { tool: NonNullable<Thread["toolActivities"]>[number] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ padding: 12, gap: 8 }}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}>
        <Text strong>{tool.title}</Text>
        <Text muted style={{ fontSize: 12 }}>
          {tool.status}
          {tool.exitCode !== undefined ? ` · exit ${tool.exitCode}` : ""}
        </Text>
      </Pressable>
      {open && (
        <Text selectable style={{ fontFamily: "monospace", fontSize: 12 }}>
          {[tool.input, tool.output].filter(Boolean).join("\n\n") || "No additional output."}
        </Text>
      )}
    </View>
  );
}

function ProjectsPanel({
  projects,
  remote,
  close,
  select,
  opened,
  report,
}: {
  projects: Project[];
  remote: RemoteConnection | null;
  close(): void;
  select(id: string): void;
  opened(value: NonNullable<Bootstrap["activeProject"]>): void;
  report(message: string): void;
}) {
  const { colors, font } = useTheme();
  const [browse, setBrowse] = useState(false);
  const [directory, setDirectory] = useState<Directory>();
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const load = useCallback(
    async (target: string) => {
      if (!remote) return;
      const version = ++sequence.current;
      setLoading(true);
      try {
        const result = await remote.request("project-directories", target);
        if (!active.current || sequence.current !== version) return;
        setDirectory(result);
        setPath(result.path);
      } catch (error) {
        if (active.current && sequence.current === version) report(errorText(error));
      } finally {
        if (active.current && sequence.current === version) setLoading(false);
      }
    },
    [remote, report],
  );
  useEffect(() => {
    void load("");
  }, [load]);
  async function open() {
    if (!remote || !path.startsWith("/") || loading) return;
    setLoading(true);
    try {
      const result = await remote.request("open-project", undefined, { projectPath: path });
      if (active.current && result) opened(result);
    } catch (error) {
      if (active.current) report(errorText(error));
    } finally {
      if (active.current) setLoading(false);
    }
  }
  return (
    <Sheet title="Projects" close={close}>
      <ScrollView keyboardShouldPersistTaps="handled">
        {projects.map((project) => (
          <Pressable key={project.id} onPress={() => select(project.id)} style={styles.option}>
            <Text strong>{project.name}</Text>
            <Text muted numberOfLines={1}>
              {project.path}
            </Text>
          </Pressable>
        ))}
        <Button
          label={browse ? "Hide folders" : "Open a folder on your machine"}
          onPress={() => setBrowse(!browse)}
        />
        {browse && (
          <View style={{ gap: 10 }}>
            <TextInput
              accessibilityLabel="Remote project path"
              placeholder="/path/to/project"
              placeholderTextColor={colors.muted}
              value={path}
              onChangeText={setPath}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.input,
                { color: colors.ink, fontFamily: font, borderColor: colors.border },
              ]}
            />
            <Button
              primary
              label={loading ? "Opening…" : "Open folder"}
              disabled={loading || !path.startsWith("/")}
              onPress={() => void open()}
            />
            {directory?.parent && (
              <Button
                label="↑ Parent folder"
                disabled={loading}
                onPress={() => void load(directory.parent!)}
              />
            )}
            <View style={{ maxHeight: 260 }}>
              {loading ? (
                <Text muted>Loading folders…</Text>
              ) : (
                <ScrollView nestedScrollEnabled>
                  {directory?.directories.map((item) => (
                    <Button
                      key={item.path}
                      label={`${item.name} ›`}
                      onPress={() => void load(item.path)}
                    />
                  ))}
                </ScrollView>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </Sheet>
  );
}
const local = StyleSheet.create({
  toast: {
    position: "absolute",
    right: 16,
    bottom: 24,
    padding: 16,
    borderRadius: 12,
    maxWidth: "90%",
    elevation: 8,
  },
});
