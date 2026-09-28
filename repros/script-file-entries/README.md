# Formatting and linting targets become entry points

This reproduction distinguishes use of a tool from use of the files it checks. `oxfmt` and `oxlint` are used dependencies, but their formatting/linting targets should not become entry points just because they appear in a command. A `node` command is included as a control that really does execute the target file.

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm repro:script-file-entries
```

The fixture has two source files. Only `src/index.ts` is declared as `main`; nothing imports `src/dead.ts`. The runner adds each command independently to a temporary copy. It never executes the formatting, linting, or script commands. Dependencies are provided by a symlink to the root's installed `node_modules`.

## Fallow and Knip comparison

Verified on macOS arm64 with Node.js 23.10.0, pnpm 11.7.0, Fallow 3.30.0, Knip 6.38.0, oxfmt 0.51.0, and oxlint 1.69.0.

Each command row below is tested separately in `package.json` scripts, GitHub Actions `run`, and GitLab CI `script`. CI tool commands use `npx`; the Node controls use `node` directly.

| Command | Expected unused `src/dead.ts` | Fallow | Knip |
| --- | --- | --- | --- |
| No command (baseline) | 1 | 1 | 1 |
| `oxfmt --check "**/*.ts"` | 1 | 0 | 1 |
| `oxfmt --check src/dead.ts` | 1 | 0 | 1 |
| `oxlint "**/*.ts"` | 1 | 0 | 1 |
| `oxlint src/dead.ts` | 1 | 0 | 1 |
| `node src/dead.ts` (package.json / GitHub execution control) | 0 | 0 | 0 |
| `node src/dead.ts` (GitLab execution control) | 0 | 0 | 1 |

These are 16 shared cases per analyzer: one baseline, 12 formatting/linting cases, and three execution controls. Fallow misses the unused file in all 12 formatting/linting cases, with two entry points and exit code 0 instead of one entry point and exit code 1.

Knip runs with `--include files --reporter json --no-progress --no-config-hints`, without custom configuration. The comparison checks unused-file findings and exit codes; it does not compare every diagnostic category between the tools. The Node controls demonstrate that Knip processes package.json and GitHub Actions commands. In the GitLab-only Node control, Knip still reports the file as unused. Consequently, the GitLab results do not demonstrate argument classification: Knip does not discover even the execution entry in this fixture.

Knip's [script parser](https://knip.dev/features/script-parser) analyzes CI commands. Its [per-command argument definitions](https://knip.dev/writing-a-plugin/argument-parsing#positional) allow execution targets to become entries while formatting/linting targets do not. See the [oxfmt](https://knip.dev/reference/plugins/oxfmt#shell-commands) and [oxlint](https://knip.dev/reference/plugins/oxlint#shell-commands) definitions.

## Additional Fallow checks

| Case | Unused `src/dead.ts` | Entry points | Exit code |
| --- | --- | --- | --- |
| GitHub oxfmt glob with `entry: ["src/index.ts"]` | 0 | 2 | 0 |
| package.json `fmt` glob with `--production` | 1 | 1 | 1 |
| GitHub oxfmt glob with `--production` | 0 | 2 | 0 |

An explicit `entry` does not replace inferred entries. Production mode skips the package.json formatting script in this fixture but still picks up the GitHub Actions argument. `ignorePatterns` would remove the source files from analysis entirely.

The runner performs 19 Fallow checks and 16 Knip checks. `MATCH` means the observed result matches the documented version's behavior, including the Fallow bug and Knip's GitLab control result. The summary also records `desiredUnused` and `matchesDesiredBehavior` to distinguish the requested behavior from the observed behavior. A future fix reports `CHANGED` against the pinned-version expectations.

## Proposed behavior

Known formatting and linting targets should not create entry points. Tool dependency usage, configuration files, and plugins should still be tracked. An opt-out for file-argument inference is a possible fallback for custom commands; projects opting out would declare real script entry points explicitly.

The reproduction no longer tests rejection of an invented configuration field: a particular option name is not part of the requested behavior.

## Diagnosing the current result

`fallow list` identifies the inferred entry:

```text
src/dead.ts (scripts)
src/index.ts (package.json main)
```

The normal output groups the GitHub Actions entry under `plugin`:

```text
2 entry points detected (1 package.json, 1 plugin)

✓ No issues found
```

The English issue draft is in [ISSUE.md](ISSUE.md). Raw results are saved under the root's ignored `results/` directory; the summary contains only checks from the current run. No GitHub issue has been submitted for this reproduction.
