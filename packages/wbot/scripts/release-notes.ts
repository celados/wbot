import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { extractChangelogSection } from "./release-preflight";

const packageRoot = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
  version?: unknown;
};
if (typeof packageJson.version !== "string") {
  throw new Error("packages/wbot/package.json must contain a string version.");
}
const changelog = await readFile(resolve(packageRoot, "CHANGELOG.md"), "utf8");
process.stdout.write(`${extractChangelogSection(changelog, packageJson.version)}\n`);
