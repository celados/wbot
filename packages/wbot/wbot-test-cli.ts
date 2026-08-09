#!/usr/bin/env bun

import { DEFAULT_WBOT_TEST_PLATFORM_URL } from "./wbot-config";
import { runWbotCli } from "./wbot-cli";

await runWbotCli(DEFAULT_WBOT_TEST_PLATFORM_URL);
