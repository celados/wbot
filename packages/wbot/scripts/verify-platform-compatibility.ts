import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const artifactPath = parseArtifactPath(Bun.argv.slice(2));
const platformUrl = requireEnvironment("WBOT_PLATFORM_URL");
const apiKey = requireEnvironment("WBOT_API_KEY");
const temporaryRoot = await mkdtemp(join(tmpdir(), "wbot-platform-compatibility-"));

try {
  const globalDirectory = join(temporaryRoot, "global");
  const globalBinDirectory = join(temporaryRoot, "bin");
  const environment = {
    BUN_INSTALL_GLOBAL_DIR: globalDirectory,
    BUN_INSTALL_BIN: globalBinDirectory,
    BUN_INSTALL_CACHE_DIR: join(temporaryRoot, "cache"),
    WBOT_PLATFORM_URL: platformUrl,
    WBOT_API_KEY: apiKey,
  };
  await runCommand(
    ["bun", "add", "--global", `@celados/wbot@${artifactPath}`],
    temporaryRoot,
    environment,
    [apiKey],
  );
  const conversationsResult = await runCommand(
    [join(globalBinDirectory, "wbot"), "conversations.list", '{ "limit": 1 }'],
    temporaryRoot,
    environment,
    [apiKey],
  );
  const conversationId = readFirstConversationId(conversationsResult.stdout);
  const messageQuery = JSON.stringify({ conversationId, limit: 1 });
  await runCommand(
    [join(globalBinDirectory, "wbot"), "messages.history", messageQuery],
    temporaryRoot,
    environment,
    [apiKey],
  );
  await runCommand(
    [join(globalBinDirectory, "wbot"), "messages.updates", messageQuery],
    temporaryRoot,
    environment,
    [apiKey],
  );
  process.stdout.write(
    `Verified ${basename(artifactPath)} against the current test Platform contract.\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function readFirstConversationId(stdout: string): string {
  const payload = JSON.parse(stdout) as unknown;
  if (!payload || typeof payload !== "object" || !("items" in payload)) {
    throw new Error("Candidate wbot artifact did not return a conversation page.");
  }
  const { items } = payload as { items?: unknown };
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      "Current test Platform returned no conversations; message read compatibility cannot be verified.",
    );
  }
  const firstConversation = items[0];
  if (
    !firstConversation ||
    typeof firstConversation !== "object" ||
    !("id" in firstConversation) ||
    typeof firstConversation.id !== "string"
  ) {
    throw new Error("Candidate wbot artifact returned a conversation without a valid id.");
  }
  return firstConversation.id;
}

function parseArtifactPath(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--artifact" || !arguments_[1]) {
    throw new Error("Usage: verify-platform-compatibility.ts --artifact <wbot.tgz>");
  }
  return resolve(arguments_[1]);
}

function requireEnvironment(name: "WBOT_PLATFORM_URL" | "WBOT_API_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Stable release compatibility gate requires ${name}.`);
  }
  return value;
}

async function runCommand(
  command: readonly string[],
  cwd: string,
  additionalEnvironment: Readonly<Record<string, string>>,
  secrets: readonly string[],
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
    const diagnostic = redact(`${stdout}${stderr}`.trimEnd(), secrets);
    throw new Error(
      `Command failed (${exitCode}): ${command.map((value) => basename(value)).join(" ")}\n${diagnostic}`.trimEnd(),
    );
  }
  return { stdout, stderr };
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (result, secret) => (secret.length > 0 ? result.replaceAll(secret, "[REDACTED]") : result),
    value,
  );
}
