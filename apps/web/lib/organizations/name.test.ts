import { expect, test } from "bun:test";
import { organizationCreationNavigationSchema } from "./name";

test("creation navigation accepts only named internal destinations and validated names", () => {
  for (const destination of ["team", "files"] as const) {
    expect(organizationCreationNavigationSchema.parse({ name: "  Studio  ", destination })).toEqual(
      {
        name: "Studio",
        destination,
      },
    );
  }
  for (const input of [
    null,
    { name: "Studio", destination: "https://example.test" },
    { name: "Studio", destination: "//example.test" },
    { name: "Studio", destination: "/files" },
    { name: "Studio", destination: true },
    { name: "", destination: "team" },
    { name: " ", destination: "team" },
    { name: "A".repeat(101), destination: "team" },
    { name: "Studio\u0000", destination: "team" },
    { name: 123, destination: "team" },
    { name: "Studio" },
  ]) {
    expect(organizationCreationNavigationSchema.safeParse(input).success).toBe(false);
  }
});
