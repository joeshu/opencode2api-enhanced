# Architecture Memo

## Project status

`opencode2api-enhanced` is now in a stable maintenance phase after a long round of incremental modularization.

Current validation baseline:

- Primary local verification: `npm run verify:smoke`
- CI verification: `Smoke Check`
- Delivery verification: `Publish Docker Image`

At this stage, `src/proxy.js` is no longer a giant utility container. Most reusable helpers and runtime support logic have been extracted into dedicated modules.

## Working conventions

- Use the formal working directory: `/var/minis/workspace/opencode2api-enhanced`
- Prefer the smallest possible reversible commit
- Run `npm run verify:smoke` after each meaningful refactor step before committing
- Treat Jest as secondary in the current environment; smoke is the primary regression guard

## Extracted modules

- `src/errors.js`
- `src/backend-health.js`
- `src/backend-runtime.js`
- `src/request-runtime.js`
- `src/timeouts.js`
- `src/models.js`
- `src/image.js`
- `src/prompt-utils.js`
- `src/cleanup.js`
- `src/conversation-cleanup.js`
- `src/tool-overrides.js`
- `src/events.js`
- `src/opencode-path.js`
- `src/message-orchestration.js`
- `src/prompt-executor.js`
- `src/start-proxy-config.js`
- `src/server-runtime.js`
- `src/response-builders.js`

## Remaining concentration in `src/proxy.js`

What still mainly lives in `src/proxy.js` now:

- `createApp(config)` route assembly
- `handleChatCompletions(...)` orchestration
- `/v1/responses` orchestration
- a small amount of glue logic that stitches extracted modules together

This means future refactors are no longer about extracting generic helpers; they are about carefully reshaping business orchestration.

## Validation notes

Important observed SDK behavior in this environment:

- `session.create()` may hit `GET /session`
- `session.prompt()` and `session.messages()` may both hit `GET /session/{id}/message`

Do not assume REST naming conventions are sufficient when building mocks. Probe actual SDK behavior first.

When moving helper scripts across directories, always update relative imports. Example:

- old: `./src/proxy.js`
- new: `../src/proxy.js`

## Bottom line

The project is now in a good place:

- helper layer is modularized
- runtime support layer is modularized
- backend lifecycle is modularized
- smoke verification is stable
- CI is green

This is a good checkpoint to pause deep refactoring and move into stable maintenance, with selective future refactors only where they clearly pay off.
