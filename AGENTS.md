# Working conventions for AI coding assistants

These rules exist so that work done with an assistant stays consistent and checkable from one session to the next.

## Before writing code

- Read `README.md` and the module you are changing.
- For Next.js, the AI SDK and PGlite, read the docs bundled in `node_modules` for the installed version before using an API. Training-data memory of these libraries is often out of date. The block at the end of this file points at the Next.js docs.
- Pick model ids from the live catalogue (`https://ai-gateway.vercel.sh/v1/models`), never from memory.

## Structure

- Route handlers stay thin. Logic goes in `src/lib` as plain functions that take their dependencies as arguments.
- All SQL lives in `src/lib/retrieval/store.ts`, parameterised. No query strings elsewhere.
- Shapes shared by server and browser live in `src/lib/types.ts`.
- Every tunable is an environment variable validated in `src/lib/config.ts`.

## Tests

- Tests must run with no network and no API key: `AI_MODE=mock`, in-memory database.
- A bug fix comes with a test that fails without the fix.
- Anything that needs the real embedding model or a live model call belongs in `evals/`, not in unit tests.

## Done means

Run these and paste the results. All four must pass.

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

State plainly what was verified and what was not. "Tests pass" is a claim about output you saw.

## Never

- Commit `.env.local`, a key, or the `.data` folder.
- Print a key in logs, errors or test output.
- Add a dependency without saying why in the README.
- Use a gateway model outside `CHAT_MODELS` in application code.
- Send document text to any service other than the chat model call.

## Comments and copy

- Comments explain why, not what.
- Interface text is plain and specific: say what happened and what to do next.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
