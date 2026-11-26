# Kilo

AI video editor for short-form creators. Raw clips in, a tight vertical video out.

- `PLAN.md`: what is being built, in which phases.
- `docs/CONTRACTS.md`: ownership, conventions, the API, the pipeline, design tokens. Read it before changing anything.
- `packages/edl`: the shared contracts. Every other project builds against it. After changing it run `npm run build` there, since consumers import `dist/`.

## Layout

Independent npm projects, no workspace: `packages/edl`, `packages/analyze`, `packages/render`, `templates`, `server`, `app`. Each has `npm test` and `npm run typecheck`.

## Running

- Test footage: `node fixtures/generate.mjs` (needs `ffmpeg` and `espeak-ng`).
- Everything runs offline by default: the `fixture` transcriber, the `heuristic` decider, local disk storage and dev auth. Real providers switch on when their keys are in the environment.

## Rules

- TypeScript strict, ES modules, Node 22, npm.
- Never commit generated media or secrets.
- Times are seconds. Use `resolveTimeline` from `@kilo/edl` for anything on the output timeline.
