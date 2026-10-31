# Desktop agent tools

The desktop host exposes a private MCP connection to each managed agent session. Parent conversations show delegated assignments beside their initiating turn. Started children open as ordinary live conversations with navigation back to their parent. There is no separate service to configure or public MCP endpoint.

The host owns permissions, task admission, durable results, and design writes. The native harness continues to own inference, its built-in tools, and its permission prompts. These application tools complement those native tools; their scope restrictions do not sandbox the harness's other filesystem or shell tools.

## Tool surface

| Tool            | Purpose                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `tidy_context`  | Current project, thread, attached design IDs, permissions, and limits      |
| `threads_find`  | Paginated title search within the current project                          |
| `thread_read`   | Bounded message pages from a project thread                                |
| `thread_send`   | Deduplicated work for an owned child or explicitly enabled ordinary thread |
| `task_delegate` | Persist and admit a worker assignment                                      |
| `task_read`     | Read this thread's task states and bounded results                         |
| `task_cancel`   | Cancel an owned assignment                                                 |
| `canvas_read`   | Versioned layer search, structure, and selected properties                 |
| `canvas_edit`   | Atomic semantic layer operations and conservative undo                     |
| `canvas_render` | Isolated PNG preview from the shared design renderer                       |

Input and output schemas are the authoritative contract. Every continued canvas node, page, or token read requires the original expected_version to prevent mixing revisions. Outputs are validated before delivery; PNGs remain native MCP image content. `tidy_context` reports the current harness, requested and provider-reported model, reasoning effort, effective permissions, execution project, and parent lineage. Unreported provider defaults remain explicitly unknown. Discovery is available to authenticated idle sessions so native harnesses can initialize before their first turn. Operations require live turn authority. Credentials remain in session environment variables, never process arguments or portable project files. Native tool trust is limited to this injected server. Claude receives an exact tool allowlist; its explicit ask-before-changes mode retains native approval for `canvas_edit`. File tools, commands, and other MCP servers retain their existing approval policies.

## Assignments

`task_delegate` accepts a stable UUID `request_id`, a prompt, and optional model, harness, and attached design subset. Repeating identical input returns the same durable task. Reusing an ID with different input is a conflict.

The scheduler permits four active assignments globally, two per project, and 32 queued assignments. Workers cannot delegate further assignments in this version. Delegation resets inherited reasoning effort when the provider or selected model changes. Cross-provider permissions use a conservative mapping; combinations that cannot preserve the permission boundary are rejected. Assignment launch rechecks the parent's current authority and design access.

`thread_send` admits a durable run on an owned child, or on an ordinary thread whose user has enabled incoming work. Ordinary sends never create child lineage and only root callers may send them. Incoming work is blocked by default; private receiver grants rotate after revocation, and queued work rechecks that grant, open state, design scope and permissions before launch. It uses the same concurrency limits as initial delegation and cannot overlap another run on that child. Each run has its own task ID and result; earlier results remain stable. Cancelling an original assignment also requests cancellation of subsequent active or queued runs on its child, with confirmation reported separately from the original result.

Stopping a parent cancels its accepted active and queued assignments. Completed worker summaries are untrusted reported data, queued back to the parent with a stable message ID. The host deduplicates delivery. Stopped or archived parents are not silently resumed. Delivery rechecks the original parent permission grant, retries transient failures with bounded backoff, and runs in the background during startup. Portable queue files cannot grant execution authority: the host privately binds queued contents and their permission ceiling. Imported or legacy queued messages require an explicit user action; modified authorized messages fail closed.

Task records and edit receipts live in a private SQLite worker database under the desktop application data directory, outside portable projects. Restart marks unfinished assignments interrupted rather than submitting their prompts again. App updates stop scheduler-owned executions and exclude them from ordinary thread auto-resume, so cancelled assignments cannot restart outside the scheduler. The parent can issue a new assignment when needed. Completed results awaiting delivery survive restart. If completion persistence fails while the backend remains alive, execution slots and final thread events are still released; a bounded in-memory reconciliation backlog retries the original terminal result without rerunning inference. This backlog does not claim crash durability before storage succeeds.

Rich task and canvas receipt tables each have a 10,000-record ceiling. Capacity pressure compacts only delivered terminal results and completed edit receipts older than 30 days. Immutable compact records retain task/request identity, child ownership, permission grants and content hashes; uncertain receipts and unfinished or undelivered work remain intact. Retried archived tasks return their original terminal identity with an archive notice. Expired canvas receipts return a conflict instead of replaying an edit or claiming undo is available. Compact identities have a combined 100,000-record safety ceiling; reaching it rejects new requests without evicting retry protection.

Worker failures reject uncertain operations without replay and permit bounded recovery; recovery inside the same live backend preserves running providers, while a new backend interrupts unfinished work.

Delegates use the parent's registered execution project. Separate execution worktrees are not implemented by these tools.

## Delegation interface

