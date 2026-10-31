import { config } from "../../config.js";
import { opencodeServerVersion } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import type { FavoriteModel } from "../types/model.js";
import { readProvidersWhenListed } from "./model-selection-service.js";

export interface GeneratedImage {
  buffer: Buffer;
  mime: string;
  name?: string;
}

export interface GeneratedImages {
  model: FavoriteModel;
  images: GeneratedImage[];
}

/** The configured server cannot generate images (V1 has no image endpoint). */
export class ImageGenerationUnsupportedError extends Error {
  constructor() {
    super("Image generation requires OpenCode V2");
    this.name = "ImageGenerationUnsupportedError";
  }
}

/** No model with image output is configured or offered by the server. */
export class ImageModelNotFoundError extends Error {
  constructor() {
    super("No image-capable model is configured or offered");
    this.name = "ImageModelNotFoundError";
  }
}

/** The provider refused the request (quota, rate limit, invalid prompt, ...). */
export class ImageGenerationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationFailedError";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function imageEndpoint(): string {
  const base = config.opencode.apiUrl.endsWith("/")
    ? config.opencode.apiUrl
    : `${config.opencode.apiUrl}/`;
  return new URL("api/experimental/generate/image", base).toString();
}

function authHeaders(): Record<string, string> {
  if (!config.opencode.password) return {};
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return { authorization: `Basic ${Buffer.from(credentials).toString("base64")}` };
}

function responseMessage(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    const data = (record.data ?? record) as Record<string, unknown>;
    const message = data.message ?? record.message;
    if (typeof message === "string" && message !== "") return message;
    if (typeof data._tag === "string") return data._tag;
  }
  return `HTTP ${status}`;
}

/**
 * The model used by `/image`: the configured image model first, otherwise the first model
 * the server offers with image output.
 */
export async function resolveImageModel(): Promise<FavoriteModel | null> {
  const configured = config.opencode.imageModel;
  if (configured.provider && configured.modelId) {
    return { providerID: configured.provider, modelID: configured.modelId };
  }

  const { data, error } = await readProvidersWhenListed();
  if (error || !data) {
    logger.warn("[Image] Cannot read the model catalog for an image model:", error);
    return null;
  }

  for (const provider of data.providers) {
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (model.capabilities?.output?.image === true) {
        return { providerID: provider.id, modelID };
      }
    }
  }

  return null;
}

export async function generateImages(input: {
  prompt: string;
  count?: number;
}): Promise<GeneratedImages> {
  if (opencodeServerVersion !== "v2") {
    throw new ImageGenerationUnsupportedError();
  }

  const model = await resolveImageModel();
  if (!model) {
    throw new ImageModelNotFoundError();
  }

  logger.info(`[Image] Generating image with ${model.providerID}/${model.modelID}`);

  let response: Response;
  try {
    response = await fetch(imageEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        model: { providerID: model.providerID, id: model.modelID },
        prompt: input.prompt,
        ...(input.count ? { n: input.count } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    const message = errorMessage(error);
    logger.error("[Image] Request failed:", error);
    throw new ImageGenerationFailedError(message);
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: { images?: Array<{ data?: string; mime?: string; name?: string }> } }
    | null;

  if (!response.ok) {
    const message = responseMessage(payload, response.status);
    logger.error(`[Image] Server answered ${response.status}: ${message}`);
    throw new ImageGenerationFailedError(message);
  }

  const images: GeneratedImage[] = [];
  for (const image of payload?.data?.images ?? []) {
    if (!image.data || !image.mime) continue;
    images.push({
      buffer: Buffer.from(image.data, "base64"),
      mime: image.mime,
      ...(image.name ? { name: image.name } : {}),
    });
  }

  if (images.length === 0) {
    logger.warn("[Image] Generation returned no images");
    throw new ImageGenerationFailedError("The model returned no images");
  }

  logger.info(`[Image] Generated ${images.length} image(s)`);
  return { model, images };
}
