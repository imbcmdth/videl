# AGENTS.md

Read **[LEMMA.md](./LEMMA.md)** before doing any work on this project. It contains answered questions, tech-stack decisions, and architectural invariants that must be respected.

## Workflow Rules

- **Always run lint after finishing work.** No pull request or commit should leave lint failures behind.

  ```
  npm run lint
  ```

  `npm run lint` runs both ESLint (`lint:fix`) and TypeScript type-checking (`lint:types`) in parallel.
