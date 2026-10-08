import type { DesignDocument, DesignNode } from "@/lib/design/document";

// Transcribed from apps/web/app/login, the shared AuthShell/TextField/Button components, and app/globals.css.
// The supplied screenshot is used only to check the resolved desktop geometry.
export function buildLoginDocument(cropTestAssetId?: string): DesignDocument {
  const nodes: DesignNode[] = [];
  const add = (
    node: Partial<DesignNode> & Pick<DesignNode, "id" | "name" | "type" | "parentId" | "box">,
  ) => {
    nodes.push({ style: {}, visible: true, locked: false, layout: "absolute", ...node });
  };
  const ink = "#1e1e1e";
  const grey = "#c7c7c7";
  const paper = "#f2f2f0";
  const orange = "#ff5d00";
  const source = {
    shell: "apps/web/components/auth/auth-shell.tsx",
    form: "apps/web/app/login/login-form.tsx",
    page: "apps/web/app/login/page.tsx",
    field: "apps/web/components/ui/text-field.tsx",
    button: "apps/web/components/ui/button.tsx",
  };
  function screen(prefix: string, x: number, width: number, height: number) {
    const root = `${prefix}-screen`;
    const panel = `${prefix}-panel`;
    const panelWidth = Math.min(384, width - 48);
    const panelHeight = 488;
    const panelY = Math.round((height - panelHeight) / 2);
    add({
      id: root,
      parentId: null,
      name: `${prefix === "desktop" ? "Desktop 1440" : "Mobile 390"} · /login`,
      type: "artboard",
      box: { x, y: 120, width, height },
      style: { fill: paper },
      sourceKey: `${prefix}:artboard`,
      sourcePath: source.page,
    });
    add({
      id: panel,
      parentId: root,
      name: "Authentication panel",
      type: "container",
      box: {
        x: Math.round((width - panelWidth) / 2),
        y: panelY,
        width: panelWidth,
        height: panelHeight,
      },
      sourceKey: `${prefix}:auth-shell`,
      sourcePath: source.shell,
    });
    const p = panel;
    const text = (
      id: string,
      name: string,
      value: string,
      x: number,
      y: number,
      w: number,
      h: number,
      size: number,
      weight: number,
      color: string,
      path: string,
      extra: DesignNode["style"] = {},
    ) =>
      add({
        id: `${prefix}-${id}`,
        parentId: p,
        name,
        type: "text",
        box: { x, y, width: w, height: h },
        text: value,
        style: {
          color,
          fontSize: size,
          fontWeight: weight,
          fontFamily: "var(--font-instrument-sans)",
          lineHeight: 1.35,
          ...extra,
        },
        sourceKey: `${prefix}:${id}`,
        sourcePath: path,
      });
    const container = (
      id: string,
      name: string,
      y: number,
      h: number,
      fill: string,
      border = false,
    ) =>
      add({
        id: `${prefix}-${id}`,
        parentId: p,
        name,
        type: "container",
        box: { x: 0, y, width: panelWidth, height: h },
        style: { fill, radius: 8, ...(border ? { borderWidth: 1, borderColor: grey } : {}) },
        sourceKey: `${prefix}:${id}`,
        sourcePath: border ? source.field : source.button,
      });
    text("logo", "Tidy logo", "Tidy", 0, 0, 101, 34, 34, 400, ink, source.shell, {
      fontFamily: "var(--font-instrument-serif)",
      letterSpacing: -0.68,
      lineHeight: 0.98,
    });
    if (cropTestAssetId)
      add({
        id: `${prefix}-crop-fixture`,
        parentId: p,
        name: "Crop test image",
        type: "image",
        box: { x: 0, y: 0, width: 101, height: 34 },
        assetId: cropTestAssetId,
        style: { objectFit: "contain" },
        sourceKey: `${prefix}:crop-fixture`,
        sourcePath: source.shell,
      });
    text(
      "heading",
      "Welcome heading",
      "Welcome back.",
      0,
      88,
      panelWidth,
      42,
      30,
      600,
      ink,
      source.shell,
    );
    text(
      "description",
      "Sign in description",
      "Sign in to your Tidy account.",
      0,
      136,
      panelWidth,
      24,
      14,
      400,
      "#626262",
      source.shell,
    );
    text("email-label", "Email label", "Email", 0, 194, panelWidth, 20, 14, 500, ink, source.field);
    container("email-input", "Email input", 222, 48, paper, true);
    text(
      "email-placeholder",
      "Email placeholder",
      "you@example.com",
      16,
      236,
      panelWidth - 32,
      20,
      14,
      400,
      "#777777",
      source.field,
    );
    text(
      "password-label",
      "Password label",
      "Password",
      0,
      290,
      panelWidth,
      20,
      14,
      500,
      ink,
      source.field,
    );
    container("password-input", "Password input", 318, 48, paper, true);
    text(
      "password-placeholder",
      "Password placeholder",
      "••••••••",
      16,
      332,
      panelWidth - 32,
      20,
      14,
      400,
      "#777777",
      source.field,
    );
    container("submit", "Sign in button", 386, 48, orange);
    text("submit-text", "Sign in", "Sign in", 0, 399, panelWidth, 24, 14, 600, ink, source.button, {
      textAlign: "center",
    });
    text(
      "footer-prompt",
      "New account prompt",
      "New to Tidy?",
      0,
      466,
      panelWidth / 2 - 3,
      22,
      14,
      400,
      "#777777",
      source.page,
      { textAlign: "right" },
    );
    text(
      "footer-link",
      "Create account link",
      "Create an account",
      panelWidth / 2 + 3,
      466,
      panelWidth / 2 - 3,
      22,
      14,
      500,
      ink,
      source.page,
    );
  }
  screen("desktop", 120, 1440, 900);
  screen("mobile", 1680, 390, 844);
  return {
    schemaVersion: 1,
    legacyConverted: true,
    pages: [{ id: "page-1", name: "Page 1" }],
    source: { project: "bellarun", route: "/login" },
    nodes,
    tokens: {},
    editedNodeIds: [],
    deletedSourceKeys: [],
    warnings: [
      {
        message:
          "Static signed-out state. Form submission, focus styling, responsive behavior, and link navigation are not interactive in Tidy.",
      },
    ],
  };
}
