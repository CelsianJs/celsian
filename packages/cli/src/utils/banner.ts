// @celsian/cli — Banner + version

const VERSION = "0.1.0";

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
