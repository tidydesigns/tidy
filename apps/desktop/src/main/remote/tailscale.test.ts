import { expect, test } from "bun:test";
import { parseTailnetStatus } from "./tailscale";
import { tailscaleVerificationSchema, VerificationOutput } from "./tailscale-verification";

test("tailnet discovery validates hosts and orders reachable desktops and servers first", () => {
  expect(
    parseTailnetStatus({
      BackendState: "Running",
      Peer: {
        a: { HostName: "home", DNSName: "home.example.ts.net.", OS: "linux", Online: true },
        b: { HostName: "backup", DNSName: "backup.example.ts.net.", OS: "linux", Online: false },
        mac: { HostName: "mac", DNSName: "mac.example.ts.net.", OS: "macOS", Online: true },
        c: { HostName: "phone", DNSName: "phone.example.ts.net.", OS: "ios", Online: true },
        d: { HostName: "-oProxyCommand=bad", DNSName: "", OS: "linux", Online: true },
      },
    }),
  ).toEqual({
    kind: "ready",
    machines: [
      { host: "home.example.ts.net", name: "home", online: true },
      { host: "mac.example.ts.net", name: "mac", online: true },
      { host: "backup.example.ts.net", name: "backup", online: false },
    ],
  });
  expect(parseTailnetStatus({ BackendState: "NeedsLogin" }).kind).toBe("unavailable");
  expect(() => parseTailnetStatus({ BackendState: "Running", Peer: { bad: {} } })).toThrow();
});

test("verification extraction waits for complete lines and deduplicates fragmented SSH output", () => {
  const urls: string[] = [];
  const output = new VerificationOutput((url) => urls.push(url));
  output.receive("Verify at https://login.tailscale.com/a/abc");
  expect(urls).toEqual([]);
  output.receive("123\nhttps://login.tailscale.com/a/abc123\n");
  expect(urls).toEqual(["https://login.tailscale.com/a/abc123"]);
  output.receive("https://login.tailscale.com.attacker.test/a/abc\n");
  expect(urls).toHaveLength(1);
});

test("browser verification rejects arbitrary protocols, credentials, ports and redirect URLs", () => {
  for (const url of [
    "file:///tmp/a",
    "https://login.tailscale.com@evil.test/a/abc",
    "http://login.tailscale.com/a/abc",
    "https://login.tailscale.com:8443/a/abc",
    "https://login.tailscale.com/a/abc?next=https://evil.test",
    "https://login.tailscale.com/admin",
    "https://login.tailscale.com/a/abc#fragment",
  ]) {
    expect(tailscaleVerificationSchema.safeParse(url).success).toBe(false);
  }
});
