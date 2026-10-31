import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, Context } from "grammy";

const { generateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
}));

vi.mock("../../../src/app/services/image-generation-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../src/app/services/image-generation-service.js")
  >("../../../src/app/services/image-generation-service.js");
  return {
    ...actual,
    generateImages: generateMock,
  };
});

import { t } from "../../../src/i18n/index.js";
import { imageCommand } from "../../../src/bot/commands/image-command.js";
import {
  ImageGenerationFailedError,
  ImageGenerationUnsupportedError,
  ImageModelNotFoundError,
} from "../../../src/app/services/image-generation-service.js";

function createContext(match: string) {
  const reply = vi.fn().mockResolvedValue({ message_id: 42 });
  const replyWithPhoto = vi.fn().mockResolvedValue({});
  const replyWithDocument = vi.fn().mockResolvedValue({});
  const editMessageText = vi.fn().mockResolvedValue({});
  const deleteMessage = vi.fn().mockResolvedValue(true);

  const ctx = {
    match,
    chat: { id: 7 },
    reply,
    replyWithPhoto,
    replyWithDocument,
    api: { editMessageText, deleteMessage },
  } as unknown as CommandContext<Context>;

  return { ctx, reply, replyWithPhoto, replyWithDocument, editMessageText, deleteMessage };
}

describe("bot/commands/image", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("shows usage without a prompt", async () => {
    const { ctx, reply } = createContext("   ");

    await imageCommand(ctx);

    expect(reply).toHaveBeenCalledWith(t("image.usage"));
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("sends the generated image as a photo", async () => {
    generateMock.mockResolvedValue({
      model: { providerID: "openrouter", modelID: "auto" },
      images: [{ buffer: Buffer.from("png"), mime: "image/png" }],
    });
    const { ctx, replyWithPhoto, deleteMessage } = createContext("a cat");

    await imageCommand(ctx);

    expect(replyWithPhoto).toHaveBeenCalledTimes(1);
    expect(replyWithPhoto.mock.calls[0]?.[1]).toEqual({ caption: "a cat" });
    expect(deleteMessage).toHaveBeenCalledWith(7, 42);
  });

  it("sends a result larger than the photo limit as a document", async () => {
    generateMock.mockResolvedValue({
      model: { providerID: "openrouter", modelID: "auto" },
      images: [{ buffer: Buffer.alloc(10 * 1024 * 1024 + 1), mime: "image/png" }],
    });
    const { ctx, replyWithPhoto, replyWithDocument } = createContext("a cat");

    await imageCommand(ctx);

    expect(replyWithPhoto).not.toHaveBeenCalled();
    expect(replyWithDocument).toHaveBeenCalledTimes(1);
  });

  it("explains that V1 cannot generate images", async () => {
    generateMock.mockRejectedValue(new ImageGenerationUnsupportedError());
    const { ctx, editMessageText } = createContext("a cat");

    await imageCommand(ctx);

    expect(editMessageText).toHaveBeenCalledWith(7, 42, t("image.requires_v2"));
  });

  it("explains how to configure an image model", async () => {
    generateMock.mockRejectedValue(new ImageModelNotFoundError());
    const { ctx, editMessageText } = createContext("a cat");

    await imageCommand(ctx);

    expect(editMessageText).toHaveBeenCalledWith(7, 42, t("image.no_model"));
  });

  it("shows the provider error message", async () => {
    generateMock.mockRejectedValue(new ImageGenerationFailedError("rate limited"));
    const { ctx, editMessageText } = createContext("a cat");

    await imageCommand(ctx);

    expect(editMessageText).toHaveBeenCalledWith(
      7,
      42,
      t("image.failed", { error: "rate limited" }),
    );
  });
});
