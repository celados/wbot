import type { Source, SourceResult } from "@celados/argc/values";

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

export const DEFAULT_WBOT_PLATFORM_URL = "https://wbot-api-prod.celados.com";
export const TEST_WBOT_PLATFORM_URL = "https://wbot-api-test.celados.com";

type WbotEnvironment = Record<string, string | undefined>;

const credentialsSchema = v.strictObject({
  apiKey: v.pipe(v.string(), v.minLength(1)),
});

export const wbotCredentialsPath = (environment: WbotEnvironment) => {
  const configRoot = environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configRoot, "wbot", "credentials.json");
};

export const resolveWbotPlatformUrl = (environment: WbotEnvironment = process.env) =>
  environment.WBOT_PLATFORM_URL ?? DEFAULT_WBOT_PLATFORM_URL;

const isTestPlatform = (url: string) => {
  try {
    return new URL(url).origin === TEST_WBOT_PLATFORM_URL;
  } catch {
    return false;
  }
};

/** The key saved by `wbot auth set`: the public, user-facing credential store. */
export const storedCredentials: Source = {
  label: "wbot auth set ($XDG_CONFIG_HOME/wbot/credentials.json)",
  read: async (): Promise<SourceResult> => {
    let source: string;
    try {
      source = await readFile(wbotCredentialsPath(process.env), "utf8");
    } catch (error) {
      return isMissingFileError(error)
        ? {
            found: false,
            reason: "not configured",
            code: "not_configured",
            hint: "run `wbot auth set` in an interactive terminal, or set WBOT_API_KEY",
          }
        : {
            found: false,
            reason: "unreadable",
            code: "unreadable_credentials",
            hint: "run `wbot auth set` again, or set WBOT_API_KEY",
          };
    }
    try {
      return { found: true, value: v.parse(credentialsSchema, JSON.parse(source)).apiKey };
    } catch {
      // Never echo the file: a damaged file may still hold most of a key.
      return {
        found: false,
        reason: "invalid credentials file",
        code: "invalid_credentials",
        hint: "run `wbot auth set` again, or set WBOT_API_KEY",
      };
    }
  },
};

/**
 * The team vault entry is the *test* tenant key. It is consulted only when the
 * CLI targets the test platform, so a production call never silently receives
 * a test key (and external users, who target production, never reach latch).
 */
export const onlyForTestPlatform = (source: Source): Source => ({
  label: `${source.label}, only when WBOT_PLATFORM_URL=${TEST_WBOT_PLATFORM_URL}`,
  read: () =>
    isTestPlatform(resolveWbotPlatformUrl())
      ? source.read()
      : {
          found: false,
          reason: "not the test platform",
          code: "not_test_platform",
          hint: `the vault entry is the test tenant key; it is used only with WBOT_PLATFORM_URL=${TEST_WBOT_PLATFORM_URL}`,
        },
});

export const storeWbotApiKey = async (environment: WbotEnvironment, apiKey: string) => {
  if (apiKey.length === 0) throw new Error("wbot API key must be non-empty.");
  const path = wbotCredentialsPath(environment);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ apiKey })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

const isMissingFileError = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
