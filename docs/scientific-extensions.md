# Scientific extensions: saved MD comparisons and Education

WetFlow keeps the project and Agent while a Cordis plugin supplies a new operation. Both examples use the existing tool registry; Education also declares its dependency on the Evidence service. The extension modules are exported from `@wetflow/cordis-agent/plugins` for programmatic loading. The workbench's built-in plugin panel manages the four core plugins described in [plugin-lifecycle.md](plugin-lifecycle.md).

## Reproduce without a model API

Use Node.js ≥22.19, npm and Python 3 available as `python3` (or set `PYTHON_EXECUTABLE`). No Python packages are needed. After `npm ci`, run these commands from the `wetflow/` module directory:

```sh
npm run demo:plugins
npm run demo:feeds
npm run demo:design
npm run demo:education
```

Each command invokes real registered tools and services without calling an external language model. Inputs are bundled under `examples/` or declared in the scripts. The lifecycle case is described in [plugin-lifecycle.md](plugin-lifecycle.md). Output files are:

| Command | Default output |
| --- | --- |
| `demo:plugins` | `artifacts/plugin-lifecycle/plugin-lifecycle-results.json` and `plugin-lifecycle-results.csv` |
| `demo:feeds` | `.wetflow/demos/feeds/results.json` and a copy of `md-five-feed-summary.json` |
| `demo:design` | `.wetflow/demos/design/design-validation-results.json` and `monod-trajectory.csv` |
| `demo:education` | `.wetflow/demos/education/education-results.json`, with project and service data in the same directory |

The Education output contains its request inputs, attributed case search results, source citations and structured WEAVE brief. Offline mode does not generate a model-written lesson. A usable proposed classroom sequence is provided below. Running the Education command with a separate output directory keeps each demonstration independent:

```sh
npm run demo:education -- .wetflow/demos/education-repeat
```

The feed demonstration checks **35 → 36 → 35** registered tools. The Education demonstration checks **35 → 37 → 35**, verifies loss and restoration of its Evidence dependency, and rejects a retained tool reference after the plugin is removed. These are separate runs starting from the four core plugins.

`demo:design` exercises project-scoped retrieval, measurement-write validation, researcher approval, the feed extension and a saved Monod numerical task. Its culture protocols are explicitly fictional software-test inputs; they are not the team's wet-lab measurements.

## Saved MD feed comparison

`src/plugins/feed-comparison.ts` registers `md_compare_feeds`. Its input selects baseline and comparison feeds from a saved summary. The tool preserves the declared activation assumption, requires a common positive analysis window, rejects inconsistent counts and returns compatible-contact fractions.

The bundled report assumes 50% activation and a 3–5 ns window. Feed 1.00 has 122 compatible records among 485 close-contact records (25.2%); feed 1.25 has 24 among 462 (5.2%), a change of −20.0 percentage points. These are simulated pair-frame contact measures. They are separate from published product dopamine mass fractions and do not count completed grafting reactions.

The operation reads and validates the report. It does not start a new molecular simulation. To use another compatible report:

```sh
npm run demo:feeds -- path/to/summary.json .wetflow/demos/another-report
```

The supplied report must contain feeds 1.00 and 1.25. Fixture-specific numerical assertions apply only when using the bundled default; an explicit report keeps its own validated counts, activation assumption and window. The original study's 75%-activation control reverses the high-feed ordering, so the 50% comparison does not establish a general optimal feed.

## Education tools and WEAVE

`src/plugins/education.ts` supplies two tools. `education_search_cases` searches the active project's attributed experience cards by topic and audience. `education_make_brief` checks selected case IDs, audience and resources, returns exact source references supplied by Evidence, and includes the team's WEAVE design questions. The Agent uses the returned information to write an activity proposal.

The fixed inputs and checks let later requests reuse the same filtering, source connections and resource comparisons. They do not provide an automatic judgment that every proposed teaching choice is sound. The collection includes six source documents and seven cards, retaining the source team, reported practice, reflection and proposed adaptation.

WEAVE is the complete design cycle. **Wonder** identifies why the activity is needed and who it serves. **Explore** defines learning objectives and selects suitable content and formats. **Action** plans practical delivery. **Verify** specifies how to examine participant gains against the objectives. **Echo** connects feedback and reflection to a revised activity that must be implemented and evaluated later.

The example plans one new 30-minute primary-school DNA activity using paper, colored pens, clay, a laptop and a projector. The classroom timetable belongs within Action. The tool does not distribute that time among the five WEAVE stages. Missing prior feedback stays unknown; Verify awaits classroom evidence and Echo awaits feedback and later iteration. This demonstration does not claim a delivered class or measured learning gains.

