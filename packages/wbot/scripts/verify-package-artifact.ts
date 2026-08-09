import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type PackResult = Readonly<{
  filename: string;
  files?: readonly Readonly<{ path: string }>[];
}>;

type PackageJson = Readonly<{
  name?: unknown;
  version?: unknown;
  private?: unknown;
}>;

const allowedEntries = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "platform-client.ts",
  "platform-types.ts",
  "wbot-cli.ts",
  "wbot-config.ts",
  "wbot-mcp-entry.ts",
  "wbot-mcp.ts",
  "wbot-test-cli.ts",
  "wbot-test-mcp-entry.ts",
]);
const forbiddenPathPattern =
  /(^|\/)(?:\.env(?:\..*)?|\.npmrc|bunfig\.toml|[^/]*\.test\.[^/]+|__tests__|evals?|scripts?|sources?|policy)(?:\/|$)/i;
const secretMaterialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
] as const;

const packageRoot = resolve(import.meta.dir, "..");
const outputDirectory = parseOutputDirectory(Bun.argv.slice(2));
const temporaryRoot = await mkdtemp(join(tmpdir(), "wbot-package-artifact-"));
const packDirectory = join(temporaryRoot, "pack");
const consumerDirectory = join(temporaryRoot, "consumer");

try {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(consumerDirectory, { recursive: true }),
  ]);
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as PackageJson;
  if (packageJson.name !== "@celados/wbot" || typeof packageJson.version !== "string") {
    throw new Error("The package must have name @celados/wbot and a string version.");
  }
  if (packageJson.private !== true) {
    throw new Error("The wbot package must remain private to prevent registry publication.");
  }

  const packed = await runCommand(
    ["npm", "pack", "--json", "--pack-destination", packDirectory, packageRoot],
    temporaryRoot,
  );
  const packResults = JSON.parse(packed.stdout) as PackResult[];
  const packResult = packResults[0];
  if (!packResult?.filename || !packResult.files) {
    throw new Error("npm pack did not report the package filename and contents.");
  }
  await verifyPackageContents(packResult.files.map((file) => file.path));

  const tarballPath = join(packDirectory, packResult.filename);
  const globalDirectory = join(consumerDirectory, "global");
  const globalBinDirectory = join(consumerDirectory, "bin");
  await runCommand(["bun", "add", "--global", `@celados/wbot@${tarballPath}`], consumerDirectory, {
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: globalBinDirectory,
    BUN_INSTALL_CACHE_DIR: join(consumerDirectory, "cache"),
  });

  const installedPackageJson = await readFile(
    join(globalDirectory, "node_modules", "@celados", "wbot", "package.json"),
    "utf8",
  );
  if (installedPackageJson.includes('"catalog:"')) {
    throw new Error("The installed wbot artifact still contains workspace-only catalog ranges.");
  }

  const wbot = join(globalBinDirectory, "wbot");
  const wbotTest = join(globalBinDirectory, "wbot-test");
  const schema = await runCommand([wbot, "@schema"], consumerDirectory);
  const testSchema = await runCommand([wbotTest, "@schema"], consumerDirectory);
  for (const command of ["list(input:", "history(input:", "updates(input:"]) {
    if (!schema.stdout.includes(command)) {
      throw new Error(`The installed wbot artifact is missing ${command}`);
    }
  }
  if (testSchema.stdout !== schema.stdout) {
    throw new Error("The installed wbot-test CLI schema differs from wbot.");
  }
  for (const binary of [
    wbot,
    join(globalBinDirectory, "wbot-mcp"),
    wbotTest,
    join(globalBinDirectory, "wbot-test-mcp"),
  ]) {
    await runCommand(["test", "-x", binary], consumerDirectory);
  }

  if (outputDirectory) {
    await writeReleaseAssets(tarballPath, packageJson.version, outputDirectory);
  }
  process.stdout.write(`Verified installable wbot artifact: ${packResult.filename}\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parseOutputDirectory(arguments_: readonly string[]): string | undefined {
  if (arguments_.length === 0) return undefined;
  if (arguments_.length !== 2 || arguments_[0] !== "--output-dir" || !arguments_[1]) {
    throw new Error("Usage: verify-package-artifact.ts [--output-dir <directory>]");
  }
  return resolve(arguments_[1]);
}

async function verifyPackageContents(paths: readonly string[]): Promise<void> {
  for (const required of [
    "wbot-cli.ts",
    "wbot-mcp-entry.ts",
    "wbot-test-cli.ts",
    "wbot-test-mcp-entry.ts",
    "package.json",
  ]) {
    if (!paths.includes(required)) {
      throw new Error(`The package is missing required entry: ${required}`);
    }
  }
  for (const path of paths) {
    if (!allowedEntries.has(path)) {
      throw new Error(`Unexpected package entry: ${path}`);
    }
    if (forbiddenPathPattern.test(path)) {
      throw new Error(`Forbidden package entry: ${path}`);
    }
    const content = await readFile(join(packageRoot, path), "utf8");
    if (secretMaterialPatterns.some((pattern) => pattern.test(content))) {
      throw new Error(`Potential secret material found in package entry: ${path}`);
    }
  }
}

async function writeReleaseAssets(
  tarballPath: string,
  version: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const exactName = `wbot-${version}.tgz`;
  const stableName = "wbot.tgz";
  const exactPath = join(destination, exactName);
  const stablePath = join(destination, stableName);
  await copyFile(tarballPath, exactPath, constants.COPYFILE_EXCL);
  await copyFile(tarballPath, stablePath, constants.COPYFILE_EXCL);
  const digest = createHash("sha256")
    .update(await readFile(tarballPath))
    .digest("hex");
  await writeFile(
    join(destination, "SHA256SUMS"),
    `${digest}  ${exactName}\n${digest}  ${stableName}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  additionalEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...Bun.env, ...additionalEnvironment, CI: "1" },
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
    throw new Error(
      `Command failed (${exitCode}): ${command.map((value) => basename(value)).join(" ")}\n${stdout}${stderr}`.trimEnd(),
    );
  }
  return { stdout, stderr };
}
