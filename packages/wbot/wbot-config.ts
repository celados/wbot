import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

import type { PlatformClient } from "./platform-client";

import { createPlatformClient } from "./platform-client";

export const DEFAULT_WBOT_PLATFORM_URL = "https://wbot-api-prod.celados.com";
export const DEFAULT_WBOT_TEST_PLATFORM_URL = "https://wbot-api-test.celados.com";

type WbotEnvironment = Record<string, string | undefined>;

export type WbotConfig = {
  apiKey: string;
  baseUrl: string;
};

const credentialsSchema = v.strictObject({
  apiKey: v.pipe(v.string(), v.minLength(1)),
});

export const wbotCredentialsPath = (environment: WbotEnvironment) => {
  const configRoot = environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(configRoot, "wbot", "credentials.json");
};

export const resolveWbotConfig = async (
  environment: WbotEnvironment,
  defaultPlatformUrl = DEFAULT_WBOT_PLATFORM_URL,
): Promise<WbotConfig> => {
  const apiKey =
    environment.WBOT_API_KEY === undefined || environment.WBOT_API_KEY.length === 0
      ? await readStoredApiKey(environment)
      : environment.WBOT_API_KEY;
  return {
    apiKey,
    baseUrl: environment.WBOT_PLATFORM_URL ?? defaultPlatformUrl,
  };
};

export const storeWbotApiKey = async (environment: WbotEnvironment, apiKey: string) => {
  if (apiKey.length === 0) throw new Error("wbot API key must be non-empty.");
  const path = wbotCredentialsPath(environment);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ apiKey })}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
};

export const createWbotPlatformClientFromEnvironment = (
  environment: WbotEnvironment,
  defaultPlatformUrl = DEFAULT_WBOT_PLATFORM_URL,
): Promise<PlatformClient> =>
  resolveWbotConfig(environment, defaultPlatformUrl).then((config) =>
    createPlatformClient({
      baseUrl: config.baseUrl,
      tenantApiKey: config.apiKey,
    }),
  );

const readStoredApiKey = async (environment: WbotEnvironment) => {
  const path = wbotCredentialsPath(environment);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error("Missing wbot API key. Run `wbot auth set` or set WBOT_API_KEY.");
    }
    throw new Error("Unable to read wbot credentials. Run `wbot auth set` again.");
  }
  try {
    const parsed = v.parse(credentialsSchema, JSON.parse(source));
    return parsed.apiKey;
  } catch {
    throw new Error("Invalid wbot credentials. Run `wbot auth set` again or set WBOT_API_KEY.");
  }
};

const isMissingFileError = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
