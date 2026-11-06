import { defineValueSource, env } from "@celados/argc/values";
import { latch } from "@celados/latch-source";
import * as v from "valibot";

import type { WbotClient } from "./platform-client";

import { createPlatformClient } from "./platform-client";
import { onlyForTestPlatform, resolveWbotPlatformUrl, storedCredentials } from "./wbot-config";

export const wbotValues = defineValueSource({
  WBOT_API_KEY: {
    schema: v.pipe(v.string(), v.minLength(1)),
    description: "wbot Tenant API key",
    get: [
      env("WBOT_API_KEY"),
      storedCredentials,
      onlyForTestPlatform(
        latch("c0b64757-d366-4f25-a951-947d796e392e/password", {
          item: "wbot / test / platform-tenant-key",
        }),
      ),
    ],
  },
});

/** Resolves the key lazily: only commands that call the platform reach a source. */
export const createWbotPlatformClient = async (): Promise<WbotClient> =>
  createPlatformClient({
    baseUrl: resolveWbotPlatformUrl(),
    tenantApiKey: await wbotValues.WBOT_API_KEY,
    onDeprecationWarning: (warning) => {
      process.stderr.write(`${warning}\n`);
    },
  });
