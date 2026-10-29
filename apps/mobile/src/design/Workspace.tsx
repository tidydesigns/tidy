import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, FlatList, Platform, Pressable, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { documentAssetIds } from "@tidy/design/document";
import type { z } from "zod";
import type {
  cloudAccountSchema,
  cloudCatalogSchema,
} from "@tidy/agent-protocol/contracts/cloud-sync";
import { Button, SelectMenu, Sheet, Text, styles, useTheme } from "../ui";
import { MobileAuth } from "./auth";
import { MobileCloud } from "./cloud";
import { DesignStore, type DesignFile } from "./store";
import { designStorage } from "./storage";
import { DesignEditor } from "./Editor";

export function DesignWorkspace({
  active,
  run,
  report,
}: {
  active: boolean;
  run(file: DesignFile): Promise<void>;
  report(message: string): void;
}) {
  const { colors, font } = useTheme();
  const [store] = useState(() => new DesignStore(designStorage, randomUUID));
  const [auth] = useState(() => new MobileAuth());
  const [cloud] = useState(() => new MobileCloud(auth.request));
  const [, render] = useState(0);
  const [ready, setReady] = useState(false);
  const [opened, setOpened] = useState<string>();
  const [account, setAccount] = useState<z.infer<typeof cloudAccountSchema>>();
  const [org, setOrg] = useState<string>();
  const [catalog, setCatalog] = useState<{
    org: string;
    value: z.infer<typeof cloudCatalogSchema>;
  }>();
  const [panel, setPanel] = useState<"cloud" | "new" | null>(null);
  const [origin, setOrigin] = useState("https://app.tidydesign.co");
  const [name, setName] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [opening, setOpening] = useState<string>();
  const [query, setQuery] = useState("");
  const mounted = useRef(true),
    requestId = useRef(0);
  const current = useRef({ active, opened, org });
  current.current = { active, opened, org };
  const reportRef = useRef(report);
  reportRef.current = report;
  const error = useCallback((cause: unknown) => {
    if (mounted.current)
      reportRef.current(
        cause instanceof Error ? cause.message : "Could not sync. Your phone edits are intact.",
      );
  }, []);
  const connect = useCallback(() => {
    const session = auth.session;
    store.connect(
      session ? { origin: session.origin, accountId: session.accountId, remote: cloud } : undefined,
    );
    render((value) => value + 1);
  }, [auth, cloud, store]);
  const refreshAccount = useCallback(async () => {
    const session = auth.session;
    if (!session) return;
    const value = await cloud.account();
    if (
      !mounted.current ||
      auth.session?.accountId !== session.accountId ||
      auth.session?.origin !== session.origin
    )
      return;
    setAccount(value);
    setOrg((previous) =>
      value.organizations.some((item) => item.id === previous)
        ? previous
        : value.organizations[0]?.id,
    );
  }, [auth, cloud]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = store.subscribe(() => {
      if (mounted.current) render((value) => value + 1);
    });
    void Promise.all([store.restore(), auth.restore().catch(error)])
      .then(() => {
        if (!mounted.current) return;
        connect();
        setReady(true);
        void refreshAccount().catch(error);
      })
      .catch(error);
    return () => {
      mounted.current = false;
      unsubscribe();
      store.connect();
    };
  }, [auth, store, connect, refreshAccount, error]);
  useEffect(() => {
    if (!org || !auth.session) return;
    let disposed = false;
    void cloud
      .catalog(org)
      .then((value) => {
        if (!disposed) setCatalog({ org, value });
      })
      .catch(error);
    return () => {
      disposed = true;
    };
  }, [org, account, auth, cloud, error]);
  useEffect(() => {
    let foreground = AppState.currentState === "active";
    const sync = () => {
      if (foreground) void store.sync(current.current.active ? current.current.opened : undefined);
    };
    const timer = setInterval(sync, 5_000);
    const subscription = AppState.addEventListener("change", (state) => {
      foreground = state === "active";
      if (foreground) {
        sync();
        void refreshAccount().catch(error);
      }
    });
    sync();
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [store, refreshAccount, error]);
  const file = opened ? store.files.get(opened) : undefined;
  useEffect(() => {
    if (!file?.cloud || !auth.session || !active) return;
    const binding = file.cloud;
    if (auth.session.origin !== binding.origin || auth.session.accountId !== binding.accountId)
      return;
    let disposed = false;
    void (async () => {
      for (const id of documentAssetIds(file.document)) {
        if (disposed || store.files.get(file.id)?.assets[id]) continue;
        const value = await cloud.asset(binding.fileId, id);
        if (
          disposed ||
          auth.session?.origin !== binding.origin ||
          auth.session?.accountId !== binding.accountId
        )
          return;
        store.asset(file.id, id, value);
      }
    })().catch(error);
    return () => {
      disposed = true;
    };
  }, [opened, file?.document, active, auth, cloud, store, error]);
  const organization = account?.organizations.find((item) => item.id === org);
  const owner =
    auth.session && org
      ? { origin: auth.session.origin, accountId: auth.session.accountId, organizationId: org }
      : undefined;
  const local = store.visible();
  const localByCloud = new Map(
    local.filter((item) => item.cloud).map((item) => [item.cloud!.fileId, item]),
  );
  const rows = [
    ...local
      .filter((item) => !item.cloud || item.cloud.organizationId === org || !org)
      .map((item) => ({ id: item.id, name: item.name, file: item, cloudId: item.cloud?.fileId })),
    ...(catalog && catalog.org === org ? catalog.value.files : [])
      .filter((item) => !localByCloud.has(item.id))
      .map((item) => ({ id: item.id, name: item.name, file: undefined, cloudId: item.id })),
  ].filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
  async function open(row: (typeof rows)[number]) {
    const request = ++requestId.current;
    if (row.file) {
      setOpened(row.file.id);
      void store.sync(row.file.id);
      return;
    }
    if (!owner || !row.cloudId) return;
    setOpening(row.id);
    try {
      const result = await store.open(owner, row.cloudId, cloud);
      if (
        mounted.current &&
        request === requestId.current &&
        auth.session?.accountId === owner.accountId &&
        auth.session?.origin === owner.origin
      )
        setOpened(result.id);
    } catch (cause) {
      error(cause);
    } finally {
      if (request === requestId.current) setOpening(undefined);
    }
  }
  if (file && local.includes(file))
    return (
      <View style={{ flex: 1, display: active ? "flex" : "none" }}>
        <DesignEditor
          key={file.id}
          file={file}
          store={store}
          close={() => {
            ++requestId.current;
            setOpened(undefined);
          }}
          run={run}
          report={report}
        />
      </View>
    );
  return (
    <View style={{ flex: 1, display: active ? "flex" : "none" }}>
      <View style={[styles.header, styles.row, { borderColor: colors.border }]}>
        {account?.organizations.length ? (
          <SelectMenu
            label="Workspace"
            value={org ?? ""}
            options={account.organizations.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(value) => {
              ++requestId.current;
              setOrg(value);
              setQuery("");
            }}
          />
        ) : (
          <Text strong style={{ paddingLeft: 8 }}>
            Files
          </Text>
        )}
        <Button
          label="+ File"
          disabled={!ready}
          onPress={() => {
            setName("");
            setPanel("new");
          }}
        />
      </View>
      <View style={{ padding: 16, gap: 12 }}>
        <View style={styles.row}>
          <Text muted>{auth.session ? "Cloud workspace" : "On this device"}</Text>
          <Button
            compact
            label={auth.session ? "Cloud settings" : "Connect cloud"}
            onPress={() => setPanel("cloud")}
          />
        </View>
        {!!rows.length || !!query ? (
          <TextInput
            accessibilityLabel="Search files"
            placeholder="Search files"
            placeholderTextColor={colors.muted}
            value={query}
            onChangeText={setQuery}
            style={[
              styles.input,
              { fontFamily: font, color: colors.ink, borderColor: colors.border },
            ]}
          />
        ) : null}
      </View>
      <FlatList
        data={rows}
        refreshing={false}
        onRefresh={() => {
          void refreshAccount().catch(error);
          void store.sync();
        }}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.name}`}
            onPress={() => {
              void open(item);
            }}
            style={({ pressed }) => ({
              padding: 20,
              gap: 6,
              borderBottomWidth: 1,
              borderColor: colors.border,
              backgroundColor: pressed ? colors.hover : colors.surface,
            })}
          >
            <Text strong>{item.name}</Text>
            <View style={styles.row}>
              <Text muted style={{ flex: 1, fontSize: 12 }}>
                {opening === item.id
                  ? "Opening…"
                  : item.file
                    ? store.status(item.file)
                    : "Cloud · available to open"}
              </Text>
              {item.file && !item.file.cloud && owner && organization?.canEdit && (
                <Button
                  label="Sync to workspace"
                  compact
                  onPress={() => {
                    try {
                      store.attach(item.file!.id, owner);
                      void store.sync();
                    } catch (cause) {
                      error(cause);
                    }
                  }}
                />
              )}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text strong style={styles.heading}>
              {ready
                ? query
                  ? "No matching files"
                  : "Your design workspace"
                : "Opening your files…"}
            </Text>
            {ready && !query && (
              <Text muted>
                Create a design here, or connect your cloud workspace to continue a file from
                desktop or web.
              </Text>
            )}
          </View>
        }
      />
      {panel === "new" && (
        <Sheet title="New design file" close={() => setPanel(null)}>
          <TextInput
            accessibilityLabel="File name"
            autoFocus
            value={name}
            onChangeText={setName}
            placeholder="Untitled"
            placeholderTextColor={colors.muted}
            maxLength={120}
            style={[
              styles.input,
              { color: colors.ink, fontFamily: font, borderColor: colors.border },
            ]}
          />
          <Text muted>
            {owner && organization?.canEdit
              ? `Syncs to ${organization.name}`
              : "Stored on this device"}
          </Text>
          <Button
            label="Create file"
            primary
            onPress={() => {
              const next = store.create(
                name || "Untitled",
                organization?.canEdit ? owner : undefined,
              );
              setOpened(next.id);
              setPanel(null);
              void store.sync(next.id);
            }}
          />
        </Sheet>
      )}
      {panel === "cloud" && (
        <Sheet title="Cloud workspace" close={() => setPanel(null)}>
          {auth.session ? (
            <>
              <Text>{auth.session.origin}</Text>
              <Text muted>
                Opened files stay available offline. Changes sync while the app is active.
              </Text>
              <Button
                label="Sync now"
                onPress={() => {
                  void store.sync(opened);
                  void refreshAccount().catch(error);
                }}
              />
              <Button
                label="Sign out"
                onPress={() => {
                  ++requestId.current;
                  setOpened(undefined);
                  store.connect();
                  setAccount(undefined);
                  setOrg(undefined);
                  setCatalog(undefined);
                  void auth
                    .signOut()
                    .then(() => {
                      connect();
                      setPanel(null);
                    })
                    .catch(error);
                }}
              />
            </>
          ) : (
            <>
              <Text muted>Use the same account as Tidy desktop and web.</Text>
              <TextInput
                accessibilityLabel="Cloud address"
                value={origin}
                onChangeText={setOrigin}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={[
                  styles.input,
                  { color: colors.ink, fontFamily: font, borderColor: colors.border },
                ]}
              />
              {Platform.OS === "web" ? (
                <Text muted>
                  Install the iOS or Android app to sign in. This browser preview supports local
                  files.
                </Text>
              ) : (
                <Button
                  label={signingIn ? "Signing in…" : "Sign in"}
                  primary
                  disabled={signingIn}
                  onPress={() => {
                    setSigningIn(true);
                    void auth
                      .signIn(origin)
                      .then(() => {
                        connect();
                        setPanel(null);
                        return refreshAccount();
                      })
                      .catch(error)
                      .finally(() => setSigningIn(false));
                  }}
                />
              )}
            </>
          )}
        </Sheet>
      )}
    </View>
  );
}
