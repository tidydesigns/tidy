// Website-only filters keep app, desktop and MCP activity out of acquisition charts.
const property = (key: string, value: string) => ({ key, value, type: "event", operator: "exact" });
const website = [property("surface", "website")];
const pageviews = {
  kind: "EventsNode",
  event: "$pageview",
  name: "$pageview",
  properties: website,
};
type Series = {
  kind: string;
  event: string;
  name: string;
  math?: string;
  custom_name?: string;
  properties: { key: string; value?: string; type: string; operator: string }[];
};
const trends = (series: Series[], breakdown?: string, display = "ActionsLineGraph") => ({
  kind: "InsightVizNode",
  source: {
    kind: "TrendsQuery",
    dateRange: { date_from: "-30d" },
    interval: "day",
    filterTestAccounts: true,
    series,
    trendsFilter: { display },
    ...(breakdown ? { breakdownFilter: { breakdown, breakdown_type: "event" } } : {}),
  },
});

export const websiteDashboard = {
  name: "Website acquisition and conversion",
  description:
    "Consenting website traffic, traffic sources, CTA clicks and new accounts. Downloads measure intent, not completed transfers or installs. Visitors who decline analytics are excluded.",
  insights: [
    {
      name: "Website visitors and pageviews",
      query: trends([
        { ...pageviews, math: "dau", custom_name: "Visitors" },
        { ...pageviews, math: "total", custom_name: "Pageviews" },
      ]),
    },
    {
      name: "Top website pages",
      query: trends([{ ...pageviews, math: "total" }], "$pathname", "ActionsTable"),
    },
    {
      name: "Website referring domains",
      query: trends([{ ...pageviews, math: "dau" }], "$referring_domain", "ActionsBarValue"),
    },
    {
      name: "Website campaign sources",
      query: trends([{ ...pageviews, math: "dau" }], "utm_source", "ActionsBarValue"),
    },
    {
      name: "Website CTA clicks",
      query: trends(
        [
          {
            kind: "EventsNode",
            event: "website_cta_clicked",
            name: "website_cta_clicked",
            math: "total",
            properties: website,
          },
        ],
        "action",
        "ActionsBarValue",
      ),
    },
    {
      name: "macOS download clicks by placement",
      query: trends(
        [
          {
            kind: "EventsNode",
            event: "website_cta_clicked",
            name: "website_cta_clicked",
            math: "total",
            properties: [...website, property("action", "download_mac")],
          },
        ],
        "placement",
        "ActionsBarValue",
      ),
    },
    {
      name: "Website to macOS download",
      query: {
        kind: "InsightVizNode",
        source: {
          kind: "FunnelsQuery",
          dateRange: { date_from: "-30d" },
          filterTestAccounts: true,
          series: [
            pageviews,
            {
              kind: "EventsNode",
              event: "website_cta_clicked",
              name: "website_cta_clicked",
              properties: [...website, property("action", "download_mac")],
            },
          ],
          funnelsFilter: {
            funnelVizType: "steps",
            funnelOrderType: "ordered",
            funnelWindowInterval: 1,
            funnelWindowIntervalUnit: "day",
          },
        },
      },
    },
    {
      name: "New accounts attributed to website visits",
      description:
        "New account creation, including email accounts awaiting verification. Requires usage consent on both surfaces.",
      query: trends(
        [
          {
            kind: "EventsNode",
            event: "signup_completed",
            name: "signup_completed",
            math: "total",
            properties: [
              property("surface", "web"),
              { key: "website_visitor_id", type: "event", operator: "is_set" },
            ],
          },
        ],
        "signup_method",
      ),
    },
  ],
};
