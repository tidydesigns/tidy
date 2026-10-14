export function PrivacyPolicy({ accountUrl }: { accountUrl: string }) {
  return (
    <article className="tidy-privacy-policy">
      <header>
        <h1>Privacy policy</h1>
        <p className="policy-date">Last updated: 14 October 2026</p>
        <p>
          This notice covers tidydesign.co, the hosted Tidy app, registration, login and connected
          features. Sean Dowdall, an individual based in Ireland, operates Tidy and is the
          controller for account administration, security and support. Contact{" "}
          <a href="mailto:seandowdall22@gmail.com">seandowdall22@gmail.com</a> about privacy.
        </p>
        <p>
          For personal data an organisation places in its workspace, that organisation may be the
          controller and Tidy processes the content on its instructions. Independently self-hosted
          installations have their own operators and privacy arrangements.
        </p>
        <nav aria-label="Privacy policy sections">
          <a href="#data">Information and purposes</a>
          <a href="#posthog">Cookies and PostHog</a>
          <a href="#providers">Providers</a>
          <a href="#retention">Retention</a>
          <a href="#rights">Your rights</a>
        </nav>
      </header>

      <section id="data" aria-labelledby="data-title">
        <h2 id="data-title">Information and purposes</h2>
        <ul>
          <li>
            <strong>Accounts:</strong> name, email, avatar, verification status, password hash or
            connected sign-in account, sessions, permissions and organisation membership. We use
            these to register and authenticate you and administer your account.
          </li>
          <li>
            <strong>Your work:</strong> designs, images, imports, versions, comments, invitations
            and collaboration records. We store and share them with people authorised to access the
            workspace. Invitees’ information comes from the person inviting them.
          </li>
          <li>
            <strong>Support:</strong> feedback, attachments and correspondence you send us, to
            respond to enquiries and investigate reported problems.
          </li>
          <li>
            <strong>Payments and integrations:</strong> billing identifiers, subscription status,
            connected-account identifiers, authorisation tokens and content involved in features you
            choose to use. Sign-in and integration providers supply the information authorised
            through their flows.
          </li>
          <li>
            <strong>Technical records:</strong> IP addresses, browser information, request URLs,
            timestamps, errors and security or connection metadata. Tidy and its infrastructure
            providers process these to authenticate requests, prevent abuse and diagnose faults.
            Diagnostics can include information present in URLs, queries or error messages.
          </li>
        </ul>
        <p>
          We rely on performance of a contract (GDPR Article 6(1)(b)) for the service you request;
          legitimate interests (Article 6(1)(f)) for security, reliability, support and
          administering access to an organisation’s service; and legal obligations (Article 6(1)(c))
          for applicable accounting, tax and data-protection duties. Our legitimate interests are
          protecting users and operating a reliable service; processing must be necessary and
          proportionate. You can object as explained below.
        </p>
        <p>
          Account details and authentication are needed to provide account access. Payment and
          integration information is needed only for the corresponding features. We do not sell
          personal data or use it for third-party advertising.
        </p>
      </section>

      <section id="posthog" aria-labelledby="posthog-title">
        <h2 id="posthog-title">Cookies and PostHog</h2>
        <p>
          We do not currently use PostHog for analytics, error tracking, session replay, tracing or
          feature flags. We will update this notice and obtain any required consent before
          introducing optional tracking.
        </p>
        <p>
          The app uses authentication and security cookies, temporary sign-in state and browser
          storage for settings such as theme, editor layout, recent colours and draft text. Login
          sessions normally expire after seven days and can be renewed while you use the app.
          Preference cookies last up to one year; local preferences remain until changed or cleared,
          and tab-based drafts use session storage. Your browser lets you clear this storage;
          blocking authentication cookies can prevent login. Operational logging by Cloudflare
          remains separate from PostHog.
        </p>
      </section>

      <section id="providers" aria-labelledby="providers-title">
        <h2 id="providers-title">Providers and sharing</h2>
        <ul>
          <li>
            <strong>Cloudflare:</strong> website/app hosting, request handling, database transit,
            image and file storage, collaboration/authentication state, service email delivery and
            operational logging.
          </li>
          <li>
            <strong>PlanetScale:</strong> the database holding account, workspace and application
            records, including connected-account credentials. Better Auth runs within Tidy using
            this database.
          </li>
          <li>
            <strong>Google and GitHub:</strong> when you choose their sign-in options, we receive
            authorised profile and account information. GitHub also handles authorised repository,
            pull-request and review exchanges when you connect its integration. Their own privacy
            notices govern their services: <a href="https://policies.google.com/privacy">Google</a>{" "}
            and{" "}
            <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
              GitHub
            </a>
            . Google also provides the Gmail inbox used for privacy and support correspondence.
          </li>
          <li>
            <strong>Stripe:</strong> when you use paid features, Stripe processes payment details
            directly. Tidy sends the billing email and organisation identifier and stores customer,
            subscription and checkout references and status, rather than full card details. See{" "}
            <a href="https://stripe.com/ie/privacy">Stripe’s privacy notice</a>.
          </li>
          <li>
            <strong>MCP clients you authorise:</strong> receive the design information and tool
            results allowed by your permissions. An AI client may send that information to its own
            provider under its settings and terms. Tidy provides MCP access, not hosted AI
            inference. You can revoke client access in the app.
          </li>
        </ul>
        <p>
          Workspace members can see content and profile information within their permissions. We may
          also disclose relevant information when legally required or necessary to establish or
          defend legal claims. Providers may use subprocessors and may act as independent
          controllers for their own security, legal or account purposes.
        </p>
        <p>
          The primary database is in Dublin. Providers can also process data outside Ireland and the
          EEA, including in the United States; this service does not promise EU-only processing. The{" "}
          <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare</a> and{" "}
          <a href="https://planetscale.com/legal/data-processing-addendum">PlanetScale</a> data
          processing terms provide for EU Standard Contractual Clauses for relevant restricted
          transfers. Contact us for information about the safeguards applicable to your data.
        </p>
      </section>

      <section id="retention" aria-labelledby="retention-title">
        <h2 id="retention-title">Retention and deletion</h2>
        <p>
          We retain account and workspace records while needed to provide or administer your account
          or retain shared work. They can be deleted through the relevant account/workspace controls
          or an applicable request, and must be removed when no remaining purpose or lawful
          retention ground requires them. There is currently no automatic expiry for inactive
          accounts or completed uploads. Feedback and support records are retained while needed to
          handle the enquiry or related issue; there is no fixed automatic expiry. Necessary
          billing, legal and security records may be retained for applicable legal duties or claims.
        </p>
        <p>
          Account deletion removes personal account records, credentials, sessions and memberships.
          Shared designs and related organisation content can remain attributed to “Deleted user”;
          embedded content and versions can still contain personal information. A final owner must
          transfer ownership or delete the organisation first, subject to billing safeguards.
          Uploaded-file and provider cleanup is separate and may require operator follow-up; closing
          an account is not confirmation that every external copy has been erased.
        </p>
        <p>
          Scheduled database backups currently expire after two days. This does not establish a
          deadline for every recovery copy or export. Cloudflare’s stored Worker logs have a maximum
          retention of seven days; other provider records can have different periods. Contact us
          about retained copies or content the account controls cannot remove.
        </p>
      </section>

      <section id="rights" aria-labelledby="rights-title">
        <h2 id="rights-title">Your rights and contact</h2>
        <p>
          You can request access, correction, erasure, restriction, portability or object to
          processing where the relevant conditions apply. If processing relies on consent, you can
          withdraw it without affecting its prior lawfulness. We assess objections to legitimate
          interests and stop the relevant processing unless applicable overriding grounds permit
          continuing.
        </p>
        <p>
          Use the <a href={accountUrl}>account data controls</a> for a JSON export or account
          deletion, with fresh authentication when required. The export excludes passwords and
          tokens and is not a complete response covering every provider or shared record. Export
          complete design files and images from the editor.
        </p>
        <p>
          For other requests, email{" "}
          <a href="mailto:seandowdall22@gmail.com">seandowdall22@gmail.com</a>. We may need to
          verify your identity and normally respond within one month; if a lawful extension is
          necessary, we explain it within that month. You can complain to Ireland’s{" "}
          <a href="https://www.dataprotection.ie/en/contact/how-contact-us">
            Data Protection Commission
          </a>{" "}
          or your local supervisory authority.
        </p>
        <p>
          We use access controls, authentication and transport encryption to protect information. No
          service can guarantee absolute security. Automated checks can limit abusive requests;
          contact us if they prevent access. We do not use profiling or solely automated decisions
          with legal or similarly significant effects. We update the date above when this notice
          changes and provide further information before materially changing processing purposes.
        </p>
      </section>
    </article>
  );
}
