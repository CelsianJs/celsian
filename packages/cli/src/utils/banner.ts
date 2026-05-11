// @celsian/cli — Banner + version

import { readFileSync } from "node:fs";

function readPackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.length > 0 ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readPackageVersion();

export function printBanner(): void {
  console.log(`
  ╔═╗╔═╗╦  ╔═╗╦╔═╗╔╗╔
  ║  ║╣ ║  ╚═╗║╠═╣║║║
  ╚═╝╚═╝╩═╝╚═╝╩╩ ╩╝╚╝  v${VERSION}
  `);
}

export function getVersion(): string {
  return VERSION;
}
