import { expect, test } from "bun:test";
import { recoverSkills } from "./skill-recovery";

const skills = [
  { id: "review-id", name: "review", description: "" },
  { id: "audit-id", name: "audit", description: "" },
];
test("recovered IDs keep their own names after prompt commands are reordered", () => {
  expect(
    recoverSkills({ text: "Use $audit then /review", ids: ["review-id", "audit-id"], skills }),
  ).toEqual({
    kind: "ready",
    skills: [
      { id: "review-id", name: "review" },
      { id: "audit-id", name: "audit" },
    ],
  });
});
test("recovery blocks instead of silently dropping an unknown selected identity", () => {
  for (const catalog of [[], [skills[0]]])
    expect(
      recoverSkills({
        text: "Use /review and $audit",
        ids: ["review-id", "audit-id"],
        skills: catalog,
      }),
    ).toEqual({ kind: "unavailable" });
});
test("recovery omits removed commands only after every identity can be reconstructed", () => {
  expect(
    recoverSkills({ text: "Only $audit", ids: ["review-id", "audit-id", "audit-id"], skills }),
  ).toEqual({ kind: "ready", skills: [{ id: "audit-id", name: "audit" }] });
});
