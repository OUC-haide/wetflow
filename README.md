# WetFlow

WetFlow is a Cordis-based research workbench for project documents, scientific tools, measurement records and researcher-approved workflow transitions. It was developed for the team's PMA–dopamine adhesive project and also supports Education planning through an optional extension.

## Start

Use Node.js 22.19 or newer, npm and Python 3 available as `python3` (or configure `PYTHON_EXECUTABLE`). From this directory:

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4310. Configure an OpenAI-compatible model in the workbench, or use the built-in rules without a model API. Model API calls use your configured provider. Automatic sharing of retrieved document text is off by default and can be enabled in model settings. Local settings, databases and generated outputs are excluded from version control.

## Tools and cases

The web host loads four core plugins: Evidence, Research, Modeling and Experiment. They provide 35 tools, including workflow tools. The plugin workspace also lists two optional extensions:

| Extension | Operation | Use in the workbench |
| --- | --- | --- |
| Feed comparison | `md_compare_feeds` validates and compares saved MD contact reports. It does not start molecular simulations. | Load the extension, then try the saved feed comparison or ask the Agent to compare feed 1.00 and 1.25. |
| Education | `education_search_cases` and `education_make_brief` reuse project sources, exact citations and the team's WEAVE design cycle. | Load Education while Evidence is available. Import the example sources into the current project, then search DNA cases or request a 30-minute primary-school brief. |

Unloading an extension removes its tools. Education tools also become unavailable when Evidence is unloaded and recover when its service returns. Imported sources remain in their project. The bundled sources and saved report are examples; replace them through the plugin configuration when developing another application.

Project retrieval is scoped to the active run. Measurement writes through Agent tools and HTTP share declared-unit validation; a missing unit uses the parameter's declared unit, while an explicit mismatch is rejected. A correctly dimensioned out-of-range observation remains stored and is flagged as a deviation. Agent writes require explicit user-supplied recording intent, parameter and value. Workflow-stage advancement has a separate approval step.

The CLI (`npm run console`) uses the same Agent implementation with Evidence loaded; its default tool set is smaller than the web host's. Other hosts can register the exported plugins explicitly.

## Thinking and context settings

DeepSeek exposes Off, Low, High and Max thinking intensity. A separate display switch reveals provider-returned reasoning in collapsible sections after a turn completes. The display preference does not change thinking intensity. Saved reasoning is kept apart from the final answer and is not automatically appended to future conversation context. Old reasoning that was never recorded is not reconstructed.

The context panel lets users save a budget from 1,024 to 1,000,000 tokens, with a 128,000-token default. Settings persist in `.wetflow/context-settings.json`. Saved UI settings take precedence over `WETFLOW_CONTEXT_TOKEN_BUDGET`; an explicit server option takes precedence at startup. This is an estimated base-context budget, subject to provider capacity. Tool-call continuations add messages of their own. Original older messages remain available when they fit; extracted memory is used when compaction is needed.

## Reproduce the examples

These commands run without model API calls:

```sh
npm run demo:plugins
npm run demo:feeds
npm run demo:design
npm run demo:education
npm run demo:benchmark
```

The first four invoke actual tools and services using included fixtures. The benchmark command re-scores retained historical outputs: WetFlow 28/30 and OpenCode 21/30 on a synthetic development set, assembled from 27 original records and 3 clarified reruns per system. It does not rerun models or evaluate the current release. See [scientific extensions](docs/scientific-extensions.md), [plugin lifecycle](docs/plugin-lifecycle.md) and the [benchmark inputs and records](examples/evidence-benchmark/README.md) for their scope.

`npm run build` performs TypeScript checking and creates the web and Node bundles. `npm test` runs the repository's regression suite.

## License

Team-authored code is licensed under the [Apache License, Version 2.0](LICENSE). Third-party libraries and attributed education materials retain their own terms and credits. The previous noncommercial license is superseded for this release.
