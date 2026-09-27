import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selected = process.argv[2] ?? "all";
if (!["all", "2952", "2953"].includes(selected)) {
  console.error("Usage: pnpm repro [2952|2953]");
  process.exit(2);
}
const fallow = process.env.FALLOW_BIN
  ? resolve(process.env.FALLOW_BIN)
  : join(root, "node_modules", ".bin", "fallow");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} terminated: ${result.signal}`);
  return result;
}

const version = run(fallow, ["--version"], root);
if (version.status !== 0) throw new Error(version.stderr || version.stdout);
const fallowVersion = version.stdout.trim().split("\n")[0];
console.log(fallowVersion);
console.log(`Node ${process.version}; ${process.platform}/${process.arch}`);
const results = join(root, "results");
mkdirSync(results, { recursive: true });
let mismatches = 0;
const observations = [];

function analyze(workspace, name, expectedUnused) {
  const result = run(fallow, ["dead-code", "--no-cache", "--format", "json"], workspace);
  writeFileSync(join(results, `${name}.json`), result.stdout);
  writeFileSync(join(results, `${name}.stderr.txt`), result.stderr);
  if (![0, 1].includes(result.status)) {
    throw new Error(`${name}: fallow exited ${result.status}\n${result.stderr}\n${result.stdout}`);
  }
  const report = JSON.parse(result.stdout);
  const unused = report.unused_dependencies?.filter(
    (finding) => finding.package_name === "@repro/lib"
      && finding.path === "packages/app/package.json",
  ).length ?? 0;
  const matched = unused === expectedUnused && report.total_issues === expectedUnused
    && result.status === (expectedUnused === 0 ? 0 : 1);
  if (!matched) mismatches++;
  console.log(`${matched ? "MATCH" : "CHANGED"} ${name}: unused @repro/lib=${unused}; total=${report.total_issues}; exit=${result.status}`);
  observations.push({ name, expectedUnused, unused, total: report.total_issues, exit: result.status, matched });
}

function withWorkspace(name, callback) {
  const temporary = mkdtempSync(join(tmpdir(), "fallow-repro-"));
  const workspace = join(temporary, "workspace");
  try {
    cpSync(join(root, "repros", name), workspace, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).some((part) => ["node_modules", ".fallow", ".git"].includes(part)),
    });
    // Link local workspace packages without fetching external dependencies.
    const install = run("pnpm", ["install", "--offline", "--ignore-scripts"], workspace);
    if (install.status !== 0) throw new Error(install.stderr || install.stdout);
    callback(workspace);
  } finally {
    // Remove only the temporary directory created by this run.
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (selected === "all" || selected === "2952") {
  withWorkspace("2952-imports-alias", (workspace) => {
    analyze(workspace, "2952-alias", 1);
    const entry = join(workspace, "packages/app/src/index.ts");
    writeFileSync(entry, readFileSync(entry, "utf8").replace('"#lib/hello"', '"@repro/lib/hello"'));
    analyze(workspace, "2952-direct-import", 0);
  });
}

if (selected === "all" || selected === "2953") {
  withWorkspace("2953-ignore-dependencies-glob", (workspace) => {
    analyze(workspace, "2953-no-ignore", 1);
    const config = join(workspace, ".fallowrc.json");
    writeFileSync(config, JSON.stringify({ ignoreDependencies: ["@repro/lib"] }));
    analyze(workspace, "2953-exact-name", 0);
    writeFileSync(config, JSON.stringify({ ignoreDependencies: ["@repro/*"] }));
    analyze(workspace, "2953-glob", 1);
  });
}

writeFileSync(join(results, `summary-${selected}.json`), JSON.stringify({
  version: fallowVersion, node: process.version,
  platform: process.platform, arch: process.arch, observations,
}, null, 2) + "\n");
console.log(`\n${mismatches === 0 ? "All cases match the reported 3.30.0 behavior." : `${mismatches} case(s) differ from the reported 3.30.0 behavior.`}`);
console.log("JSON reports: results/");
process.exitCode = mismatches === 0 ? 0 : 1;
