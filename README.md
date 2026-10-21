# WetFlow

WetFlow is a workbench for biological research teams. It connects project documents, scientific tools, experimental records and researcher approvals in one project. The supplied cases cover PMA–dopamine adhesive research and education planning.

Requires Node.js ≥22.19, npm and Python 3 (`python3`, or set `PYTHON_EXECUTABLE`).

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4310 and configure an OpenAI-compatible API base URL, model name and your own API key in Settings. Online conversations use the configured provider and may incur API charges. Local settings and data are stored under `.wetflow/` and excluded from Git. Retrieved document text is shared with the model only when enabled in Settings.

The plugin panel manages four core plugins and two optional extensions. Load Feed-comparison to compare saved MD reports. For Education, load Evidence and Education, then import the example sources into the active project. The CLI (`npm run console`) loads Evidence by default.

Thinking intensity, optional reasoning display and the context budget (up to 1,000,000 tokens) can be changed in the workbench. The budget must fit the selected model's capacity.

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

The benchmark re-scores retained historical outputs for 30 synthetic claims: 27 original records plus clarified reruns of A-02, A-03 and A-13 per system. Original and clarified prompts/answers remain in `examples/evidence-benchmark/records/`; all 66 records are retained. The retained results are WetFlow 28/30 (93.3%) and OpenCode 21/30 (70.0%), including 0 and 6 execution failures or missing labels, respectively. It does not rerun models or evaluate this release. The historical systems used different execution paths, and retained records do not establish a matched thinking mode or complete source-version binding.

## AI use

The recorded model-assisted examples and evidence benchmark used DeepSeek Flash (API model identifier: `deepseek-flash`). The included project documents, attributed education sources and synthetic benchmark corpus are used as task inputs. Model answers and generated plans require researcher or educator review; the benchmark is a small development test and does not establish performance across other projects. GPT6 Astra and GPT 6.1sol assisted with code writing during development.

`npm test` runs the tests. Code is licensed under [Apache-2.0](LICENSE); attributed third-party materials retain their own terms.
