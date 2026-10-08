import { parseArgs } from "node:util";
import { BillingAdminError } from "../lib/billing/complimentary";
import { Client } from "pg";
import Stripe from "stripe";
import { manageComplimentaryPro, type Options, type Organization } from "./complimentary-pro";

const help = `Complimentary Pro administration (run from the repository root).

bun run billing:pro inspect --email=you@example.com --mode=live
bun run billing:pro inspect --org=ORG_ID --mode=live
bun run billing:pro grant --org=ORG_ID --mode=live --reason="Founder"
bun run billing:pro grant --org=ORG_ID --mode=live --reason="Founder" --apply
bun run billing:pro revoke --org=ORG_ID --mode=live --reason="Access ended" --apply

Grant and revoke preview by default. --apply explicitly executes the Stripe changes.
Requires DATABASE_URL, STRIPE_SECRET_KEY and STRIPE_PRO_PRICE_ID for the same deployment.
The database connection is read-only; signed Stripe webhooks synchronize access.
Use bun --env-file=apps/web/.env.billing-admin run billing:pro ... for operator credentials.
`;

export function parseOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      org: { type: "string" },
      email: { type: "string" },
      mode: { type: "string" },
      reason: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return null;
  const action = positionals[0];
  if (positionals.length !== 1 || !["grant", "inspect", "revoke"].includes(action))
    throw new BillingAdminError("Choose grant, inspect or revoke. Use --help for examples.");
  if (values.mode !== "test" && values.mode !== "live")
    throw new BillingAdminError("Specify --mode=test or --mode=live.");
  if (
    (!values.org && !values.email) ||
    (values.org && values.email) ||
    (values.email && action !== "inspect")
  )
    throw new BillingAdminError(
      "Specify --org, or use inspect --email to find owned organizations.",
    );
  if (action === "inspect" && values.apply)
    throw new BillingAdminError("Inspect is read-only; omit --apply.");
  if (action !== "inspect" && (!values.reason?.trim() || values.reason.length > 500))
    throw new BillingAdminError("Provide --reason (1–500 characters).");
  return { ...values, action } as Options & { org?: string; email?: string };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.log(help);
    return;
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new BillingAdminError("DATABASE_URL is required.");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
  });
  await client.connect();
  try {
    await client.query("begin read only");
    await client.query("set local lock_timeout = '10s'");
    if (options.email) {
      const organizations = await client.query(
        `select o."id", o."name", "organizationPlan"(o."id") as tier
        from "organization" o join "member" m on m."organizationId"=o."id" join "user" u on u."id"=m."userId"
        where lower(u."email")=lower($1) and 'owner'=any(string_to_array(m."role", ',')) order by o."name",o."id"`,
        [options.email],
      );
      console.log(
        JSON.stringify({ email: options.email, ownedOrganizations: organizations.rows }, null, 2),
      );
      return;
    }
    // Serialize scripts, Checkout and webhook synchronization for this org.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [options.org]);
    const row = await client.query<Organization & { selfHosted: boolean; trusted: boolean }>(
      `select o."id",o."name",b."stripeCustomerId",b."stripeSubscriptionId",b."stripeCheckoutSessionId",
      (select u."email" from "member" m join "user" u on u."id"=m."userId" where m."organizationId"=o."id"
        and 'owner'=any(string_to_array(m."role", ',')) order by m."createdAt",m."id" limit 1) as "ownerEmail",
      (select "selfHosted" from "billingDeployment" where "id"=true) as "selfHosted",
      exists(select 1 from "billingPlanPrice" where "priceId"=$2) as trusted
      from "organization" o left join "organization_billing" b on b."organizationId"=o."id" where o."id"=$1`,
      [options.org, process.env.STRIPE_PRO_PRICE_ID ?? ""],
    );
    const org = row.rows[0];
    if (!org?.ownerEmail) throw new BillingAdminError("Organization or owner not found.");
    if (org.selfHosted !== false)
      throw new BillingAdminError("Hosted billing is not enabled on this database.");
    if (!org.trusted)
      throw new BillingAdminError(
        "STRIPE_PRO_PRICE_ID is not registered as a trusted Pro Price on this database.",
      );
    const key = process.env.STRIPE_SECRET_KEY,
      priceId = process.env.STRIPE_PRO_PRICE_ID;
    if (!key || !priceId)
      throw new BillingAdminError("STRIPE_SECRET_KEY and STRIPE_PRO_PRICE_ID are required.");
    if (!key.startsWith(`sk_${options.mode}_`) && !key.startsWith(`rk_${options.mode}_`))
      throw new BillingAdminError("Stripe key does not match --mode.");
    const result = await manageComplimentaryPro(
      new Stripe(key, { maxNetworkRetries: 1, timeout: 15_000 }),
      org,
      options,
      priceId,
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(
      error instanceof BillingAdminError
        ? error.message
        : "Billing command failed. Verify the target and credentials, then inspect Stripe before retrying.",
    );
    process.exitCode = 1;
  });
