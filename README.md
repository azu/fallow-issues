# fallow-issues

Minimal reproductions for fallow issues. The root provides shared tooling, while each reproduction is an independent pnpm workspace.

## Run

Requires Node.js 22 or later and pnpm 11.7.0. Fallow is pinned to 3.30.0.

```sh
pnpm install --frozen-lockfile
pnpm repro

```

To run one reproduction:

```sh
pnpm repro:2952
pnpm repro:2953
```

The initial install requires network access. Dependencies inside each reproduction are local workspace packages, linked using `pnpm install --offline --ignore-scripts`.

## Reproductions

| Directory | Issue | Comparison |
| --- | --- | --- |
| `repros/2952-imports-alias` | [#2952: Workspace dependency reported as unused through an imports alias](https://github.com/fallow-rs/fallow/issues/2952) | `#lib/hello` vs. `@repro/lib/hello` |
| `repros/2953-ignore-dependencies-glob` | [#2953: Glob support in ignoreDependencies](https://github.com/fallow-rs/fallow/issues/2953) | No ignore, exact name, glob |

For #2952, both cases use the same function; only the import specifier changes. For #2953, `@repro/lib` is deliberately unused and no alias is involved, so the glob reproduction does not depend on the alias bug.

The repository root is not a pnpm workspace. Keeping the reproductions separate prevents imports in one example from affecting dependency analysis in another. Each reproduction has its own `pnpm-workspace.yaml`, as required by [pnpm workspaces](https://pnpm.io/workspaces).

## Observed results

Verified on macOS arm64 with Node.js 26.7.0, pnpm 11.7.0, and fallow 3.30.0.

| Case | Unused `@repro/lib` findings | Fallow exit code |
| --- | --- | --- |
| 2952: Import through alias | 1 | 1 |
| 2952: Import by package name | 0 | 0 |
| 2953: No ignore | 1 | 1 |
| 2953: Ignore `@repro/lib` | 0 | 0 |
| 2953: Ignore `@repro/*` | 1 | 1 |

`MATCH` means the case reproduces the reported 3.30.0 behavior, including its bugs and limitations. It does not mean the bug is fixed. Different results are reported as `CHANGED`, and the runner exits with code 1. Fallow execution errors also fail the run.

JSON reports and environment details are saved in `results/`, which is excluded from Git.

## How it works

The runner copies each reproduction into a temporary directory, links its workspace packages, and runs the analysis. Import and configuration changes apply only to that copy. The temporary directory is removed afterward, and the files under `repros/` remain unchanged. Every analysis uses `--no-cache`.

To compare a different fallow binary, provide its absolute path:

```sh
FALLOW_BIN=/absolute/path/to/fallow pnpm repro
```

When a fix changes the behavior, the comparison against the 3.30.0 expectations reports `CHANGED`. Inspect the JSON reports in `results/` for the actual findings.
