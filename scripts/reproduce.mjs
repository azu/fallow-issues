import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selected = process.argv[2] ?? "all";
if (!["all", "2952", "2953", "script-file-entries"].includes(selected)) {
  console.error("Usage: pnpm repro [2952|2953|script-file-entries]");
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

function collectReport(workspace, name, extraArgs = []) {
  const result = run(fallow, ["dead-code", "--no-cache", "--format", "json", ...extraArgs], workspace);
  writeFileSync(join(results, `${name}.json`), result.stdout);
  writeFileSync(join(results, `${name}.stderr.txt`), result.stderr);
  if (![0, 1].includes(result.status)) {
    throw new Error(`${name}: fallow exited ${result.status}\n${result.stderr}\n${result.stdout}`);
  }
  const report = JSON.parse(result.stdout);
  return { result, report };
}

function analyze(workspace, name, expectedUnused) {
  const { result, report } = collectReport(workspace, name);
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

function withWorkspace(name, callback, { shareTooling = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "fallow-repro-"));
  const workspace = join(temporary, "workspace");
  try {
    cpSync(join(root, "repros", name), workspace, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/).some((part) => ["node_modules", ".fallow", ".git"].includes(part)),
    });
    if (shareTooling) {
      // Reuse the pinned tools already installed at the repository root.
      symlinkSync(join(root, "node_modules"), join(workspace, "node_modules"), "dir");
    } else {
      // Link local workspace packages without fetching external dependencies.
      const install = run("pnpm", ["install", "--offline", "--ignore-scripts"], workspace);
      if (install.status !== 0) throw new Error(install.stderr || install.stdout);
    }
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

if (selected === "all" || selected === "script-file-entries") {
  const knip = join(root, "node_modules", ".bin", "knip");
  const knipVersionResult = run(knip, ["--version"], root);
  if (knipVersionResult.status !== 0) throw new Error(knipVersionResult.stderr);
  const knipVersion = knipVersionResult.stdout.trim();
  console.log(`Knip ${knipVersion} (unused-file comparison)`);
  withWorkspace("script-file-entries", (workspace) => {
    const manifestPath = join(workspace, "package.json");
    const manifest = readFileSync(manifestPath, "utf8");
    const githubPath = join(workspace, ".github/workflows/ci.yml");
    const gitlabPath = join(workspace, ".gitlab-ci.yml");
    const configPath = join(workspace, ".fallowrc.json");
    const cases = [
      { name: "baseline", expectedUnused: 1 },
      { name: "package-glob", surface: "package", argument: '"**/*.ts"', expectedUnused: 0 },
      { name: "package-path", surface: "package", argument: "src/dead.ts", expectedUnused: 0 },
      { name: "github-glob", surface: "github", argument: '"**/*.ts"', expectedUnused: 0 },
      { name: "github-path", surface: "github", argument: "src/dead.ts", expectedUnused: 0 },
      { name: "gitlab-glob", surface: "gitlab", argument: '"**/*.ts"', expectedUnused: 0 },
      { name: "gitlab-path", surface: "gitlab", argument: "src/dead.ts", expectedUnused: 0 },
      ...["package", "github", "gitlab"].flatMap((surface) => [
        { name: `${surface}-lint-glob`, surface, command: 'oxlint "**/*.ts"', scriptName: "lint", expectedUnused: 0 },
        { name: `${surface}-lint-path`, surface, command: "oxlint src/dead.ts", scriptName: "lint", expectedUnused: 0 },
      ]),
      ...["package", "github", "gitlab"].map((surface) => ({
        name: `${surface}-node-runner-control`, surface, command: "node src/dead.ts",
        scriptName: "run-script", expectedUnused: 0, desiredUnused: 0,
        // Knip 6.38.0 does not discover this GitLab-only execution entry.
        knipExpectedUnused: surface === "gitlab" ? 1 : 0,
      })),
      { name: "explicit-entry-does-not-override", surface: "github", argument: '"**/*.ts"', config: { entry: ["src/index.ts"] }, expectedUnused: 0 },
      { name: "package-glob-production", surface: "package", argument: '"**/*.ts"', extraArgs: ["--production"], expectedUnused: 1 },
      { name: "github-glob-production", surface: "github", argument: '"**/*.ts"', extraArgs: ["--production"], expectedUnused: 0 },
    ];
    mkdirSync(dirname(githubPath), { recursive: true });
    for (const testCase of cases) {
      writeFileSync(manifestPath, manifest);
      for (const path of [githubPath, gitlabPath, configPath]) rmSync(path, { force: true });
      const command = testCase.command ?? `oxfmt --check ${testCase.argument}`;
      const scriptName = testCase.scriptName ?? "fmt";
      const ciCommand = command.startsWith("node ") ? command : `npx ${command}`;
      if (testCase.surface === "package") {
        writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifest), scripts: { [scriptName]: command } }, null, 2));
      } else if (testCase.surface === "github") {
        writeFileSync(githubPath, `on: push\njobs:\n  ${scriptName}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${ciCommand}\n`);
      } else if (testCase.surface === "gitlab") {
        writeFileSync(gitlabPath, `${scriptName}:\n  script:\n    - ${ciCommand}\n`);
      }
      if (testCase.config) writeFileSync(configPath, JSON.stringify(testCase.config));
      const name = `script-file-entries-${testCase.name}`;
      const { result, report } = collectReport(workspace, name, testCase.extraArgs);
      const unused = report.unused_files?.filter((finding) => finding.path === "src/dead.ts").length ?? 0;
      const expectedEntries = testCase.expectedUnused === 0 ? 2 : 1;
      const desiredUnused = testCase.desiredUnused ?? 1;
      const matched = unused === testCase.expectedUnused && report.total_issues === testCase.expectedUnused
        && result.status === (testCase.expectedUnused === 0 ? 0 : 1)
        && report.entry_points?.total === expectedEntries;
      if (!matched) mismatches++;
      console.log(`${matched ? "MATCH" : "CHANGED"} ${name}: unused src/dead.ts=${unused}; total=${report.total_issues}; exit=${result.status}; entries=${JSON.stringify(report.entry_points)}`);
      observations.push({ name, expectedUnused: testCase.expectedUnused, desiredUnused,
        matchesDesiredBehavior: unused === desiredUnused, expectedEntries, unused, total: report.total_issues,
        exit: result.status, matched, entryPoints: report.entry_points,
        diagnostics: report.workspace_diagnostics });
      // Compare the same unconfigured fixture; Fallow-specific config/modes are separate checks.
      if (!testCase.config && !testCase.extraArgs) {
        const knipResult = run(knip, ["--include", "files", "--reporter", "json", "--no-progress", "--no-config-hints"], workspace);
        writeFileSync(join(results, `${name}.knip.json`), knipResult.stdout);
        writeFileSync(join(results, `${name}.knip.stderr.txt`), knipResult.stderr);
        if (![0, 1].includes(knipResult.status)) throw new Error(`${name}: Knip exited ${knipResult.status}\n${knipResult.stderr}`);
        const knipReport = JSON.parse(knipResult.stdout);
        const knipFiles = knipReport.issues.flatMap((issue) => issue.files ?? []);
        const knipUnused = knipFiles.filter((file) => file.name === "src/dead.ts").length;
        const knipExpectedUnused = testCase.knipExpectedUnused ?? desiredUnused;
        const knipMatched = knipUnused === knipExpectedUnused && knipFiles.length === knipExpectedUnused
          && knipResult.status === (knipExpectedUnused === 0 ? 0 : 1);
        if (!knipMatched) mismatches++;
        console.log(`${knipMatched ? "MATCH" : "CHANGED"} ${name} (Knip): unused src/dead.ts=${knipUnused}; exit=${knipResult.status}`);
        observations.push({ name: `${name}-knip`, version: knipVersion, expectedUnused: knipExpectedUnused,
          desiredUnused, matchesDesiredBehavior: knipUnused === desiredUnused,
          unused: knipUnused, exit: knipResult.status, matched: knipMatched });
      }
      if (["baseline", "github-glob"].includes(testCase.name)) {
        for (const [suffix, args] of [
          ["human", ["dead-code", "--no-cache"]],
          ["list", ["list", "--no-cache"]],
        ]) {
          const output = run(fallow, args, workspace);
          writeFileSync(join(results, `${name}.${suffix}.txt`), output.stdout + output.stderr);
          if (![0, 1].includes(output.status)) throw new Error(`${name} ${suffix}: ${output.stderr}`);
        }
      }
    }
  }, { shareTooling: true });
}

writeFileSync(join(results, `summary-${selected}.json`), JSON.stringify({
  version: fallowVersion, node: process.version,
  platform: process.platform, arch: process.arch, observations,
}, null, 2) + "\n");
console.log(`\n${mismatches === 0 ? "All cases match the documented analyzer behavior." : `${mismatches} case(s) differ from the documented analyzer behavior.`}`);
console.log("JSON reports: results/");
process.exitCode = mismatches === 0 ? 0 : 1;
