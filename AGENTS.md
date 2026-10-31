# Nomad Concierge agent guide

`docs/SPEC.md` is the implementation contract. Read sections 0–4, 25 and your work package before editing. Use the simplest explainable and testable choice where the contract is silent.

## Commands

- `npm ci`: install the committed dependency graph.
- `npm run dev`: run shared compilation, API and web development servers.
- `npm run check`: lint and type-check shared, API and web.
- `npm test`: run shared, API and web unit/integration tests, without a browser.
- `npm run build && npm start`: build and start production mode.
- `npm run test:e2e`: run the QA browser suite.

Use Node 24, or supported Node 22.13+, 24 and 26 versions, with npm 10 or newer. Tests listen on port 0; use `PORT`, `VITE_PORT` and `API_URL` to isolate development servers.

## Ownership

- WP0: root configuration, shared contracts, API configuration/composition/app/server and database migrations.
- WP1: API domain, knowledge data, golden fixtures and their unit tests.
- WP2: API interpreters, engine clients/fallbacks, evaluation script and their tests.
- WP3: API repositories except turns/events, HTTP/auth/routes/services and their tests.
- WP4: API turns/realtime/lifecycle, turns/events repositories and their tests.
- WP5: web application and tests.
- WP6: Docker, CI, production static serving and README operating instructions.
- QA exclusively owns `qa/`, except its initial package manifest and dependencies supplied by WP0. Development agents do not read or edit QA tests.
- Human-owned narrative documents: DISCOVERY, DECISIONS, AI_USAGE, README narrative and docs/verification.md.

Only edit your assigned files. Work on your assigned branch/worktree, do not merge or push. WP0 and integration may work on main. Dependencies and the lockfile are maintained centrally. Shared contract changes must update SPEC and use `contract-change` in the commit message; raise changes affecting multiple packages to the integration owner.

## Boundaries

Do not read, print or create `.env`. Do not use real model services or real keys. Test with local fake services and explicitly clear model configuration for baseline tests. Do not commit secrets, dependency directories, build output or database files. Do not modify global configuration or other workers' resources. Do not add future-facing abstraction or professional eligibility/tax conclusions.

## Completion

Meet SPEC section 25.2 and section 26: check and tests pass; new behavior is covered; no remaining TODOs, debug output or skipped tests; touched files follow ownership; contract changes update SPEC. Report actual command results, deviations, unresolved decisions and dependencies on other packages. Never claim an unexecuted check passed.
