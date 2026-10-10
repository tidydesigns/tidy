import { expect, test } from "bun:test";
import { captureStyle } from "./browser-capture";

test("capture retains a bottom-only link border without drawing borders on editable text", () => {
  const css = {
    opacity: "1",
    backgroundColor: "transparent",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "4px",
    borderLeftWidth: "0px",
    borderTopColor: "rgb(30, 30, 30)",
    borderBottomColor: "rgb(255, 93, 0)",
    color: "rgb(30, 30, 30)",
    fontSize: "29px",
    fontFamily: "system-ui",
    fontWeight: "700",
    lineHeight: "34.8px",
    letterSpacing: "-1px",
    textDecorationLine: "none",
  } as CSSStyleDeclaration;
  expect(captureStyle(css)).toMatchObject({
    borderTopWidth: 0,
    borderRightWidth: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 0,
    borderColor: "#ff5d00",
  });
  const text = captureStyle(css, true);
  expect(text.borderWidth).toBe(0);
  expect(text.borderBottomWidth).toBe(0);
});
