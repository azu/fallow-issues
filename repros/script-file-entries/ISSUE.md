# Formatter and linter targets are treated as entry points, hiding unused files

## Problem

Fallow treats formatting and linting targets as entry points in both `package.json` scripts and GitHub Actions `run` steps. Using `oxfmt` means the tool is used, but does not mean the files it formats are used by the application.

This also reproduces with oxlint 1.69.0 and ESLint 9.39.1; oxfmt is used below as the minimal example.

## Reproduction

[Reproduction repository](https://github.com/azu/fallow-issues/blob/main/repros/script-file-entries/README.md): run `pnpm install --frozen-lockfile` and `pnpm repro:script-file-entries` from the repository root.

Tested with Fallow 3.30.0 and oxfmt 0.51.0.

```jsonc
// package.json
{
  "name": "repro",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "fmt": "oxfmt --check \"**/*.ts\"" },
  "devDependencies": { "oxfmt": "0.51.0" }
}
```

```ts
// src/index.ts
export {};
```

```ts
// src/dead.ts
export const dead = 1;
```

Install dependencies, then run `fallow dead-code --no-cache`:

- With the `fmt` script: `No issues found` (exit 0).
- Without the `fmt` script: `src/dead.ts` is unused (exit 1).

The formatter never needs to run. An explicit path (`oxfmt --check src/dead.ts`) also reproduces the problem.

GitHub Actions also reproduces this independently: remove the `fmt` script and add a workflow step with `run: npx oxfmt --check "**/*.ts"`. Fallow still stops reporting `src/dead.ts` as unused.

## Expected behavior

Keep recognizing `oxfmt` as a used dependency and tracking its configuration, but do not treat formatting targets as entry points. `src/dead.ts` should remain unused. Actual execution, such as `node src/dead.ts`, should still make the file an entry point.

For commands whose arguments are difficult to classify, an option to disable file-argument entry inference would also help. Projects could declare actual script entries explicitly while keeping dependency tracking enabled.

## Knip comparison

We previously used Knip in our project without encountering this issue. In this minimal reproduction, Knip 6.38.0 reports `src/dead.ts` as unused with oxfmt, but recognizes it as an entry with `node`, in both package.json and GitHub Actions. Knip has [command-specific argument rules for oxfmt](https://knip.dev/reference/plugins/oxfmt#shell-commands), so the difference is not simply that it ignores GitHub Actions.
