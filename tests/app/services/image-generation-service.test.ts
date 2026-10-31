import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { configMock, providersMock, serverVersion } = vi.hoisted(() => ({
  configMock: {
    opencode: {
      serverVersion: "v2",
      apiUrl: "http://127.0.0.1:49374",
      username: "opencode",
      password: "secret",
      imageModel: { provider: "", modelId: "" },
    },
  },
  providersMock: vi.fn(),
  serverVersion: { value: "v2" as "v1" | "v2" },
}));

vi.mock("../../../src/config.js", () => ({ config: configMock }));

vi.mock("../../../src/opencode/client.js", () => ({
  get opencodeServerVersion() {
    return serverVersion.value;
  },
}));

vi.mock("../../../src/app/services/model-selection-service.js", () => ({
  readProvidersWhenListed: providersMock,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  generateImages,
  ImageGenerationFailedError,
  ImageGenerationUnsupportedError,
  ImageModelNotFoundError,
  resolveImageModel,
} from "../../../src/app/services/image-generation-service.js";

const IMAGE_CAPABILITIES = {
  temperature: true,
  reasoning: false,
  attachment: false,
  toolcall: false,
  input: { text: true, audio: false, image: false, video: false, pdf: false },
  output: { text: true, audio: false, image: true, video: false, pdf: false },
  interleaved: false,
};

const TEXT_ONLY_CAPABILITIES = {
  ...IMAGE_CAPABILITIES,
  output: { text: true, audio: false, image: false, video: false, pdf: false },
};

function providersResponse(providers: Array<{ id: string; models: Record<string, unknown> }>) {
  return { data: { providers }, error: null };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("image-generation-service", () => {
  beforeEach(() => {
    configMock.opencode.imageModel = { provider: "", modelId: "" };
    configMock.opencode.apiUrl = "http://127.0.0.1:49374";
    configMock.opencode.username = "opencode";
    configMock.opencode.password = "secret";
    serverVersion.value = "v2";
    providersMock.mockReset();
    providersMock.mockResolvedValue(
      providersResponse([
        { id: "openai", models: { "gpt-4o": { capabilities: TEXT_ONLY_CAPABILITIES } } },
      ]),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveImageModel", () => {
    it("prefers the configured image model", async () => {
      configMock.opencode.imageModel = { provider: "openrouter", modelId: "auto" };

      await expect(resolveImageModel()).resolves.toEqual({
        providerID: "openrouter",
        modelID: "auto",
      });
      expect(providersMock).not.toHaveBeenCalled();
    });

    it("falls back to the first offered model with image output", async () => {
      providersMock.mockResolvedValue(
        providersResponse([
          { id: "openai", models: { "gpt-4o": { capabilities: TEXT_ONLY_CAPABILITIES } } },
          { id: "openrouter", models: { auto: { capabilities: IMAGE_CAPABILITIES } } },
        ]),
      );

      await expect(resolveImageModel()).resolves.toEqual({
        providerID: "openrouter",
        modelID: "auto",
      });
    });

    it("returns null when no offered model has image output", async () => {
      await expect(resolveImageModel()).resolves.toBeNull();
    });

    it("returns null when the catalog cannot be read", async () => {
      providersMock.mockResolvedValue({ data: undefined, error: new Error("down") });

      await expect(resolveImageModel()).resolves.toBeNull();
    });
  });

  describe("generateImages", () => {
    beforeEach(() => {
      configMock.opencode.imageModel = { provider: "openrouter", modelId: "auto" };
    });

    it("rejects servers without the image endpoint", async () => {
      serverVersion.value = "v1";

      await expect(generateImages({ prompt: "a cat" })).rejects.toBeInstanceOf(
        ImageGenerationUnsupportedError,
      );
    });

    it("rejects when no image model is available", async () => {
      configMock.opencode.imageModel = { provider: "", modelId: "" };
      providersMock.mockResolvedValue(providersResponse([]));

      await expect(generateImages({ prompt: "a cat" })).rejects.toBeInstanceOf(
        ImageModelNotFoundError,
      );
    });

    it("posts to the image endpoint and decodes the returned base64", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            images: [{ data: Buffer.from("png-bytes").toString("base64"), mime: "image/png" }],
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await generateImages({ prompt: "a cat", count: 2 });

      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.buffer.toString()).toBe("png-bytes");
      expect(result.images[0]?.mime).toBe("image/png");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:49374/api/experimental/generate/image");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        model: { providerID: "openrouter", id: "auto" },
        prompt: "a cat",
        n: 2,
      });
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      );
    });

    it("sends no authorization header when the server has no password", async () => {
      configMock.opencode.password = "";
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          data: { images: [{ data: Buffer.from("x").toString("base64"), mime: "image/png" }] },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await generateImages({ prompt: "a cat" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });

    it("reports the server message when the request fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          jsonResponse(
            { _tag: "ProviderRequestError", message: "Free usage limit reached" },
            402,
          ),
        ),
      );

      await expect(generateImages({ prompt: "a cat" })).rejects.toThrow("Free usage limit reached");
    });

    it("reports a failed generation when no image is returned", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { images: [] } })));

      await expect(generateImages({ prompt: "a cat" })).rejects.toBeInstanceOf(
        ImageGenerationFailedError,
      );
    });

    it("reports a network failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

      await expect(generateImages({ prompt: "a cat" })).rejects.toThrow("connect ECONNREFUSED");
    });
  });
});