The source documents include the team's DNA Builder and BUCT's attributed drawing-and-clay practice. BUCT's original audience context is retained; applying selected elements to a different classroom remains a proposed adaptation.

### Proposed classroom sequence without a model API

This is a new adaptation using [OUC-Haide's DNA Builder description](../examples/education/sources/OUC-EDU-ACTIVITIES.md) and [BUCT's drawing-to-clay practice](../examples/education/sources/BUCT-2025-EDUCATION.md), organized with [WEAVE](../examples/education/sources/OUC-EDU-WEAVE.md). BUCT's original audience was children with special educational needs; suitability for another class requires educator review. No classroom delivery or learning gains are claimed.

Confirm exact ages, prior knowledge, group size and support needs before delivery. Prepare paper base cards labeled A, T, G and C, colored pens and clay; prepare a simple two-sided DNA diagram on the laptop for projection. A locally prepared diagram makes this sequence independent of an external activity website. The proposed goal is to identify the two-sided, paired structure and explain one complementary base pair.

| Action time | Learner and facilitator steps |
| --- | --- |
| 0–5 min | Project the diagram. Point out the two sides and connecting base pairs; demonstrate A–T and G–C with labeled paper cards. Ask learners what connects the two sides. |
| 5–12 min | Learners draw or arrange labeled paper cards into complementary pairs. A facilitator checks one pair with each group and helps correct mismatches. |
| 12–22 min | Use clay to build two sides connected by the labeled pairs. Learners may retain a drawing or paper model as an alternative; provide individual support where needed. |
| 22–27 min | Each learner or group points to the two sides and explains one pair using its model. Ask a partner to check the pairing against the projected diagram. |
| 27–30 min | Collect one short learner explanation and record one facilitator observation about pairing, structure or support needed. Retain uncertainty rather than recording an assumed success. |

These times total 30 minutes within Action. Under Wonder, record the intended audience and unconfirmed needs. Under Explore, connect the pairing goal to the diagram, labeled cards and tactile option. Under Verify, assess the collected explanation and observation against the stated goal after the lesson. Under Echo, use actual feedback to choose a revision: for example, add a pairing prompt if mismatches persist or offer a drawing option if modeling obstructs explanation. Implement and evaluate that revision before claiming an improvement.

## Optional live Agent reproduction

The same Education script can submit the bundled primary-school request to DeepSeek Flash. This mode makes model API calls and sends the selected source excerpts to the configured provider. Set `DEEPSEEK_API_KEY` in your environment, optionally set `DEEPSEEK_BASE_URL`, and explicitly select live mode:

```sh
npm run demo:education -- --live .wetflow/demos/education-live
```

The script saves the answer as `guidance-primary.md` and the tool observations as `education-results.json`. Wording and tool choices can vary between live runs. Review the proposed design and its citations before any classroom use.

## Developer loading

An extension uses the same Cordis context as the Agent:

```ts
import { EducationPlugin, FeedComparisonPlugin } from '@wetflow/cordis-agent/plugins'

// ctx already owns the project; the Evidence plugin is loaded and its
// source documents have been imported before the Education plugin is used.
const education = await ctx.plugin(EducationPlugin, { libraryPath })
const comparison = await ctx.plugin(FeedComparisonPlugin, { summaryPath })

await education.dispose()
await comparison.dispose()
```

Removing Evidence suspends its dependent Education tools; restoring Evidence reactivates them. Project documents remain in the existing store. Removing the extension revokes its tool registrations without replacing the Agent loop.

## Tests

`tests/education.spec.ts` covers project visibility, audience filtering, exact source markers, resource checks, missing feedback, the complete WEAVE cycle and prospective evaluation status. `tests/feed-comparison.spec.ts` covers the recorded arithmetic and refusal of incompatible or impossible inputs. The core plugin tests cover registry visibility, dependencies, cleanup and stale references.

## Workbench access

The plugin workspace lists the four core plugins and the optional Feed-comparison and Education extensions. Load Feed-comparison and use its example probe to compare the bundled saved report. Load Education with Evidence available, explicitly import its six example source documents into the active project, and use its DNA case search or ask the Agent to prepare a brief. Unloading Evidence suspends the dependent Education tools; reloading it restores them without deleting imported project sources.

The historical adhesive follow-ups read MD summaries that already existed. They demonstrate tool-assisted interpretation of saved results, not software initiation of those earlier simulations. The retained benchmark records are also historical; the current regression tests and workbench probes validate this release separately.
