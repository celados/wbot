import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

type SemVer = Readonly<{
  raw: string;
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly string[];
}>;

type ReleaseDecision = Readonly<{
  version: string;
  tag: string;
  prerelease: boolean;
  tagExists: boolean;
}>;

type ReleaseVersionSurface = Readonly<{
  name: string;
  version: string;
}>;

type ReleaseImpact = "compatible" | "breaking";

type CommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

const packagePath = "packages/wbot/package.json";
const changelogPath = "packages/wbot/CHANGELOG.md";
const semVerPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemVer(value: string): SemVer {
  const match = semVerPattern.exec(value);
  if (!match) {
    throw new Error(`Invalid SemVer version: ${value}`);
  }
  return Object.freeze({
    raw: value,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: Object.freeze(match[4]?.split(".") ?? []),
  });
}

export function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      if (leftIdentifier.length !== rightIdentifier.length) {
        return leftIdentifier.length < rightIdentifier.length ? -1 : 1;
      }
      return leftIdentifier < rightIdentifier ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function isInitialPush(beforeSha: string | undefined): boolean {
  return beforeSha !== undefined && /^0+$/.test(beforeSha);
}

export function requireMatchingReleaseVersions(
  expectedVersion: string,
  surfaces: readonly ReleaseVersionSurface[],
): void {
  for (const surface of surfaces) {
    if (surface.version !== expectedVersion) {
      throw new Error(`${surface.name} reports ${surface.version}, expected ${expectedVersion}.`);
    }
  }
}

export function requireVersionIncrement(
  previousVersion: string,
  nextVersion: string,
  impact: ReleaseImpact,
): void {
  const previous = parseSemVer(previousVersion);
  const next = parseSemVer(nextVersion);
  if (impact === "compatible") {
    const isNextPatch =
      next.major === previous.major &&
      next.minor === previous.minor &&
      next.patch === previous.patch + 1n &&
      next.prerelease.length === 0;
    if (!isNextPatch) {
      throw new Error(
        `Compatible change must increment patch from ${previous.raw}, received ${next.raw}.`,
      );
    }
    return;
  }
  const incrementsReleaseCandidate =
    previous.prerelease.length === 2 &&
    previous.prerelease[0] === "rc" &&
    /^\d+$/.test(previous.prerelease[1] ?? "") &&
    next.major === previous.major &&
    next.minor === previous.minor &&
    next.patch === previous.patch &&
    next.prerelease.length === 2 &&
    next.prerelease[0] === "rc" &&
    /^\d+$/.test(next.prerelease[1] ?? "") &&
    BigInt(next.prerelease[1] ?? "0") === BigInt(previous.prerelease[1] ?? "0") + 1n;
  if (incrementsReleaseCandidate) return;
  const promotesReleaseCandidate =
    previous.prerelease[0] === "rc" &&
    next.major === previous.major &&
    next.minor === previous.minor &&
    next.patch === previous.patch &&
    next.prerelease.length === 0;
  if (promotesReleaseCandidate) return;
  const startsBreakingMinor =
    previous.major === 0n &&
    next.major === 0n &&
    next.minor === previous.minor + 1n &&
    next.patch === 0n &&
    next.prerelease.length === 2 &&
    next.prerelease[0] === "rc" &&
    next.prerelease[1] === "1";
  if (!startsBreakingMinor) {
    throw new Error(
      `Breaking pre-1.0 change must increment minor and start with rc.1 from ${previous.raw}, received ${next.raw}.`,
    );
  }
}

export function readReleaseImpact(changelogSection: string): ReleaseImpact {
  const heading = /^### Breaking Changes\s*$/m.exec(changelogSection);
  if (!heading) return "compatible";
  const remainder = changelogSection.slice(heading.index + heading[0].length);
  const nextHeading = /^### /m.exec(remainder);
  const content = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
  return /^\s*[-*] /m.test(content) ? "breaking" : "compatible";
}

