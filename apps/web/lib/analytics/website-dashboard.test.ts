import { expect, test } from "bun:test";
import { websiteDashboard } from "./website-dashboard";

test("website dashboards scope traffic, conversion steps and attributed signup counts to their surfaces", () => {
  for (const insight of websiteDashboard.insights) {
    const series = insight.query.source.series;
    for (const event of series) {
      expect(event.properties).toContainEqual({
        key: "surface",
        value: event.event === "signup_completed" ? "web" : "website",
        type: "event",
        operator: "exact",
      });
      if (event.event === "signup_completed")
        expect(event.properties).toContainEqual({
          key: "website_visitor_id",
          type: "event",
          operator: "is_set",
        });
    }
  }
  expect(websiteDashboard.description).toContain("Visitors who decline analytics are excluded");
  expect(websiteDashboard.description).toContain("not completed transfers or installs");
});
