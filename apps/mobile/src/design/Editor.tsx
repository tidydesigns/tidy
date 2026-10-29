import { useMemo, useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { randomUUID } from "expo-crypto";
import {
  buildDrawnNode,
  parseImmutableDesignDocument,
  nodePageId,
  type DesignDocument,
  type DesignNode,
} from "@tidy/design/document";
import {
  applyDocumentPatch,
  diffDocument,
  invertPatch,
  type DocumentPatch,
} from "@tidy/design/document-patch";
import { trackDocumentChanges } from "@tidy/design/document-changes";
import { replacePlainText } from "@tidy/design/rich-text-runtime";
import { Button, SelectMenu, Sheet, Text, styles, useTheme } from "../ui";
import type { DesignFile, DesignStore } from "./store";
import Canvas from "./Canvas";

export function DesignEditor({
  file,
  store,
  close,
  run,
  report,
}: {
  file: DesignFile;
  store: DesignStore;
  close(): void;
  run(file: DesignFile): Promise<void>;
  report(message: string): void;
}) {
  const { colors } = useTheme();
  const [page, setPage] = useState(file.document.pages[0].id);
  const [selected, setSelected] = useState<string | null>(null);
  const [preparingAgent, setPreparingAgent] = useState(false);
  const [panel, setPanel] = useState<"layers" | "insert" | "inspect" | null>(null);
  const [, render] = useState(0);
  const history = useRef<{ undo: DocumentPatch[]; redo: DocumentPatch[] }>({ undo: [], redo: [] });
  const editable = !file.base || file.base.canEdit;
  const currentPage = file.document.pages.some((item) => item.id === page)
    ? page
    : file.document.pages[0].id;
  const node = file.document.nodes.find((item) => item.id === selected);
  function inheritedLock(layer: DesignNode, document = store.files.get(file.id)!.document) {
    const nodes = new Map(document.nodes.map((item) => [item.id, item]));
    let current: DesignNode | undefined = layer;
    while (current) {
      if (current.librarySource || (current !== layer && current.locked)) return true;
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    return false;
  }
  const protectedNode = !!node && (node.locked || inheritedLock(node));

  function edit(next: DesignDocument) {
    try {
      const current = store.files.get(file.id)!;
      next = trackDocumentChanges(current.document, next, parseImmutableDesignDocument);
      const patch = diffDocument(current.document, next);
      if (!patch.length) return;
      store.edit(file.id, next);
      history.current.undo = [...history.current.undo.slice(-29), patch];
      history.current.redo = [];
    } catch (error) {
      report(error instanceof Error ? error.message : "Could not edit this file.");
    }
  }
  function change(id: string, update: (node: DesignNode) => DesignNode) {
    const current = store.files.get(file.id)!;
    edit({
      ...current.document,
      nodes: current.document.nodes.map((item) =>
        item.id === id && !item.locked && !inheritedLock(item, current.document)
          ? update(item)
          : item,
      ),
    });
  }
  function undo(redo = false) {
    const from = redo ? history.current.redo : history.current.undo,
      to = redo ? history.current.undo : history.current.redo;
    const patch = from.at(-1);
    if (!patch) return;
    try {
      store.edit(
        file.id,
        applyDocumentPatch(
          store.files.get(file.id)!.document,
          redo ? patch : invertPatch(patch),
          true,
        ),
      );
      from.pop();
      to.push(patch);
      render((value) => value + 1);
    } catch {
      report("This edit changed on another device and cannot be undone.");
    }
  }
  function insert(type: "artboard" | "container" | "text") {
    const current = store.files.get(file.id)!;
    const parent =
      type === "artboard"
        ? undefined
        : node?.type === "artboard" || node?.type === "container"
          ? node
          : current.document.nodes.find((item) => item.id === node?.parentId);
    const roots = current.document.nodes.filter(
      (item) => !item.parentId && nodePageId(item) === currentPage,
    );
    const next = {
      ...buildDrawnNode(randomUUID(), type, parent?.id ?? null, {
        x: parent
          ? 24
          : roots.length
            ? Math.max(...roots.map((item) => item.box.x + item.box.width)) + 48
            : 0,
        y: parent ? 24 : 0,
        width: type === "artboard" ? 390 : type === "text" ? 200 : 120,
        height: type === "artboard" ? 844 : type === "text" ? 32 : 120,
      }),
      pageId: currentPage,
    };
    edit({ ...current.document, nodes: [...current.document.nodes, next] });
    setSelected(next.id);
    setPanel(null);
  }
  function remove() {
    if (!node || protectedNode) return;
    const current = store.files.get(file.id)!;
    const ids = new Set([node.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of current.document.nodes)
        if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
          ids.add(item.id);
          changed = true;
        }
    }
    edit({
      ...current.document,
      nodes: current.document.nodes.filter((item) => !ids.has(item.id)),
    });
    setSelected(null);
    setPanel(null);
  }
  // Status updates must not resend a whole document through the native DOM bridge.
  const canvas = useMemo(
    () => (
      <Canvas
        document={file.document}
        assets={file.assets}
        page={currentPage}
        selected={selected}
        editable={editable && !protectedNode}
        background={colors.navigation}
        ink={colors.ink}
        dom={{ scrollEnabled: false, style: { flex: 1 } }}
        onSelect={async (id) => {
          if (!id || file.document.nodes.some((item) => item.id === id)) setSelected(id);
        }}
        onMove={async (id, x, y) => {
          if (editable && Number.isFinite(x) && Number.isFinite(y))
            change(id, (item) => ({
              ...item,
              box: {
                ...item.box,
                x: Math.round(Math.max(-100000, Math.min(100000, x))),
                y: Math.round(Math.max(-100000, Math.min(100000, y))),
              },
            }));
        }}
      />
    ),
    [file.document, file.assets, currentPage, selected, editable, colors.navigation, colors.ink],
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.header, styles.row, { borderColor: colors.border }]}>
        <Button label="‹ Files" compact onPress={close} />
        <View style={{ flex: 1 }}>
          <Text strong numberOfLines={1}>
            {file.name}
          </Text>
          <Text muted style={{ fontSize: 11, lineHeight: 15 }} numberOfLines={1}>
            {store.status(file)}
          </Text>
        </View>
        <Button
          label={preparingAgent ? "Preparing…" : "Run agent"}
          disabled={preparingAgent}
          compact
          onPress={() => {
            setPreparingAgent(true);
            void run(file)
              .catch((error) =>
                report(error instanceof Error ? error.message : "Could not open agent."),
              )
              .finally(() => setPreparingAgent(false));
          }}
        />
      </View>
      {file.conflict && (
        <View style={{ padding: 12, gap: 6, backgroundColor: colors.hover }}>
          <Text>This file also changed elsewhere. Your phone edits are intact.</Text>
          <View style={styles.wrap}>
            <Button
              label="Keep phone copy"
              onPress={() => {
                void store.keepBoth(file.id).catch((error) => report(String(error)));
              }}
            />
            <Button label="Use cloud version" onPress={() => store.useCloud(file.id)} />
          </View>
        </View>
      )}
      <View
        style={[
          styles.row,
          { paddingHorizontal: 8, borderBottomWidth: 1, borderColor: colors.border },
        ]}
      >
        <SelectMenu
          label="Page"
          value={currentPage}
          options={file.document.pages.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(value) => {
            setPage(value);
            setSelected(null);
          }}
        />
        <View style={styles.row}>
          <Button
            label="Undo"
            compact
            disabled={!editable || !history.current.undo.length}
            onPress={() => undo()}
          />
          <Button
            label="Redo"
            compact
            disabled={!editable || !history.current.redo.length}
            onPress={() => undo(true)}
          />
        </View>
      </View>
      <View style={{ flex: 1 }}>{canvas}</View>
      <View style={[styles.row, { padding: 6, borderTopWidth: 1, borderColor: colors.border }]}>
        <Button label="Layers" onPress={() => setPanel("layers")} />
        <Button label="+ Insert" disabled={!editable} onPress={() => setPanel("insert")} />
        <Button
          label={node ? "Edit layer" : "Properties"}
          disabled={!node}
          onPress={() => setPanel("inspect")}
        />
      </View>
      {panel === "insert" && (
        <Sheet title="Insert" close={() => setPanel(null)}>
          <View style={styles.wrap}>
            <Button label="Frame" onPress={() => insert("artboard")} />
            <Button label="Rectangle" onPress={() => insert("container")} />
            <Button label="Text" onPress={() => insert("text")} />
          </View>
        </Sheet>
      )}
      {panel === "layers" && (
        <Sheet title="Layers" close={() => setPanel(null)}>
          <ScrollView style={{ maxHeight: 420 }}>
            {file.document.nodes
              .filter((item) => nodePageId(item) === currentPage)
              .map((item) => (
                <Button
                  key={item.id}
                  label={`${item.id === selected ? "✓ " : ""}${item.parentId ? "↳ " : ""}${item.name}${item.locked ? " · locked" : ""}`}
                  onPress={() => {
                    setSelected(item.id);
                    setPanel(null);
                  }}
                />
              ))}
          </ScrollView>
        </Sheet>
      )}
      {panel === "inspect" && node && (
        <Sheet title={node.name} close={() => setPanel(null)}>
          <ScrollView
            style={{ maxHeight: 420 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 12 }}
          >
            <Field
              label="Name"
              value={node.name}
              disabled={!editable || protectedNode}
              onChange={(name) => change(node.id, (item) => ({ ...item, name: name || "Layer" }))}
            />
            <View style={styles.wrap}>
              {(["x", "y", "width", "height"] as const).map((key) => (
                <View key={key} style={{ width: "47%" }}>
                  <Field
                    label={key}
                    value={String(node.box[key])}
                    numeric
                    disabled={!editable || protectedNode}
                    onChange={(value) => {
                      const number = Number(value);
                      if (
                        value.trim() &&
                        Number.isFinite(number) &&
                        number >= (key === "x" || key === "y" ? -100000 : 1) &&
                        number <= (key === "x" || key === "y" ? 100000 : 5000)
                      )
                        change(node.id, (item) => ({
                          ...item,
                          box: { ...item.box, [key]: number },
                        }));
                    }}
                  />
                </View>
              ))}
            </View>
            {node.type === "text" && (
              <>
                <Field
                  label="Text"
                  value={node.text ?? ""}
                  multiline
                  disabled={!editable || protectedNode}
                  onChange={(text) =>
                    change(node.id, (item) => ({
                      ...item,
                      text,
                      richText: item.richText
                        ? replacePlainText({ ...item, text: item.text ?? "" }, text).richText
                        : undefined,
                    }))
                  }
                />
                <Field
                  label="Font size"
                  value={String(node.style.fontSize ?? 16)}
                  numeric
                  disabled={!editable || protectedNode}
                  onChange={(value) => {
                    const size = Number(value);
                    if (size > 0 && size <= 512)
                      change(node.id, (item) => ({
                        ...item,
                        style: { ...item.style, fontSize: size },
                      }));
                  }}
                />
              </>
            )}
            <Field
              label={node.type === "text" ? "Text color" : "Fill"}
              value={(node.type === "text" ? node.style.color : node.style.fill) ?? "#ffffff"}
              disabled={!editable || protectedNode}
              onChange={(value) => {
                if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value))
                  change(node.id, (item) => ({
                    ...item,
                    style: { ...item.style, [item.type === "text" ? "color" : "fill"]: value },
                  }));
              }}
            />
            {editable && (
              <View style={styles.wrap}>
                <Button
                  label={node.locked ? "Unlock" : "Lock"}
                  disabled={inheritedLock(node)}
                  onPress={() =>
                    edit({
                      ...file.document,
                      nodes: file.document.nodes.map((item) =>
                        item.id === node.id ? { ...item, locked: !item.locked } : item,
                      ),
                    })
                  }
                />
                <Button
                  label={node.visible ? "Hide" : "Show"}
                  disabled={protectedNode}
                  onPress={() => change(node.id, (item) => ({ ...item, visible: !item.visible }))}
                />
                <Button label="Delete layer" danger disabled={protectedNode} onPress={remove} />
              </View>
            )}
          </ScrollView>
        </Sheet>
      )}
    </View>
  );
}

export function Field({
  label,
  value,
  onChange,
  disabled,
  numeric,
  multiline,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  numeric?: boolean;
  multiline?: boolean;
}) {
  const { colors, font } = useTheme();
  const [draft, setDraft] = useState(value),
    [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 4 }}>
      <Text muted style={{ fontSize: 12 }}>
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={focused ? draft : value}
        editable={!disabled}
        multiline={multiline}
        keyboardType={numeric ? "numbers-and-punctuation" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => {
          setDraft(value);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChangeText={(next) => {
          setDraft(next);
          onChange(next);
        }}
        style={[
          styles.input,
          {
            color: colors.ink,
            fontFamily: font,
            borderColor: colors.border,
            padding: 10,
            opacity: disabled ? 0.5 : 1,
          },
        ]}
      />
    </View>
  );
}