The parent transcript shows a bounded, collapsible group of provider logos and child thread titles, with one row per child even across repeated follow-ups. Child conversations do not appear in sidebar navigation, search, Done, or ordering. Opening a child keeps its parent highlighted and provides a persistent breadcrumb back to that parent. Ordinary thread sends appear in a separate thread group; those recipients stay in the sidebar.

Each ordinary thread has an incoming-work permission menu, blocked by default. Receiving grants are bound to the registered storage path and require renewed opt-in after a move; copied projects receive fresh identities. Incoming messages link to their source using private task IDs and matching content hashes, never provenance supplied by portable project files.

Queued assignments appear immediately with keyboard-discoverable identities; they become navigable once the child conversation exists. Each active destination has a focused Stop action with immediate feedback and retry recovery. Actionable states appear beside the affected title. Fresh views include unfinished assignments independently of historical pagination. Selecting a row uses the existing thread view, retaining the parent transcript and scroll position. Native approvals remain in the child conversation; its parent sidebar row and agent group surface that attention state. The parent's agent-approval action opens the affected child directly, independently of task history pagination. Follow-up runs retain separate results, and older assignments load on demand.

The renderer reads a typed, project-authorized `thread-tasks` host operation. It receives only display data and parent navigation, not private grants or native session state. Task state transitions publish compact sequence notifications using the existing thread-summary event channel. Visible conversations coalesce refreshes; ordinary streamed child events do not query task storage. Reopening a conversation or reconnecting refreshes its task view. The interface does not require another MCP tool. Loaded older nonterminal rows refresh with bounded ID reads on task invalidation; completed history is immutable. Private lineage and receiver projections are loaded once at host initialization and updated on admission, so streaming events perform constant-time lookups without database reads.

## Bounded reads

`thread_read` pages both messages and their text. Resume with the returned `next_after` and `next_text_offset` together: a partial message keeps its message index and advances the text offset. This allows long transcripts to be read completely without oversized responses.

`canvas_read` supports independent node, token, and page cursors. Token pages include design tokens and reusable styles. Continue with the returned offsets and the same `expected_version` so pages cannot silently mix document versions. Read responses are capped at 128 KiB, and individual oversized entries return an actionable error. Task result pages are also byte-bounded and report truncation.

Authenticated requests have deadlines and bounded admission. JSON-RPC batches are rejected so one HTTP request cannot multiply admission. Disconnects and deadlines release request and rendering capacity.

## Canvas transactions

Read a design before editing it. Pass its exact `version` as `expected_version` and use a stable UUID `request_id` for the transaction. A batch supports up to 32 semantic operations: update, add, delete, duplicate, group, ungroup, reparent, reorder, align, and distribute. Creation and editable properties deliberately expose a compact subset of the full document schema.

The host validates the complete result before writing, checks the version again after worker computation, and rechecks authority immediately before persistence. The final version check follows asynchronous authority checks and runs immediately before the atomic rename. Conflicting observed edits produce an actionable conflict. Filesystem replacement remains an optimistic check; arbitrary external writers do not participate in a shared database transaction. Read again and construct a new transaction rather than replacing the document blindly.

Successful edits return `undo_available`. To undo, send a new transaction containing only `{ "kind": "undo", "request_id": "<original transaction UUID>" }`. Undo requires the current design version to equal that original transaction's result. It cannot undo through intervening human or agent changes. Undoing that undo supports redo. This tool history is separate from the editor's keyboard undo history.

A pending receipt is persisted before the design write. If a crash leaves its outcome uncertain, retry reports that uncertainty instead of repeating the edit. Receipt size limits can reject a large batch before any design write; split it into smaller transactions.

Canvas preparation, diffing, validation, encoding, and markup generation use persistent workers. Reads and acknowledgements avoid copying complete designs unnecessarily. Metadata enumeration uses a bounded shared worker pool so large projects are not silently truncated under worker pressure. Canvas commit acknowledgements schedule coalesced project refreshes without waiting for unrelated scans. Previews use a separate browser context with scripts and network access disabled. Fonts may fall back to locally installed families; interactive behavior is not rendered. PNG output is limited to 2 MB, dimensions to 4096 pixels, and total pixels to 16 million. A cold browser installation can exceed the tool deadline; retry after initialization. Request cancellation releases its rendering slot even during shared browser startup, and contexts created after cancellation are closed.

## Validation

From the repository root:

```sh
bun typecheck
bun lint
bun test
bun run build:desktop
bun run audit:dependencies
TIDY_TEST_CANVAS_BROWSER=1 bun test apps/desktop/src/main/orchestration/render-service.test.ts
```

Desktop tests include a real Node execution of the embedded worker. Orchestration integration tests use the actual workspace, HTTP MCP transport, SQLite, and compute workers, replacing only the provider launcher. They do not incur model inference. The optional render test runs Chromium and checks actual PNG output.

For existing Electron interaction checks, run `bun run --cwd apps/desktop test:threads` and `bun run --cwd apps/desktop test:browser`. The transcript check supports Linux hosts without a display.
