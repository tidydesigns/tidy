import { expect, test } from "bun:test";
import { ZodError } from "zod";
import {
  blankDesignDocument,
  DESIGN_DOCUMENT_LIMITS,
  parseDesignDocument,
  parseImmutableDesignDocument,
} from "./document";

test("invalid imports stop at the first layer with bounded errors and its original path", () => {
  const nodes = Array.from({ length: 5000 }, () => ({}));
  Object.defineProperty(nodes[1], "id", {
    enumerable: true,
    get() {
      throw new Error("Validation continued past the first invalid layer.");
    },
  });
  try {
    parseDesignDocument({ ...blankDesignDocument(), nodes });
    throw new Error("Invalid layers were accepted.");
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    const issues = (error as ZodError).issues;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThan(10);
    expect(issues.every((issue) => issue.path[0] === "nodes" && issue.path[1] === 0)).toBe(true);
  }
});

test("oversized layer collections are rejected before traversing their contents", () => {
  const nodes = Array(DESIGN_DOCUMENT_LIMITS.nodes + 1).fill({});
  Object.defineProperty(nodes, 0, {
    get() {
      throw new Error("Oversized collection contents were inspected.");
    },
  });
  for (const parse of [parseDesignDocument, parseImmutableDesignDocument]) {
    try {
      parse({ ...blankDesignDocument(), nodes });
      throw new Error("Oversized layers were accepted.");
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toMatchObject([
        { code: "too_big", path: ["nodes"], maximum: DESIGN_DOCUMENT_LIMITS.nodes },
      ]);
    }
  }
});
