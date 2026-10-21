# Cordis plugin lifecycle

WetFlow's domain capabilities are four Cordis plugins. The Agent retains four core workflow tools; each domain plugin provides a named service and owns a revocable registration in the Agent's tool registry.

| Plugin | Cordis service | Registered tools | Function |
| --- | --- | ---: | --- |
| Evidence | `wetflowEvidence` | 2 | Imported source metadata and cited local search |
| Research | `wetflowResearch` | 15 | Literature search, source reading, records, read-only queries and export |
| Modeling | `wetflowModeling` | 9 | Monod simulation, growth fitting, task/results management and prediction links |
| Experiment | `wetflowExperiment` | 5 | Existing `industrial_*` parameter, telemetry and deviation tools |

`src/plugins/*.ts` defines each plugin's `inject: ['wetflow']`, service and effects. `ctx.reflect.provide` binds the service to its Cordis fiber. `ctx.effect` binds tool removal and resource cleanup to the same fiber. Tool registration is staged before publication: a duplicate name fails the whole mount. A revoked tool reference cannot execute, even if a caller retained it before unloading.

The HTTP and Agent interfaces resolve the same services. An unloaded module's REST routes return 503; it cannot be silently reopened through an old endpoint. Research-to-Modeling export and Modeling-to-Experiment links resolve their counterpart on demand, so removing an optional counterpart does not remove unrelated research or modeling tools. The unavailable cross-module operation returns an explicit error.

## Run the demonstration

```bash
npm ci
npm run build
npm run start
```

Open the workbench and select **Plugin lifecycle** (plug icon), or open `http://127.0.0.1:4310/?view=plugins`. All four plugins load by default. Unload Modeling once to establish the starting state, then:

1. Load Modeling Plugin: nine modeling tools appear in the live registry.
2. Click **Call modeling_methods**: the registered tool returns the available methods.
3. Unload Modeling Plugin: the service and nine tools disappear.
4. Call the same tool again: the server reports that it is unavailable.
5. Reload it: the capability returns. Export the session to retain the actual observations.

The panel uses live HTTP responses. The registry list and counters are not a scripted animation.

For an isolated, deterministic run with no credentials or external model invocation:

```bash
npm run demo:plugins -- artifacts/plugin-lifecycle
```

This starts Evidence, Research and Experiment while leaving Modeling unloaded. It exercises the real Cordis fibers and Fastify routes, calls `modeling_methods`, checks restoration, and writes JSON and CSV observations. Expected registry totals for this version: **26 → 35 → 26 → 35**. Tool counts can change when the implementation gains new tools; the demonstration calculates them from the registry.

## Lifecycle behavior

- Loading and unloading are serialized; repeated requests are idempotent.
- Unloading removes the tool schemas used by subsequent model requests. Model calls referencing a removed tool receive an unavailable-tool observation.
- Modeling shutdown terminates active workers and marks active/queued tasks failed with `Service shutdown`; their task records and completed results remain on disk.
- Research shutdown aborts searches and document fetches before closing its SQLite connection. Search records retain the interrupted status.
- Experiment opens its SQLite connection lazily and closes it on unload. Its records remain on disk.
- Evidence removes tool access and automatic retrieval while retaining imported records in the Agent's database.
- Disposing the root Cordis context disposes the plugins and Agent. A Cordis consumer declaring `inject: ['wetflowModeling']` activates when Modeling is present and is disposed when Modeling is removed.

## Verification

`tests/plugin-lifecycle.spec.ts` exercises all four tool groups, provider-visible definitions, repeated/concurrent loading, stale references, rollback, evidence persistence, running-worker cleanup, dependent-plugin activation, in-flight document cancellation, root teardown and REST behavior. It uses a scripted provider to check the Agent/model boundary without an external model call. Numerical workers and registry operations are real.
