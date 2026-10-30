# Changelog

All notable changes to the `@littlebigbrain/mcp` package are documented here.

## Unreleased

- Requires `@littlebigbrain/client` `^0.32.0`, which has `records.commit` and
  `evals.experiments`. The MCP release, with its lockfile, follows once the
  client is on npm.
- The text of `lbb_files` says that a generated file, one that a workflow run
  wrote, has no Document, expires unless a person keeps it, and is never
  evidence. The tool contract digest changes with the new text.

- `lbb_reviews` names the origin `evals:datasets`: an item that asks if one
  value, which an experiment's arms differ on, is right or wrong. `eval_id`
  keeps the items of one dataset. An answer becomes a label of the dataset's
  item. `lbb_evals` datasets accept `source` (`kind`, `id`, `at`) on a label,
  so an agent can send back an item as it read it. The tool contract digest
  changes with the new text and argument.

- Add explicit `lbb_commit mode=records` using the strict SDK records helper,
  exact body/key/epoch snapshots, existing destructive approval and complete
  receipts. Unknown POST outcomes retain the original key; oversized known
  acceptance remains accepted. No graph activation, conversion or legacy fact
  behavior changes. It uses `records.commit` of client 0.32.0.

- `lbb_files` `pages` names a page that needs OCR (`ocr_required: true`, no
  lines) and counts such pages in its summary, so a scan no longer reads as
  an empty page. The tool contract digest does not change.

- `lbb_evals` has the actions `experiments`, `experiment`,
  `experiments_estimate`, `experiments_create` and `experiments_cancel`. A
  start spends model budget, so the tool tells the agent to show the
  estimate first and to start only what the user confirmed. An experiment
  changes no workflow and no graph. The tool contract digest changes with
  the new arguments.

- `lbb_workflows` actions `revisions` and `revision` return `last_tested` on a
  revision of a `values.extract` workflow, and the description of
  `lbb_workflows_manage` action `activate` tells an agent to say so when it
  is `null`; an experiment's arm adds `experiment` to the fact. No new
  action or parameter.
- `lbb_model_choice_manage` `put_choice` and `lbb_workflows_manage`
  `activate` take `experiment` (`exp_…`): the write applies that
  experiment's B, and the server refuses it with `experiment_outdated`
  when the workflow no longer runs the experiment's A. Neither asks for
  approval, as before. The tool contract digest changes with the new
  argument. Use `experiment` only after every node runs the version with
  experiments: an earlier node ignores it on an activation and skips the
  check of A.

## 0.16.0 (2026-10-26)

- `lbb_inspect action=entity` accepts full RDF IRIs and the opt-in `records/1` view, with exact terms, separate assertions, schema guards and snapshot pins. Complete records exceeding the output budget fail explicitly instead of being compacted. It uses `entities.retrieve` of client 0.31.0.
- Requires `@littlebigbrain/client` `^0.31.0`, which has the methods the new
  tools call: `reviews`, `workflows.tests`, `evals.datasets`,
  `models.choices`, the settings revisions of `workflows.named` and
  `entities.retrieve`.
- The tool schemas are built with Zod 4 (`zod` `^4.6.6`; 0.15 used
  `^3`). Their JSON schemas change in form, so the pinned tool contract
  digest changes too.
- `lbb_model_choice` action `choices` lists the model choices of the
  workflow uses (`extract`, `decide`, `embed`): the environment's, and with
  `workflow` the row in force for each use of that workflow, one page with
  `cursor` and `limit`.
  `lbb_model_choice_manage` actions `put_choice` (`use`, `provider`,
  `model`, `effort`, `workflow`) and `delete_choice` (`use`, `workflow`)
  set and remove a choice. They change only the model of future calls and
  remove no data, so neither asks for approval. `provider` takes `mock` on
  a local server. `lbb_workflows_manage` `tests_create` takes `models`
  (`extract`, `decide`): the test runs on those models. These actions call
  the client's `models.choices` and `models` on tests, which ship in the
  client release after 0.30.0: the MCP release that has them requires
  that client.
- `lbb_workflows_manage` `define` takes one trigger of four: `class` (a
  watch), `media_types` (a content trigger on uploads), `schedule`
  (`{cron, timezone}` or `{every, offset}`, and `jitter`) or `stream`
  (`{max_wait}`: the events a client sends, in batches). A call with none
  or two of them is refused before any request.
