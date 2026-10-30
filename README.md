# WetFlow

WetFlow is a workbench for biological research teams. It connects project documents, scientific tools, experimental records and researcher approvals in one project. The supplied cases cover PMA–dopamine adhesive research and education planning.

Requires Node.js ≥22.19, npm and Python 3 (`python3`, or set `PYTHON_EXECUTABLE`).

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4310 and configure an OpenAI-compatible API base URL, model name and your own API key in Settings. Online conversations use the configured provider and may incur API charges. Local settings and data are stored under `.wetflow/` and excluded from Git. Retrieved document text is shared with the model only when enabled in Settings.

With the Workflow-planner plugin enabled, new workflow runs start with their route pending. Discuss the goal and stages with the Agent, then approve its `workflow_set_plan` proposal to save the route for that run. Stage advances still require approval. Routes can be revised while preserving completed and current stages; existing advanced runs retain their previous route.

All ten plugins ship with WetFlow. On first launch, both the web host and CLI enable Evidence, Research, Modeling, Experiment, Feed-comparison, Local-files, Document-media, Workflow-planner and Batch-data. Education is installed but off by default; enable it when you want WEAVE-guided education planning. The plugin panel lets you turn individual plugins on or off, and your choices persist across restarts. Unloading a plugin removes its capabilities without deleting its files, records or confirmed routes. Document-media depends on Local-files; Education depends on Evidence. In the CLI (`npm run console`), use `/plugins` to view status and `/plugin education on` (or `off`) to change a plugin. The hosts share saved choices when configured to use the same data directory.

With Local-files loaded, ask the Agent to read a local Windows, WSL or Linux file path using `local_file_read`. It supports text (including UTF-8, UTF-16 and optional GB18030); enable Document-media for PDF, PNG, JPEG and WebP, up to 20 MiB per file. Text excerpts include line citations and a continuation offset; PDFs are read by page. PDF `mode: text` extracts text, `mode: image` renders the page for charts/layout, and `auto` renders pages without extractable text. Images are sent as actual visual input to an OpenAI-compatible vision model; text-only models cannot interpret them. File paths refer to the machine running WetFlow.

In the web chat, use **添加附件** (Add attachments) or paste a screenshot. Each message accepts up to four files, saved with the conversation in the current project. Enable **允许向模型发送资料和附件内容** in Settings to share their content with your configured provider. The provider must support `image_url` content in Chat Completions for visual input; WetFlow does not infer vision support from a model name. Images are resized to a maximum side of 1,800 pixels; at most six recent images are sent per request. Image token costs depend on the provider, so the context display uses an estimate. PDF extraction does not replace checking the original table layout, and visual reading of scanned pages depends on the model. Audio/video input is not supported.

Thinking intensity, optional reasoning display and the context budget (up to 1,000,000 tokens) can be changed in the workbench. The budget must fit the selected model's capacity.

## Multi-batch data plugin

Open **多批次数据** from the left navigation after enabling Batch-data. Create a round, add batches with their conditions, and define metric codes, fixed units and optional normal ranges. Enter observations or download the CSV header template, fill it with your own records and use preview before confirming an import. Required CSV columns are `sample,metric,value,unit,source`; optional columns are `locator,sampledAt,note`. Decimal values retain their original precision. A normal-range deviation is kept and flagged; an incorrect unit is rejected. Identical reimports are skipped, conflicting values require an explicit correction, and a correction retains previous versions and its reason.

The database is project-scoped and spans multiple runs; each record retains its originating run. Cross-batch comparisons align the same metric and sample key, show exact differences, and leave missing observations empty. Matching keys does not establish that experimental conditions are comparable; batch conditions are displayed alongside the results. Agent tools can query the catalogue, observations, comparisons and revision history; writes and corrections require approval showing the proposed values and sources. Data lives in `batch-data.db` alongside the workflow database; the web default is `.wetflow/batch-data.db`. Disabling the plugin closes its connection and removes its sidebar entry and tools. Re-enabling it restores access to the saved records. No example measurements are automatically inserted.

## Run the examples

```sh
npm run demo:plugins
npm run demo:feeds
npm run demo:design
npm run demo:education
npm run demo:benchmark
```

The plugin demo checks tool registration and removal; the feed demo compares saved MD reports; the design demo checks project isolation, measurement validation and stage approvals; the Education demo builds a primary-school DNA activity brief. The benchmark command reproduces the scores described below.

These commands make no model API calls by default. Inputs are under `examples/`; generated tool-demo outputs go to `artifacts/` or `.wetflow/demos/`. Education sources are attributed planning inputs, not evidence of classroom outcomes.

Loading Education adds WEAVE to every model request: Wonder establishes needs and rationale, Explore designs for objectives, Action plans delivery, Verify evaluates learning, and Echo guides revision. Unloading the plugin or its Evidence dependency removes these instructions. The bundled historical library covers six activity types with one or two teams per type; `education_search_cases` browses categories or filters by topic, audience and category in Chinese or English. Source summaries are imported into the active run on first use for traceable citations. `education_make_brief` applies the built-in framework without a separate WEAVE document import. The plugin panel lists categories and source links; `examples/education/education-library.json` stores the case records and source status. Earlier team resources remain available through the example import button.

The benchmark re-scores retained historical outputs for 30 synthetic claims: 27 original records plus clarified reruns of A-02, A-03 and A-13 per system. Original and clarified prompts/answers remain in `examples/evidence-benchmark/records/`; all 66 records are retained. The retained results are WetFlow 28/30 (93.3%) and OpenCode 21/30 (70.0%), including 0 and 6 execution failures or missing labels, respectively. It does not rerun models or evaluate this release. The historical systems used different execution paths, and retained records do not establish a matched thinking mode or complete source-version binding.

## AI use

The recorded model-assisted examples and evidence benchmark used DeepSeek Flash (API model identifier: `deepseek-flash`). The included project documents, attributed education sources and synthetic benchmark corpus are used as task inputs. Model answers and generated plans require researcher or educator review; the benchmark is a small development test and does not establish performance across other projects. GPT6 Astra and GPT 6.1sol assisted with code writing during development.

`npm test` runs the tests. Code is licensed under [Apache-2.0](LICENSE); attributed third-party materials retain their own terms.
