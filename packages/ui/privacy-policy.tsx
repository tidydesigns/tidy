import type { ReactNode } from "react";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function PrivacyPolicy({ accountUrl }: { accountUrl: string }) {
  return (
    <article className="tidy-privacy-policy">
      <header>
        <h1>Privacy policy</h1>
        <p className="policy-date">Last updated: 15 October 2026</p>
        <p>
          This notice covers tidydesign.co, the hosted Tidy app, registration, login and connected
          features. Sean Dowdall, an individual based in Ireland, operates Tidy and is the
          controller for account administration, security, support and the PostHog processing
          described below. Contact{" "}
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
          for applicable accounting, tax and data-protection duties. Optional browser analytics,
          replay and diagnostics rely on consent (Article 6(1)(a)); refusing or withdrawing consent
          does not prevent account access. Our legitimate interests are protecting users and
          operating a reliable service; processing must be necessary and proportionate. You can
          object as explained below.
        </p>
        <p>
          Account details and authentication are needed to provide account access. Payment and
          integration information is needed only for the corresponding features. We do not sell
          personal data or use it for third-party advertising.
        </p>
      </section>

      <Section id="posthog" title="PostHog: server monitoring and optional browser features">
        <p>
          Tidy supports PostHog, Inc. for server fault monitoring and optional analytics, feature
          flags, browser diagnostics and session replay in the app when these features are enabled.
          The marketing website does not load the PostHog browser SDK. Core server monitoring and
          optional browser collection have different purposes and controls.
        </p>
        <p>
          <strong>Core server fault monitoring — legitimate interests.</strong> When enabled, we
          report failed or stalled server requests and operations to find faults and restore a
          reliable service. Reports contain a limited error category, code file names and
          line/column locations, route templates, operation type, timing/status information, release
          details and a random server-generated correlation identifier. This reporting does not read
          or set browser cookies, and does not include your account ID, email, browser/session
          identifiers, replay links, client IP address, request bodies, raw error messages or
          credentials. It does not create a person profile. PostHog necessarily receives connection
          information from our server. Core server reporting operates independently of optional
          browser consent. You can object to any processing of your personal data on this basis by
          emailing <a href="mailto:seandowdall22@gmail.com">seandowdall22@gmail.com</a>; we assess
          objections under the rights described below.
        </p>
        <p>
          <strong>Optional browser features — consent.</strong> In the app, including login and
          sign-up, optional collection starts only for the purposes you turn on in{" "}
          <strong>Privacy choices</strong>. Rejecting, closing the dialog or doing nothing leaves
          unselected purposes off. You can accept all, reject all or change each purpose separately.
        </p>
        <dl>
          <dt>Usage analytics</dt>
          <dd>
            Page visits, selected interactions, feature-use events and counts help us understand
            adoption and improve the product. PostHog may evaluate feature flags and show optional
            surveys. Survey answers are sent only when you submit them; please do not include
            secrets or sensitive information. Automatically captured interactions exclude element
            text, field values and DOM attributes.
          </dd>
          <dt>Session replay</dt>
          <dd>
            A reconstruction of page structure, navigation, clicks, pointer movements and scrolling
            helps us investigate usability problems. This is not access to your camera or
            microphone. We mask text, input values and element attributes before transmission and
            block forms, images, media, embedded pages and design canvases. Raw network
            request/response bodies, headers and console messages are not recorded. These
            protections intentionally limit what we can see.
          </dd>
          <dt>Browser performance and errors</dt>
          <dd>
            Page-loading and interaction measurements, redacted browser errors, console-error
            categories and operation timings help us diagnose faults. Browser error messages and
            contents are removed. PostHog request tracing is not enabled.
          </dd>
        </dl>
        <p>
          For optional browser features, events contain a random browser/device identifier, session
          identifiers, timestamps, browser/operating-system type and version, screen/viewport
          dimensions and app version. When you are signed in and allow any optional purpose, we
          create or update a PostHog person profile using your Tidy account ID and email. This links
          the activity you allow, including session recordings if you allow replay, to your account
          so we can understand usage and investigate reported problems. We do not send your name as
          a profile property. Identification does not turn on any purpose you have declined. Before
          sign-in, consented activity uses a browser identifier and can be associated with your
          account when you subsequently sign in in the same session. Page URLs are reduced to route
          templates; query strings, fragments and individual file identifiers are removed. The
          receiving infrastructure necessarily processes connection information to deliver requests;
          IP storage/geolocation is disabled in the app and the reviewed project settings enable IP
          anonymisation.
        </p>
        <p>
          PostHog also receives configuration requests needed for the optional features you enable.
          We restrict collection in the application as well as through project settings. Source
          maps, when uploaded for diagnostics, describe application code rather than being a
          separate user-tracking feature.
        </p>
        <p>
          Our production project is on PostHog EU Cloud, whose core storage is in Frankfurt,
          Germany. This does not mean all support, transit or subprocessor processing takes place in
          the EU. PostHog’s <a href="https://posthog.com/dpa">data processing agreement</a> and{" "}
          <a href="https://posthog.com/subprocessors">subprocessor register</a> describe its
          processing and transfer arrangements. We have signed PostHog’s data processing agreement.
        </p>
        <p>
          Open <strong>Settings → Privacy</strong> in the app to withdraw one or all purposes.
          Before signing in, use <strong>Privacy choices</strong> below the sign-in form. Withdrawal
          stops new collection for that choice and resets the optional client; rejecting all also
          removes accessible PostHog storage. Provider erasure is a separate process and is not
          instantaneous. Where you withdraw consent and we have no other lawful basis or applicable
          exception for keeping the affected personal data, we must erase it without undue delay.
          You can also contact us to request erasure of identifiable history without deleting your
          Tidy account. Clearing browser storage or using another browser/device requires a new
          choice. Changes are recorded with Tidy so withdrawals can be reviewed for applicable
          provider erasure. If confirmation fails, optional collection stays off and the app offers
          a retry.
        </p>
      </Section>
      <Section id="cookies" title="Cookies and similar storage">
        <p>
          Cookies and local/session storage can remember information in your browser. The same
          privacy choices apply to optional collection whether or not a particular request uses a
          cookie.
        </p>
        <dl>
          <dt>Sign-in and security — necessary</dt>
          <dd>
            Better Auth session and short-lived authentication-flow cookies maintain your login and
            protect verification and connected sign-in. They are not used as permission for
            analytics. Login sessions normally expire after seven days and can be renewed while you
            use the app. Temporary authentication cookies expire when their flow ends or times out.
            Blocking essential cookies may prevent sign-in.
          </dd>
          <dt>Privacy choices — necessary</dt>
          <dd>
            The host-only <code>tidy_consent</code> cookie records this notice’s consent version,
            the time and each choice for 180 days. A separate HttpOnly receipt cookie, lasting up to
            one year, links your browser to the server record of your choice; it does not authorise
            tracking by itself. A local-storage change marker synchronises open tabs. Existing or
            older consent versions do not silently opt you into new purposes.
          </dd>
          <dt>Preferences — functional</dt>
          <dd>
            Theme, editor layout, recent colours and local preferences remember choices you make.
            Tab-based draft text uses session storage. The theme cookie is limited to the extension
            endpoint and can last one year; local preferences remain until changed or cleared. These
            are not advertising identifiers.
          </dd>
          <dt>PostHog identifiers — optional</dt>
          <dd>
            Only after an optional choice, a host-only <code>ph_…_posthog</code> cookie stores the
            identifier and SDK state used for the selected purposes, including the email profile
            property when signed in, with a maximum configured lifetime of 180 days, refreshed by
            the SDK. Session storage may hold session/window state until the tab closes. The consent
            expiry still stops collection even if SDK storage remains. Browser storage lifetime is
            separate from retention of data already received by PostHog.
          </dd>
        </dl>
        <p>
          The marketing website has no optional analytics or advertising cookies. Hosting/security
          providers may use storage needed to deliver or protect a requested service. You can also
          remove or block storage in your browser settings; doing so does not itself erase
          provider-held records.
        </p>
      </Section>

      <section id="providers" aria-labelledby="providers-title">
        <h2 id="providers-title">Providers and sharing</h2>
        <ul>
          <li>
            <strong>Cloudflare:</strong> website/app hosting, request handling, database transit,
            image and file storage, collaboration/authentication state, service email delivery and
            operational logging.
          </li>
          <li>
            <strong>PostHog:</strong> limited server fault monitoring and the optional browser
            analytics, diagnostics, replay, feature flags and survey responses described above.
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
            <strong>Linear:</strong> if you connect its integration, we exchange authorised account,
            workspace, issue and comment information to carry out your requests. Tidy stores the
            connection credentials and related application records. See{" "}
            <a href="https://linear.app/privacy">Linear’s privacy notice</a>.
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

      <Section id="posthog-retention" title="PostHog retention and deletion">
        <p>
          Tidy records your privacy choices, notice version and timestamps with a random browser
          identifier and, when signed in, your account ID. These first-party consent records and
          completed cleanup receipts are scheduled for removal after one year. Account deletion also
          removes linked consent records. Recording a rejection does not send data to PostHog.
          Withdrawal and expiry create a task for applicable provider deletion. We keep these
          records to meet our data-protection obligations.
        </p>
        <dl>
          <dt>Session recordings</dt>
          <dd>
            Our configured replay retention is 30 days, subject to earlier applicable deletion.
            PostHog can take additional time to complete removal. Changes to this setting apply to
            new recordings; existing recordings keep their original retention period.
          </dd>
          <dt>Usage events, feature-flag activity and survey responses</dt>
          <dd>
            We use PostHog’s standard event-storage settings. Our paid plan makes events available
            for seven years. This is a query window, not a guaranteed deletion deadline; we have not
            configured a shorter automatic event-deletion period. We use this history to understand
            feature adoption, compare product changes and follow up on survey feedback.
          </dd>
          <dt>Errors and performance information</dt>
          <dd>
            Exception and performance events use the same event-storage settings. We use their
            history to investigate faults, verify fixes and monitor recurrence and reliability over
            time. Marking an issue resolved does not delete its history; recurring errors can reopen
            it. Separate error-issue records are not covered by the event query window. Core server
            reports are not linked to your account, so deleting a person profile does not remove
            them.
          </dd>
          <dt>Person profiles</dt>
          <dd>
            Profiles link your account ID and email to the optional activity you allow. Tidy does
            not set a separate automatic expiry for profiles or error-issue records. We retain
            identifiable information only while needed for the purposes described in this notice.
          </dd>
        </dl>
        <p>
          We remove personal data when it is no longer needed or earlier where required by account
          deletion, consent withdrawal or another applicable request. Sean handles PostHog deletion
          manually using its controls, with provider assistance where needed. Account deletion
          includes this follow-up; you do not need a second request. We check associated profiles,
          events, recordings and other relevant records. Deletion can complete asynchronously;
          accepting a request does not mean removal has finished.
        </p>
      </Section>

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
          contact us if they prevent access. We do not make solely automated decisions with legal or
          similarly significant effects about you. We update the date above when this notice changes
          and provide further information before materially changing processing purposes.
        </p>
      </section>
    </article>
  );
}