- `lbb_workflows` reads the history of a workflow's settings (`revisions`)
  and one revision (`revision`); `lbb_workflows_manage` `activate` uses a
  kept revision again, with `expected_revision`. An activation deletes no
  data and asks for no confirmation.
- `lbb_reviews` `list` and `patterns` take `eval_id`: the items Evals filed
  for one record (a calibration session, a model call's check, a golden).
  Answering such an item (a grade or a choice) asks for no approval.
- `lbb_workflows_manage` `define` takes `budget_usd_per_month` (the
  workflow's own monthly model budget), `on_exhausted` (`block` or `skip`)
  and `fan_in` (the id of the workflow's fan-in identity).
- `lbb_workflows` `queue` pages with `cursor`, the string `next_cursor` of
  the page before, in place of the number `after`. The answer lists the
  items in `data`, with `has_more` and `next_cursor`; `workflows` answers
  one page of the workflows in `data` and takes `cursor` and `limit` too.
- `lbb_configure` `evolve_ontology` `add_property` takes `unit`: the unit of
  an `i64` or `f64` field, for example `mm`, `kg` or `h`. Writers that read
  text, such as `values.extract`, convert numbers to it.
- `evolve_ontology` gains `set_property_unit` (`property`, `unit`; no
  `unit` clears it) and `set_property_constraint` (`property`,
  `allowed_values`; an empty list clears it). `add_property` takes
  `allowed_values`, the values a commit may write to the field.
- The request bodies are checked against the API contract at compile time.
  `lbb_commit` now checks each `entity_embeddings` item (`type`, `name`,
  `model_id`, `vector`, optional `key`, `entity_id` and `metric`) and each
  `evidence` (a string, or `text`, `source_id`, `region` and
  `observation_id`) before it sends the commit. `search_feedback.profile`
  is one of `baseline`, `scored_atom_v1`, `graph_aware_v1` and `ndcg_v1`.
- **Breaking:** a destructive write asks the person first, and it is refused
  when the client cannot ask. With MCP form elicitation, the server shows a
  question that names what the call removes first, with the counts, and one
  confirm box. A decline sends nothing and returns the error
  `approval_declined`. A client without form elicitation (none, or URL
  elicitation only) and the HTTP transport get `approval_required`, and
  nothing is sent. This changes 0.15 callers of `lbb_commit` `mode=retract`,
  of an `lbb_rdf` update that removes, and of the `*_delete` tools. `confirm`
  is no longer an input of the `*_delete` tools: no tool argument lets a
  call through, since the agent sets the arguments. To run these calls
  without a question, as 0.15 did, the person sets
  `LBB_MCP_DESTRUCTIVE=allow` in the MCP server's environment. A Node
  process that runs the server can pass `destructiveWithoutApproval:
  "allow"` instead.
- **Hosted endpoint:** its HTTP transport cannot ask the person, and the
  service does not set `LBB_MCP_DESTRUCTIVE`. So the hosted MCP endpoint
  answers every destructive call with `approval_required`, whose message
  names the console and the SDKs as the way to make that change. The
  reason: a setting on the server is the only switch an injected prompt
  cannot turn. A later release adds an option a person turns on for one
  API key.
- These calls ask: `lbb_embeddings_delete`, `lbb_fit_sources_delete`,
  `lbb_workflows_delete` and `lbb_evals_delete`; `lbb_commit`
  `mode=retract`, with the links and records it removes; `lbb_rdf` an update
  with `DELETE`, `CLEAR`, `DROP`, `MOVE` or `COPY`, with each operation that
  removes quoted first; `lbb_configure` `evolve_ontology` with
  `remove_entity_type`, `remove_relation`, or `narrow_relation` with
  `remove_domain` or `remove_range`, and `publish_schema` with
  `desired_mode: "reject"`; `lbb_reviews_manage` `answer` and
  `answer_batch` that accept or correct a `value` item or accept a `change`
  item, with the count and the effect (the server reads the items and their
  changes first). A preview (`dry_run`) does not ask. A question escapes
  newlines and other control characters in names, so a name cannot add
  lines of its own.
- `lbb_commit`, `lbb_configure` and `lbb_reviews_manage` are marked
  `destructiveHint: true`. The hint names the most a call of the tool can
  do: an `lbb_commit` retract removes facts, an `evolve_ontology` can remove
  types and relations, and accepting a review item commits facts or applies
  an ontology change. So `lbb_commit` stays destructive, although most of
  its calls add facts.
- The server logs one JSON line per tool call to standard error: the tool,
  its action, the outcome, the error code, the approval decision and the
  JSON-RPC request id. A line holds no arguments, names or texts. The `log`
  server option receives the events instead.
- Inputs are no stricter than the server: the `evidence` and
  `entity_embeddings` of `lbb_commit`, the facts of
  `suggest_ontology_change` and the evidence of a review item take `null`
  for an optional field, and pass a field the server does not know through
  (the server ignores it), as 0.15.1 did. So `source_id: null` and
  `key: null` work again. `search_feedback.profile` takes `null`.
- A list page over 80,000 characters (`lbb_reviews` `list`,
  `lbb_workflows` `queue` and `tests`, `lbb_evals` `datasets`) is asked for
  again with the items that fit, so `next_cursor` continues after the last
  item shown. The output had shown 3 items while `next_cursor` pointed after
  the whole page. `next_cursor` is never shortened, and `queue` asks for at
  most the items its `detail` level shows.
- The pinned tool contract (its digest in the tests) changes for the
  `evolve_ontology` unit and constraint operations (#1269) and for this
  release's tools: reviews, workflow tests, Evals datasets and their delete,
  and the approval rule.
- New tools for review items (`/v1/reviews`). `lbb_reviews` reads them:
  `list` (filters `status`, `kind`, `scope`, `origin_id`, `workflow`,
  `run` and `key`; one page with `next_cursor`), `get` (`id`) and
  `patterns`. `lbb_reviews_manage` writes them: `create` (an item of kind
  `value`, `choice`, `grade` or `answer`), `answer`, `answer_batch`,
  `comment` and `withdraw`. Each write sends an idempotency key, and a
  retry after a network failure or a 5xx sends the same key, so the write
  happens once. A list page holds at most the items the `detail`
  level shows (5, 20 or 100), so `next_cursor` continues after the last
  item you read.
- Workflow tests: `lbb_workflows` gains `tests` (a page of the graph's
  tests; `name`, `limit`, `cursor`) and `tests_get` (`id`).
  `lbb_workflows_manage` gains `tests_create` (`name` of a workflow of the
  graph, or `install` for one not created yet, and `iris` or `sample`),
  `tests_answer` (`id`, `iri`, `property`, `answer`; `null` removes the
  answer) and `tests_cancel` (`id`). A test writes nothing to the graph.
- Evals datasets: `lbb_evals` gains `datasets` (a page; `limit`, `cursor`),
  `datasets_get`, `datasets_export` (`records` and `expected`, as a
  template's samples), `datasets_create` (`name`, `kind`, `items`,
  `install`, `about`, or `source: {kind: "test", id}`) and `datasets_items`
  (`id`, `items`). `items` takes the examples of a dataset as well as the
  labels of `label`. The new tool `lbb_evals_delete` deletes a dataset by
  `id` once the person approves. It reads the dataset first, so the
  question names the dataset and its item count. A later `datasets_get` or
  `datasets_export` of it answers 404, and the next save of its test makes
  a new dataset.

## 0.15.1 (2026-10-17)

- Require `@littlebigbrain/client` ^0.28.0.

## 0.15.0 (2026-10-16)

- `lbb_files` `list` returns 50 files a call, the newest upload first; when
  more follow, `next` names the `after` of the next call (the new `after`
  input). This release needs a server that pages `GET /v1/files`.
- `lbb_files` `list` takes the filters `parse_status` and `name`.
  `parse_status` is `parsed`, `waiting`, `unsupported` or `failed`. `name` is
  a part of the file name, in any case. A filtered list reads the published
  generation and returns its commit as `as_of_commit_seq`. A file uploaded a
  moment ago can be missing from it until publication. Its `next` repeats the
  filters, because the server binds the cursor to them.
- `lbb_files` `pages` by `name` finds a file of any age. It looks the name up
  with the list's `name` filter. When that list has no exact match, it reads
  the newest 50 files. They hold a file uploaded since the publication.
- Require `@littlebigbrain/client` ^0.27.0 (the `files.list` filters).

## 0.14.0 (2026-10-14)

- Workflows with triggers (`/v1/workflows/named`): `lbb_workflows` gains
  `workflows` (every workflow, or one by `name`, with its target type,
  shards, routing, window, trigger and each shard's inbox) and `queue`
  (what a workflow's watch has not sent yet, with origins; `after`,
  `limit`, `trigger`). `lbb_workflows_manage` gains `define` (a workflow
  of your worker: `shards`, `route_by`, `window`, `trigger`) and `run`;
  `pause` and `resume` without `starter` name a workflow with triggers.
  `lbb_workflows_delete` without `starter` deletes one.
- Require `@littlebigbrain/client` ^0.26.0 (`workflows.named`).

## 0.13.0 (2026-10-13)

- `lbb_evals` gains `run_answers` (`answers`, `runner`): it checks your own
  agent's answers to the question goldens. `results` takes `runner`, and
  `label` takes `route` with an answer label that names the query.
- Require `@littlebigbrain/client` ^0.25.0.
- The `lbb_workflows` and `lbb_workflows_manage` descriptions name
  `values.extract`, the new id of the starter workflow Values from text
  (formerly `infer.llm`, which the server still accepts).
- The `lbb_workflows` description names `documents.map`, the starter
  workflow that proposes the links of `documents.link` as `FactProposal`
  instances in the graph's own ontology.

## 0.12.0 (2026-10-11)

- Require `@littlebigbrain/client` ^0.23.0.
- New tools for starter workflows and triggered workflows: `lbb_workflows`
  (read only: `starters`, `list`, `get`, `preview`), `lbb_workflows_manage`
  (`use`, `refresh`) and `lbb_workflows_delete` (`confirm` must repeat the
  name). A starter workflow is a template; a triggered workflow is created
  from one and follows a class of the graph. `search.embed` and
  `ontology.fit` are the embeddings and fit sources, and their six tools
  stay unchanged.
- Developer workflows: `lbb_workflows_manage` gains `pause` and `resume`,
  and `use` (and the `lbb_workflows` preview) take `workflow`
  (`workflow_type`, `version`), `owns` (`classes`, `relations`,
  `properties`) and `batch` (1 to 64) for the starter workflow `workflow`.
- New read-only tool `lbb_files` for the files of a graph: `list` shows
  each file with its SHA-256, name, size, `Document` IRI and parse status;
  `pages` reads the parsed pages of one file (by `sha256`, or by its exact
  `name`) from `from` to `to` (default one page), each line as
  `<line id> [x0,y0,x1,y1] <text>` with the box normalized to the page.
  `contains` keeps the lines that hold a text, `max_lines` caps the lines
  (default 200, at most 1,000, and about 60,000 characters), and `next`
  names the `from` and `line_offset` of the next call. Needs the client's
  `files` (the next `@littlebigbrain/client` release).
- The `lbb_workflows` description names the document workflows
  (`documents.parse`, `documents.link`) and `infer.llm`.
- `lbb_configure` `suggest_ontology_change` takes `facts` (`triplets`,
  `entity_properties`, `replace_owned`, `summary`): graph facts a person
  confirms, which accepting commits. `change` may then be empty. The
  `lbb_inspect` `ontology_suggestions` description names `fact_count`.

## 0.11.0 (2026-10-08)

Breaking: `lbb_query` with `mode: "question"` always answers in plain words.
The server moved questions to `POST /v1/query/ask` and removed the one-shot
rewrite.

- Require `@littlebigbrain/client` ^0.22.0. (0.11.0 was not published on
  2026-10-06: it waited for this client.)
- New tools for model choice: `lbb_model_choice` (read only: `options`,
  `trials`, `trial`, `trial_call`, `switches`) and `lbb_model_choice_manage`
  (`start`, `stop`, `switch`, `revert`). A trial tests another model on a
  use of a model on the graph (`ask`, `route`, `rerank`, `fit`, `label`)
  against the ground truth of its checked calls; `switch` makes the use run
  a tested model that meets the bar, and the description tells agents to
  switch only what the user confirmed.
- New tools for fit from text: `lbb_fit_sources` (read only: `list`, `get`,
  `preview`), `lbb_fit_sources_manage` (`declare`, `dry_run`, `refresh`) and
  `lbb_fit_sources_delete`. A fit source names the fields of a class that
  hold text; the server reads every record and files ontology change
  suggestions with verified quotes. `dry_run` returns the proposals for up
  to 3 records and files nothing.
- `lbb_query` with `mode: "question"`: `answer.chart` holds the server's
  chart hint for the rows (`kind`, `x`, `y`, `series`) when it gave one.
- Remove the `answer` and `run` arguments of `mode: "question"`. The tool
  refuses them. A question now always runs the server's answer loop and
  returns `answer` (`text` and `citations`, or `null` when the loop stopped
  first) and `steps`, with the route and the query and rows the answer stands
  on. The tool no longer returns a query without running it. To write the
  queries yourself, use `names`, `describe`, `commit_at` and `compare`, then
  `mode: "sparql"`.
- The tool calls `POST /v1/query/ask` and never sends `run` or `previous`.
  `limit` is the rows each query of the loop returns.
- Progress names the route, each step of the loop (its tool, its input, and
  its rows or differences), and the answer. The progress of a written query,
  its run, its rows and its correction is gone. Progress needs the next
  `@littlebigbrain/client` release, which adds `query.askStream`. With an
  older client the tool answers without progress.
- A comparison holds no rows: `history.added`, `history.removed` and
  `history.changed` hold what differs, and `as_of_commit_seq` is the later
  point. The summary says "compared two points".
- The pinned tool-contract digest moves with the removed arguments.
- `lbb_query` gains four modes for writing your own queries, none of which
  calls a model. `names` (`text`, `limit`) finds the IRIs of the names in a
  text, the person before a document that has the person's name. `describe`
  (`question`, or `classes` and `properties` as IRIs) returns the server's
  description of the parts of the graph a question needs: how many sampled
  instances hold each property, and the values of small classes; `detail:
  "full"` adds it as JSON. `commit_at` (`date` or `moment`) finds the commit of
  a date. `compare` (`query`, `before`, `after`, `key`, `max_rows`, `limit`)
  runs one `SELECT` at two points and returns `added`, `removed` and
  `changed` as lexical rows with their `totals`; `next` holds the arguments
  of the next page (`compare_cursor`).
- `lbb_query` with `mode: "question"` keeps a comparison's `history.added`,
  `history.removed` and `history.changed` with `history.totals`. Each list
  shows at most 20, 100 or 500 entries by detail; `history.shown` and a note
  say when a list is cut and how to read it all with `mode=compare`.

## 0.10.0 (2026-10-05)

- `lbb_query` with `mode: "question"` takes `answer: true`. The server then
  answers in plain words after its model ran queries and read their rows (at
  most 4 rounds). The result adds `answer` (`text` and `citations`, or `null`
  when the loop stopped first) and `steps`; the rows are those of the query
  the answer stands on. Progress names each step and the answer.
- Require `@littlebigbrain/client` ^0.20.0.
- `lbb_query` with `mode: "sparql"` describes the SPARQL rerank:
  `search:rerank true ; search:relevance ?r` lets the rerank model (Jev) keep
  the hits that answer the words and binds its answer. When the rerank of a
  query does not apply, `notes` says why and that the relevance is unbound.
- `lbb_query` with `mode: "question"` reports progress. When the tool call
  carries `_meta.progressToken`, the tool reads the rewrite as a stream and
  sends `notifications/progress` for each step: the graph description, the
  route, each query, the run, the rows, and a correction. The tool result and
  its errors stay the same. Cancelling the call stops the server's work.
- Progress needs the next `@littlebigbrain/client` release, which adds
  `query.rewriteStream`. With an older client the tool answers without
  progress. A call without a progress token sends the request as before.
- `lbb_query` with `mode: "question"` takes `anchor`: entity IRIs the
  question is about, at most 10. The server reads each one, and the query
  uses the IRIs directly instead of matching their names.
- The answer holds `linked`, the names of the question the server linked to
  entities, and `anchors`, what it read about each anchored IRI. An anchor
  that is not in the graph adds a note.
- `lbb_configure` gains `get_rewrite_profile` and `set_rewrite_profile`: the
  graph's notes and up to 20 worked examples that `lbb_query mode=question`
  reads for every question. `set_rewrite_profile` takes `expected_version`
  and `dry_run`.
- `lbb_query` with `mode: "sparql"` describes the SPARQL rerank:
  `search:rerank true ; search:relevance ?r` lets the rerank model (Jev) keep
  the hits that answer the words and binds its answer. When the rerank of a
  query does not apply, `notes` says why and that the relevance is unbound.
- `lbb_query` with `mode: "question"` takes `timeline`: dated points that
  stand for the graph's commits (`{date, as_of_commit_seq, label?}`, at most
  200). A question about a date reads the commit of the latest point on or
  before it; without a timeline the server reads the last commit written by
  the end of that day.
- The answer's `history` names the commit the date resolved to and how
  (`resolved_by`). For a question that asks what changed it holds `added`
  and `removed`, the rows that differ, as `{variable: value}`; the rows of
  the answer are the later run. A note says which commit the server read, or
  that it could not place the date. The progress of a comparison names the
  earlier and the later run.
- The pinned tool-contract digest moves with the new argument.

## 0.9.0 (2026-10-04)

- Require `@littlebigbrain/client` ^0.19.0.
- `lbb_query` with `mode: "sparql"` returns the `search` report of a query
  that searches by meaning with a `search:similarTo` pattern: the plan, the
  hits asked for and bound, and `complete`. When `complete` is false, `notes`
  says so. The `query` argument describes the pattern with an example.
- Add `activity` to `lbb_models`. It reads one month of the stack's
  managed-model use (`month`, `yyyy-mm`; the current month by default): calls,
  items, estimated tokens and cost per feature and model, by day and by
  graph, and the model each feature uses now.
- `lbb_inspect` with `action: "entity"` refuses a valid-time `as_of` before
  any request and names `as_of_commit_seq`. It sent `as_of` to the server,
  which answers it with 400.
- `lbb_query mode=search` takes `rerank`: `true` orders the best hits by the
  managed rerank model (Jev), each hit with its `relevance`; `false` keeps
  the similarity order. Without it the graph's search setting decides.
- Add `mode: "question"` to `lbb_query`, for an app or agent that has a
  question in plain words and no SPARQL query. It takes `question` and
  optional `context`, `route`, `limit` and `run` (default `true`), and calls
  `POST /v1/query/rewrite`. The result holds the route (`kind`, `confidence`,
  `by`), the rationale, the SPARQL query and its entailment, the rows, the
  `error` and the eval `trace_id`. The rows are bounded as in `mode: "sparql"`,
  and `next` continues the same query with `mode: "sparql"` at the commit the
  run read. A failed call is not retried, because each call uses model tokens.
- Add the model checks to `lbb_evals`. `checks_summary` reads a month of the
  graph's checks per job and model, and the judge's agreement with people
  (`month`, `yyyy-mm`; the current month by default). `checks` lists the
  month's checks, newest first, with the judge's verdict, score and reason
  and the ground truth; `job`, `verdict` and `reviewed` filter, and `after`
  pages. `review_check` records a person's review of one check (`call_id`):
  `agree: true` keeps the judge's verdict, and `agree: false` with `verdict`
  and an optional `score`, `reference` and `note` corrects it. The review
  becomes the call's ground truth, so the tool tells the agent to review only
  what the user confirmed. An incomplete review sends no request.

## 0.8.1 (2026-10-03)

- `suggest_ontology_change` takes up to 128 operations in `change`, the same
  limit as the server. It refused more than 64.

## 0.8.0 (2026-10-02)

- Add `list_starters` and `apply_starter` to `lbb_configure`. `list_starters`
  lists the base ontologies (`crm`, `documents`, `work`) with each one's
  status on the graph: `absent`, `partial` or `applied`, what applying would
  add, and the terms the graph holds differently. `apply_starter` adds what
  the graph lacks of one in one ontology version; `dry_run: true` answers the
  operations without writing.
- Add `suggest_ontology_change` to `lbb_configure`. An agent files an
  ontology change for a person to review instead of applying it. The change
  uses the same operations as `evolve_ontology`.
- Add `ontology_suggestions` to `lbb_inspect`. It lists the suggestions and
  their state. Agents cannot accept suggestions.
- Require `@littlebigbrain/client` ^0.17.0.

## 0.7.1 (2026-09-26)

- `lbb_query` with `mode: "search"` honours `detail`. Every search used the
  compact limits (5 hits, text cut at 300 characters) whatever the caller
  asked for. `compact` stays the default.

## 0.7.0 (2026-09-26)

- Remove the `state`, `history`, `transitions`, and `why` actions from
  `lbb_inspect`. Their routes answered `429 ingest_busy` on every graph and
  are removed from the server. Read a node's past values with SPARQL and
  `as_of_commit_seq` through `lbb_query`.
- Require `@littlebigbrain/client` ^0.15.0.

## 0.6.0 (2026-09-25)

Breaking removal of branches, observe, and planner training. Every graph has
one line of history.

- Remove the `branch` argument from every tool, `LBB_BRANCH` from the stdio
  server, and `?branch=` from the HTTP server. Tools are scoped by graph only.
- Remove the `lbb_branch` and `lbb_observe` tools.
- Remove the `planner_dataset` and `planner_preference_dataset` actions from
  `lbb_models`. The server no longer trains the planner.
- Require `@littlebigbrain/client` ^0.14.0.

## 0.5.2 (2026-09-24)

- Require `@littlebigbrain/client` 0.13.2 or later in the 0.13 series, which
  provides the search and evaluation methods used by the MCP tools.
- Add tools to inspect, configure, and delete embeddings, plus search by
  meaning through `lbb_query` with class and relationship filters.
- Add `lbb_evals` for query traces, result labels, and repeatable checks against
  saved queries.
- Keep SPARQL pages on the same commit and return complete values within each
  page's size limit.
- Rewrite the README with connection instructions, a complete RDF import and
  query example, expected output, and links to the current guides.

## 0.5.1 (2026-09-18)

- Bound query pages by UTF-8 bytes while preserving complete RDF values.
- Advance continuation cursors by the number of rows actually delivered, so
  large pages cannot skip rows when they reach the output budget.
- Return an actionable error when a single complete row exceeds that budget.

## 0.5.0 (2026-09-18)

- Return complete ontology and schema definitions with bounded, version-bound
  pagination; add graph discovery and publication-readiness inspection.
- Preview configuration and fact writes with `dry_run`, and expose superclass
  changes through ontology evolution.
- Add `lbb_rdf` for RDF document import and additive `INSERT DATA` updates.
  RDF deletion/replacement and named graphs remain unsupported by the engine.
- Expose query entailment, consistency, and minimum published sequence options,
  preserving them across pagination.
- Require `@littlebigbrain/client` 0.13.1 or newer in the 0.13.x line.
- Report the installed package version in the MCP initialization handshake.

## 0.4.3 (2026-08-31)

- Publish against the `@littlebigbrain/client` 0.13.x line, which adds the
  observed-schema summary and publication-status client methods. MCP's tool
  surface is unchanged.

## 0.4.2 (2026-08-24)

- Publish against the maintained `@littlebigbrain/client` 0.12.x line. MCP's
  schema publication and conformance tools are unchanged; request-time SHACL
  models and `/v1/query/shacl` were never part of its supported tool surface.

## 0.4.1 (2026-08-22)

- Publish against the maintained `@littlebigbrain/client` 0.11.x line so new
  MCP installations receive the publication-readiness fixes. The previously
  published 0.4.0 manifest still referenced the older 0.10.x client line.

## 0.4.0 (2026-08-21)

Breaking removal of every non-SPARQL query surface. SPARQL is the only query
surface, so the retrieval tools that fronted the removed routes are gone.

- Remove the `lbb_search` tool (hybrid search and multi-query fusion).
- Remove the `lbb_ground` tool (vocabulary completion, term resolution, and the
  groundability audit).
- Remove the `lbb_decode` tool (constrained relation decoding).
- `lbb_query` mode=structured now runs only on the structured SPARQL route. A
  body carrying `combinators` (UNION/OPTIONAL/MINUS/EXISTS) is rejected with a
  message pointing at mode=sparql, because the analytics route was removed.
- `lbb_query` mode=analyze drops the `facets` metric, which read the removed
  semantic graph search route. `entity_types`, `relations`, `overview`, and
  `sparql` are unchanged.
- `lbb_inspect`, `lbb_models`, `lbb_commit` (including mode=search_feedback),
  `lbb_configure`, `lbb_branch`, and `lbb_observe` are unchanged.
- Requires `@littlebigbrain/client` 0.11.x, the release with the same query-surface removal.


## 0.3.0 (2026-08-21)

Breaking removal of the standalone graph-traversal surface.

- Remove the `follow_paths` tool and graph-inspection traversal actions.
- Use SPARQL 1.1 property paths through the query tools for exact multi-hop
  graph queries; semantic search retains bounded graph-path evidence.
- Require `@littlebigbrain/client` 0.10.x, the release that carries the same
  traversal-surface removal and the RDF import `build` option.

## 0.2.7

- Require `@littlebigbrain/client` 0.9.x so MCP installations use the public
  durable-import-capable client contract.
- Repair the standalone package lockfile so clean installs resolve the declared
  client dependency.
