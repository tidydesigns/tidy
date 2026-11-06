import { expect, test } from "bun:test";
import { clearUnchangedSkills, recoverSkills } from "./skill-recovery";
import type { Draft } from "./machine-context";

test("a successful project switch clears stale skills without overwriting pending draft edits", () => {
  const previous: Draft = {
    text: "/review",
    harness: "codex",
    designIds: [],
    skill: { id: "old", name: "review", harness: "codex" },
    recoveredSkills: { ids: ["old"], harness: "codex" },
  };
  const edited = { ...previous, text: "/review with new details" };
  expect(clearUnchangedSkills(edited, previous)).toEqual({
    ...edited,
    skill: undefined,
    recoveredSkills: undefined,
  });
  const reselected: Draft = {
    ...edited,
    skill: { id: "new", name: "audit", harness: "codex" },
    recoveredSkills: { ids: ["new"], harness: "codex" },
  };
  expect(clearUnchangedSkills(reselected, previous)).toEqual(reselected);
});

const skills = [
  { id: "review-id", name: "review", description: "" },
  { id: "audit-id", name: "audit", description: "" },
];
test("plain drafts do not require a skill catalog", () => {
  for (const text of ["Explain this", "`/review`", "```\n/review"])
    expect(recoverSkills({ text, ids: [], skills: [], catalogReady: false })).toEqual({
      kind: "ready",
      skills: [],
    });
});
test("recovered IDs keep their own names after prompt commands are reordered", () => {
  expect(
    recoverSkills({
      text: "Use $audit then /review",
      ids: ["review-id", "audit-id"],
      skills,
      catalogReady: true,
    }),
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
        catalogReady: true,
      }),
    ).toEqual({ kind: "unavailable" });
});
test("recovery omits removed commands only after every identity can be reconstructed", () => {
  expect(
    recoverSkills({
      text: "Only $audit",
      ids: ["review-id", "audit-id", "audit-id"],
      skills,
      catalogReady: true,
    }),
  ).toEqual({ kind: "ready", skills: [{ id: "audit-id", name: "audit" }] });
});

test("a restored multi-skill draft waits for a ready catalog even with remembered or recovered IDs", () => {
  for (const ids of [[], ["review-id"], ["review-id", "audit-id"]])
    expect(
      recoverSkills({
        text: "Use /review and $audit",
        ids,
        skills: [skills[0]],
        catalogReady: false,
      }),
    ).toEqual({ kind: "unavailable" });
  expect(
    recoverSkills({ text: "Use /review and $audit", ids: [], skills, catalogReady: true }),
  ).toEqual({ kind: "ready", skills: [] });
});
