// @celsian/cli — celsian create command

import { scaffold, type Template } from "create-celsian";

export type { Template };

export async function createCommand(name: string, template: Template = "full"): Promise<void> {
  scaffold(name, template, "npm");
}
