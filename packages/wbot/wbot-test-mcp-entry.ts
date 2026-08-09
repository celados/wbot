#!/usr/bin/env bun

import { DEFAULT_WBOT_TEST_PLATFORM_URL } from "./wbot-config";
import { runWbotMcpServer } from "./wbot-mcp";

await runWbotMcpServer(DEFAULT_WBOT_TEST_PLATFORM_URL);
