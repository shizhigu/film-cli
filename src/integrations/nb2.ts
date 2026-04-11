/**
 * Nano Banana 2 (Gemini 3.1 Flash Image) integration for film-cli.
 *
 * Generates cinematic first frames via OpenRouter API.
 * Supports multiple reference images for character/scene consistency.
 *
 * Key production rules:
 * - Always pass character portrait refs via --ref
 * - Always pass scene establishing ref if continuing a location
 * - Never start prompt with title text (renders as on-screen watermark)
 * - Use frozen mid-motion descriptions, not static poses
 * - NB2 understands professional cinema vocabulary (ARRI, Cooke, f/2.0, etc.)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, extname } from "path";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface NB2Config {
  apiKey: string;
  model?: string;
}

export interface GenerateImageParams {
  prompt: string;
  refs?: string[]; // file paths to reference images
  aspectRatio?: string; // "16:9", "9:16", "2:3", "1:1"
  imageSize?: string; // "0.5K", "1K", "2K", "4K"
  temperature?: number;
}

export interface GenerateImageResult {
  imagePath: string;
  sizeKb: number;
  mimeType: string;
}

/**
 * Generate a cinematic first frame using Nano Banana 2.
 *
 * The prompt should follow the 6-section structure:
 * 1. SUBJECT (frozen mid-motion)
 * 2. COMPOSITION (framing, angle, placement)
 * 3. CAMERA + LENS (ARRI Alexa, Cooke S4, aperture)
 * 4. LIGHTING (key direction, color temp, fill ratio)
 * 5. COLOR + GRADE (palette, Dehancer/Kodak reference)
 * 6. ATMOSPHERE (particles, volumetric light)
 * + STYLE ANCHORS + AVOID list
 */
export async function generateImage(
  config: NB2Config,
  params: GenerateImageParams,
  outputPath: string
): Promise<GenerateImageResult> {
  const model = config.model ?? "google/gemini-3.1-flash-image-preview";

  // Build content parts
  const contentParts: any[] = [];

  // Add reference images first (character/scene anchors)
  if (params.refs && params.refs.length > 0) {
    for (const refPath of params.refs) {
      if (!existsSync(refPath)) {
        console.error(`  Warning: ref not found: ${refPath}`);
        continue;
      }
      const data = readFileSync(refPath);
      const b64 = Buffer.from(data).toString("base64");
      const ext = extname(refPath).toLowerCase().replace(".", "");
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${b64}` },
      });
    }
    // Add consistency instruction with refs
    contentParts.push({
      type: "text",
      text: `Keep the character's facial features consistent with the reference images above. Generate the following scene:\n\n${params.prompt}`,
    });
  } else {
    contentParts.push({ type: "text", text: params.prompt });
  }

  const payload = {
    model,
    modalities: ["image", "text"],
    image_config: {
      aspect_ratio: params.aspectRatio ?? "16:9",
      image_size: params.imageSize ?? "2K",
    },
    messages: [{ role: "user", content: contentParts }],
    max_tokens: 4096,
    temperature: params.temperature ?? 1.0,
  };

  // Call API with retries
  let response: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://film-cli.local",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300_000),
      });
      response = await resp.json();
      break;
    } catch (err: any) {
      if (attempt < 2 && err.name === "TimeoutError") {
        console.error(`  Timeout, retrying (${attempt + 2}/3)...`);
        continue;
      }
      throw err;
    }
  }

  // Extract image from response
  const imageData = extractImageFromResponse(response);
  if (!imageData) {
    throw new Error(
      `Failed to extract image from NB2 response. Keys: ${JSON.stringify(Object.keys(response?.choices?.[0]?.message ?? {}))}`
    );
  }

  // Save to file
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, imageData.bytes);

  return {
    imagePath: outputPath,
    sizeKb: Math.round(imageData.bytes.length / 1024),
    mimeType: imageData.mimeType,
  };
}

interface ImageData {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Extract image bytes from OpenRouter/Gemini response.
 * Handles multiple response formats (images field, content array, inline base64).
 */
function extractImageFromResponse(response: any): ImageData | null {
  const choices = response?.choices ?? [];
  if (choices.length === 0) return null;

  const message = choices[0]?.message ?? {};

  // Format 1: images field
  const images = message.images ?? [];
  if (images.length > 0) {
    let imgUrl = images[0];
    if (typeof imgUrl === "object") {
      imgUrl = imgUrl.image_url?.url ?? imgUrl.url ?? "";
    }
    return parseDataUrl(imgUrl);
  }

  // Format 2: content is array with image parts
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "image_url") {
        const url = part.image_url?.url ?? "";
        const parsed = parseDataUrl(url);
        if (parsed) return parsed;
      }
      if (part?.type === "image") {
        const b64 = part.data ?? part.source?.data;
        const mime = part.media_type ?? part.source?.media_type ?? "image/png";
        if (b64) return { bytes: Buffer.from(b64, "base64"), mimeType: mime };
      }
    }
  }

  // Format 3: content is string with embedded base64
  if (typeof content === "string" && content.includes("base64")) {
    const match = content.match(/data:(image\/\w+);base64,([A-Za-z0-9+/=]+)/);
    if (match) {
      return { bytes: Buffer.from(match[2], "base64"), mimeType: match[1] };
    }
  }

  return null;
}

function parseDataUrl(url: string): ImageData | null {
  if (!url || !url.startsWith("data:")) return null;
  const [header, b64] = url.split(",", 2);
  if (!b64) return null;
  const mimeType = header.split(":")[1]?.split(";")[0] ?? "image/png";
  return { bytes: Buffer.from(b64, "base64"), mimeType };
}
