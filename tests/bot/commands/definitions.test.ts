import { afterEach, describe, expect, it, vi } from "vitest";

async function loadDefinitions(serverVersion: "v1" | "v2") {
  vi.stubEnv("OPENCODE_SERVER_VERSION", serverVersion);
  vi.resetModules();
  return import("../../../src/bot/commands/definitions.js");
}

describe("bot/commands/definitions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lists /reload right after /opencode_stop on V2", async () => {
    const { BOT_COMMANDS, BUILT_IN_COMMAND_NAMES, getLocalizedBotCommands } =
      await loadDefinitions("v2");

    const commands = BOT_COMMANDS.map(({ command }) => command);
    expect(commands[commands.indexOf("opencode_stop") + 1]).toBe("reload");
    expect(getLocalizedBotCommands().map(({ command }) => command)).toEqual(commands);
    expect(BUILT_IN_COMMAND_NAMES).toContain("reload");
  });

  it("lists /image on V2 and leaves it out on V1", async () => {
    const v2 = await loadDefinitions("v2");
    expect(v2.BOT_COMMANDS.map(({ command }) => command)).toContain("image");

    const v1 = await loadDefinitions("v1");
    expect(v1.BOT_COMMANDS.map(({ command }) => command)).not.toContain("image");
    expect(v1.BUILT_IN_COMMAND_NAMES).not.toContain("image");
  });

  it("leaves /reload out everywhere on V1", async () => {
    const { BOT_COMMANDS, BUILT_IN_COMMAND_NAMES, getLocalizedBotCommands } =
      await loadDefinitions("v1");

    expect(BOT_COMMANDS.map(({ command }) => command)).not.toContain("reload");
    expect(getLocalizedBotCommands().map(({ command }) => command)).not.toContain("reload");
    expect(BUILT_IN_COMMAND_NAMES).not.toContain("reload");
  });
});