export function extractChangelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const prefix = `## ${version} - `;
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start === -1) throw new Error(`Changelog must contain version ${version}.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines
    .slice(start, next === -1 ? lines.length : next)
    .join("\n")
    .trimEnd();
}

export function decideRelease(
  versionValue: string,
  tags: readonly string[],
  targetSha: string,
  tagTargets: ReadonlyMap<string, string>,
): ReleaseDecision {
  const version = parseSemVer(versionValue);
  const tag = `v${version.raw}`;
  const releaseTags = tags.flatMap((candidate) => {
    if (!candidate.startsWith("v")) return [];
    try {
      return [{ tag: candidate, version: parseSemVer(candidate.slice(1)) }];
    } catch {
      return [];
    }
  });
  const existingTarget = tagTargets.get(tag);
  if (existingTarget !== undefined && existingTarget !== targetSha) {
    throw new Error(`Existing tag ${tag} points to ${existingTarget}, not ${targetSha}.`);
  }
  for (const existing of releaseTags) {
    if (existing.tag === tag) continue;
    if (compareSemVer(version, existing.version) <= 0) {
      throw new Error(
        `Version ${version.raw} must be greater than existing release tag ${existing.tag}.`,
      );
    }
  }
  return Object.freeze({
    version: version.raw,
    tag,
    prerelease: version.prerelease.length > 0,
    tagExists: existingTarget !== undefined,
  });
}

if (import.meta.main) await main();

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2));
  if (options.ref !== "refs/heads/main") {
    throw new Error(`Releases must run from refs/heads/main, received ${options.ref}.`);
  }
  const packageJson = await readPackageJson(resolve(packagePath));
  const version = requireVersion(packageJson);
  requireMatchingReleaseVersions(version, await readRepositoryReleaseVersions(process.cwd()));
  const changelogSection = extractChangelogSection(
    await readFile(resolve(changelogPath), "utf8"),
    version,
  );
  if (options.eventName === "push" && options.beforeSha !== undefined) {
    if (isInitialPush(options.beforeSha)) {
      await writeOutputs(options.output, { release: "false" });
      process.stdout.write("Initial package publication is manual; release skipped.\n");
      return;
    }
    const previousPackageJson = await readPackageJsonAtCommit(options.beforeSha);
    if (previousPackageJson !== undefined) {
      const previousVersion = requireVersion(previousPackageJson);
      if (previousVersion === version) {
        await writeOutputs(options.output, { release: "false" });
        process.stdout.write("Package version did not change; release skipped.\n");
        return;
      }
      requireVersionIncrement(previousVersion, version, readReleaseImpact(changelogSection));
    }
  }
  const tags = (await runCommand(["git", "tag", "--list"], process.cwd())).stdout
    .split("\n")
    .filter(Boolean);
  const tagTargets = new Map<string, string>();
  for (const tag of tags) {
    const target = (
      await runCommand(["git", "rev-list", "-n", "1", tag], process.cwd())
    ).stdout.trim();
    tagTargets.set(tag, target);
  }
  const decision = decideRelease(version, tags, options.targetSha, tagTargets);
  await writeOutputs(options.output, {
    release: "true",
    version: decision.version,
    tag: decision.tag,
    prerelease: String(decision.prerelease),
    tag_exists: String(decision.tagExists),
  });
  process.stdout.write(`Release preflight passed for ${decision.tag} at ${options.targetSha}.\n`);
}

async function readRepositoryReleaseVersions(
  repositoryRoot: string,
): Promise<readonly ReleaseVersionSurface[]> {
  const codexManifest = await readJson(
    resolve(repositoryRoot, "plugins/codex/wbot/.codex-plugin/plugin.json"),
  );
  const claudeManifest = await readJson(
    resolve(repositoryRoot, "plugins/claude/wbot/.claude-plugin/plugin.json"),
  );
  const marketplace = await readJson(
    resolve(repositoryRoot, "plugins/claude/.claude-plugin/marketplace.json"),
  );
  const codexMcp = await readJson(resolve(repositoryRoot, "plugins/codex/wbot/.mcp.json"));
  const claudeMcp = await readJson(resolve(repositoryRoot, "plugins/claude/wbot/.mcp.json"));
  return [
    { name: "Codex Plugin", version: requireStringProperty(codexManifest, "version") },
    { name: "Claude Plugin", version: requireStringProperty(claudeManifest, "version") },
    { name: "Claude marketplace", version: readMarketplaceVersion(marketplace) },
    { name: "Codex Plugin runtime", version: readPinnedRuntimeVersion(codexMcp) },
    { name: "Claude Plugin runtime", version: readPinnedRuntimeVersion(claudeMcp) },
  ];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function requireStringProperty(value: unknown, property: string): string {
  if (!value || typeof value !== "object" || !(property in value)) {
    throw new Error(`Release metadata must contain ${property}.`);
  }
  const result = (value as Record<string, unknown>)[property];
  if (typeof result !== "string") {
    throw new Error(`Release metadata ${property} must be a string.`);
  }
  return result;
}

function readMarketplaceVersion(value: unknown): string {
  if (!value || typeof value !== "object" || !("plugins" in value)) {
    throw new Error("Claude marketplace must contain plugins.");
  }
  const plugins = (value as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) throw new Error("Claude marketplace plugins must be an array.");
  const wbot = plugins.find(
    (plugin) => plugin && typeof plugin === "object" && "name" in plugin && plugin.name === "wbot",
  );
  return requireStringProperty(wbot, "version");
}

function readPinnedRuntimeVersion(value: unknown): string {
  if (!value || typeof value !== "object" || !("mcpServers" in value)) {
    throw new Error("Plugin MCP manifest must contain mcpServers.");
  }
  const servers = (value as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || !("wbot" in servers)) {
    throw new Error("Plugin MCP manifest must contain the wbot server.");
  }
  const server = (servers as { wbot?: unknown }).wbot;
  if (!server || typeof server !== "object" || !("args" in server)) {
    throw new Error("Plugin wbot server must contain args.");
  }
  const arguments_ = (server as { args?: unknown }).args;
  if (!Array.isArray(arguments_) || !arguments_.every((argument) => typeof argument === "string")) {
    throw new Error("Plugin wbot server args must be strings.");
  }
  const packageArgument = arguments_.find((argument) => argument.startsWith("@celados/wbot@"));
  const match = packageArgument?.match(/\/download\/v([^/]+)\/wbot-([^/]+)\.tgz$/);
  if (!match?.[1] || match[1] !== match[2]) {
    throw new Error("Plugin runtime must pin one versioned wbot artifact.");
  }
  return match[1];
}

function parseOptions(arguments_: readonly string[]): {
  eventName: string;
  beforeSha?: string;
  targetSha: string;
  ref: string;
  output: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Release preflight arguments must be --key value pairs.");
    }
    values.set(key.slice(2), value);
  }
  const eventName = requireOption(values, "event-name");
  const targetSha = requireOption(values, "target-sha");
  const ref = requireOption(values, "ref");
  const output = requireOption(values, "output");
  const beforeSha = values.get("before-sha");
  return { eventName, targetSha, ref, output, ...(beforeSha ? { beforeSha } : {}) };
}

function requireOption(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
}

async function readPackageJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readPackageJsonAtCommit(commit: string): Promise<unknown | undefined> {
  if (/^0+$/.test(commit)) return undefined;
  const result = await runCommand(["git", "show", `${commit}:${packagePath}`], process.cwd(), true);
  if (!result) return undefined;
  return JSON.parse(result.stdout) as unknown;
}

function requireVersion(value: unknown): string {
  if (!value || typeof value !== "object" || !("version" in value)) {
    throw new Error(`${packagePath} must contain a version.`);
  }
  const version = (value as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("Package version must be a string.");
  parseSemVer(version);
  return version;
}

async function writeOutputs(
  outputPath: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const content = Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  await appendFile(outputPath, content, "utf8");
}

function runCommand(command: readonly string[], cwd: string): Promise<CommandResult>;
function runCommand(
  command: readonly string[],
  cwd: string,
  allowFailure: true,
): Promise<CommandResult | undefined>;
async function runCommand(
  command: readonly string[],
  cwd: string,
  allowFailure = false,
): Promise<CommandResult | undefined> {
  const child = Bun.spawn([...command], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    if (allowFailure) return undefined;
    throw new Error(
      `Command failed (${exitCode}): ${command.join(" ")}\n${stdout}${stderr}`.trimEnd(),
    );
  }
  return { stdout, stderr };
}
