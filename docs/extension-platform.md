# Extension and platform integration

The extension uses the signed-in platform session and its configured app origin.
Capturing does not grant additional workspace privileges: the selected account,
verified email, editing role, active file, and workspace relationship are checked
on the server. The source page cannot choose a platform endpoint or access the
session cookie. Mutation requests require an explicitly allowed extension origin
and the extension request header.

## Import and recovery contract

`POST /api/extension/import` accepts the web import payload plus
`request: { id: UUID, createdAt: milliseconds }`. Generate these once per capture.
The server binds that identity to the authenticated owner, workspace, and a hash
of the validated payload. Reusing an identity with different content is rejected.
A concurrent duplicate returns HTTP 202 while the original is processing; a
completed duplicate returns the stored result.

`GET /api/extension/import/:id` returns `pending`, `failed`, or `done` with the
result. It rechecks the owner and current editing authority on every read. A
missing, expired, inaccessible, or archived destination returns 404. A 404 or
network error does **not** prove that the original import failed.

The result metadata is written to `designImport.requestResult` in the same
transaction as the design. Receipts contain file/layer identifiers and warnings;
staged document content is cleared when an import commits or is aborted. Receipts
share the existing import quotas and expire 24 hours after the fixed request
timestamp (including the accepted clock skew). Failed capture receipts are
retained until expiry so a replay cannot restart failed work. Expired records are
cleaned during subsequent import admission, so expiry is an access deadline,
not a guarantee of physical deletion at precisely 24 hours. Deleting the owning
account, workspace, or destination also removes its import records.

The original request timestamp must be less than 24 hours old and no more than
five minutes ahead of the server clock. Clients must never refresh a timestamp or
allocate a new ID as an automatic retry. The extension persists only the request
identity and job metadata in session storage before upload, then uses GET to
recover after an ambiguous response or service-worker restart. It does not
persist the capture body or automatically replay it. Browser shutdown or extension
reload clears session storage; inspect the destination before copying again in
that case. Chrome explicitly advises persisting job state to handle unexpected
[service-worker termination](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

The server still processes the import within the request; this is an outcome
receipt, not a background queue or automatic resume mechanism. A terminated
server request may remain pending until expiry. Users see an unconfirmed outcome
and can check it again. An explicit new capture is a new operation.

## Resource and performance boundaries

A capture is bounded to 16 MB of UTF-8 JSON, 5,000 layers, and 100 supplied images,
with existing per-image/storage limits. Only referenced images are uploaded, and
identical MIME/base64 images are uploaded once. The complete document is staged
in one write; publication validates the document, assets, and expected revision
inside the existing transaction. Concurrent edits cause a conflict rather than
being overwritten.

The account picker uses one catalog query. Capture-time authorization checks only
the selected destination. Existing documents are not downloaded merely to read a
revision. Account/receipt reads have an additional account operation budget on the
Cloudflare deployment. The extension limits decoded platform responses to 4 MB,
honors `Retry-After`, and does not poll indefinitely. Destination catalogs currently
remain unpaginated; very large catalogs fail safely at the response cap and may
need a separately designed search/pagination experience.

## Local validation and release order

Run `bun run test:extension:db` from the repository root. It starts a disposable
localhost PostgreSQL cluster, applies migrations, and executes actual authenticated
route and transaction tests using a restricted application role. It never uses the
app's configured database. PostgreSQL utilities and Bun must be available on PATH.

Apply `migrations/20261029-extension-import-receipts.sql` before deploying the
platform changes. Existing table grants cover the new columns; both local setup
scripts include the migration. Then deploy the platform and build the extension
with an explicitly selected HTTPS `WXT_BELLA_URL`. Configure `BELLA_EXTENSION_IDS`
to match the intended Chrome Web Store identity. Existing extension builds without
the request identity are rejected by this version of the import endpoint, so the
platform and extension must be released together for the initial release.
Production migration and deployment require the operator's separate approval.

Before store submission, exercise actual Chrome installation permissions, login
cookies, account switching, native screenshot APIs, worker suspension, large
imports, offline recovery, and multi-editor conflicts against the intended app.
The disposable route tests do not replace a real Chrome/platform acceptance run.
