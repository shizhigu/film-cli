/**
 * Gemini 3.1 Pro review integration for film-cli.
 *
 * Reviews frames and videos via OpenRouter API.
 * CRITICAL: Always use gemini-3.1-pro-preview, never Flash.
 * Flash misses narrative/composition issues — only checks technical attributes.
 *
 * Key production rules:
 * - Always include the PROMPT text alongside the video for review
 *   (enables prompt-engineering feedback, not just pass/fail)
 * - Ask narrative questions: "Can a first-time viewer understand this?"
 * - Parse structured score from response
 */

import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface GeminiConfig {
  apiKey: string;
  model?: string;
}

// --- Video compression ---

function compressVideo(inputPath: string, maxSizeMb: number = 5): string {
  const stat = Bun.file(inputPath);
  const sizeMb = stat.size / (1024 * 1024);
  if (sizeMb <= maxSizeMb) return inputPath;

  const outputPath = "/tmp/film_review_compressed.mp4";
  console.error(`  Compressing video: ${sizeMb.toFixed(1)}MB → <${maxSizeMb}MB...`);
  execSync(
    `ffmpeg -y -i "${inputPath}" -vf "scale=360:-2" -c:v libx264 -crf 30 -preset fast -c:a aac -b:a 64k "${outputPath}"`,
    { timeout: 120_000, stdio: "pipe" }
  );
  return outputPath;
}

// --- Review prompt templates ---

const FRAME_REVIEW_PROMPT = `You are a veteran cinematographer and film director with 20 years of experience.

Review this first frame image for a narrative AI micro-film shot.

## Context
{context}

## The image prompt used to generate this frame
{frame_prompt}

## Review criteria
1. Does the frame communicate the stated intent to a first-time viewer?
2. Character consistency: does the character match reference images?
3. Composition: is the framing, angle, and subject placement effective?
4. Lighting: does it match the project's visual DNA?
5. Frozen mid-motion: does the character look mid-action (good) or static (bad)?
6. Any AI artifacts (morphing, extra fingers, unnatural skin)?
7. Would this frame produce smooth Kling animation, or is it too static?

## Output format (MUST follow exactly)
SCORE: X/10
ONE_FIX: [the single most important thing to fix]
RECOMMENDATION: [accept_frame|reroll_frame]
DETAIL: [your full analysis]
PROMPT_FIX: [specific prompt change to improve the result]`;

const VIDEO_REVIEW_PROMPT = `You are a veteran film director and editor with 20 years of experience reviewing AI-generated video content. Your standards are extremely high.

Review this video clip from a narrative AI micro-film.

## Context
{context}

## Image prompt used for the first frame
{frame_prompt}

## Kling omni prompt used for video generation
{kling_prompt}

## Review criteria
1. NARRATIVE: Can a first-time viewer understand what's happening? Does the visual support the story intent?
2. PERFORMANCE: Are lips moving in sync with audio? Is the acting alive (body language, micro-expressions) or stiff (interview-style)?
3. CAMERA: Is the camera movement smooth and motivated? Any AI-typical "startup stutter" or "end drift"?
4. PHYSICS: Hands normal? Fingers correct count? Objects stable? No morphing/warping?
5. AUDIO: Correct voice? Correct words? No unwanted background music? Natural room tone?
6. CONSISTENCY: Does the character match their established look? Wardrobe correct?
7. MOTION: Are all 3 layers present — camera movement + subject action + atmospheric motion?

## Output format (MUST follow exactly)
SCORE: X/10
ONE_FIX: [the single most important thing to fix]
RECOMMENDATION: [accept|reroll|restructure]
DETAIL: [your full analysis with timestamps]
PROMPT_FIX: [specific prompt changes to improve — rewrite the problematic section]`;

// --- Public API ---

export interface ReviewResult {
  score: number;
  oneFix: string;
  recommendation: string;
  detail: string;
  promptFix: string;
  rawResponse: string;
}

/**
 * Review a first frame image with Gemini Pro.
 * Includes the frame prompt for actionable prompt-engineering feedback.
 */
export async function reviewFrame(
  config: GeminiConfig,
  imagePath: string,
  framePrompt: string,
  intent: string
): Promise<ReviewResult> {
  const model = config.model ?? "google/gemini-3.1-pro-preview";

  // Encode image
  const imageData = readFileSync(imagePath);
  const b64 = Buffer.from(imageData).toString("base64");
  const mime = imagePath.endsWith(".jpg") || imagePath.endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";

  // Build review prompt
  const prompt = FRAME_REVIEW_PROMPT
    .replace("{context}", `Intent: ${intent}`)
    .replace("{frame_prompt}", framePrompt);

  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 4000,
  };

  return await callAndParse(config.apiKey, payload);
}

/**
 * Review a video with Gemini Pro.
 * Includes BOTH the frame prompt AND the Kling prompt for maximum actionable feedback.
 * This is the key differentiator — review with full upstream context.
 */
export async function reviewVideo(
  config: GeminiConfig,
  videoPath: string,
  framePrompt: string,
  klingPrompt: string,
  intent: string
): Promise<ReviewResult> {
  const model = config.model ?? "google/gemini-3.1-pro-preview";

  // Compress if needed
  const compressed = compressVideo(videoPath);
  const videoData = readFileSync(compressed);
  const b64 = Buffer.from(videoData).toString("base64");

  // Build review prompt with BOTH upstream prompts
  const prompt = VIDEO_REVIEW_PROMPT
    .replace("{context}", `Intent: ${intent}`)
    .replace("{frame_prompt}", framePrompt)
    .replace("{kling_prompt}", klingPrompt);

  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 8000,
  };

  return await callAndParse(config.apiKey, payload);
}

/**
 * Review a full assembly (rough cut or final cut) with Gemini Pro.
 */
export async function reviewAssembly(
  config: GeminiConfig,
  videoPath: string,
  shotList: { number: number; dialogue?: string }[]
): Promise<ReviewResult> {
  const model = config.model ?? "google/gemini-3.1-pro-preview";

  const compressed = compressVideo(videoPath, 10); // larger limit for full film
  const videoData = readFileSync(compressed);
  const b64 = Buffer.from(videoData).toString("base64");

  const shotDesc = shotList
    .map((s) => `Shot ${s.number}${s.dialogue ? `: "${s.dialogue}"` : ""}`)
    .join("\n");

  const prompt = `You are a veteran film director reviewing a complete AI-generated narrative micro-film.

## Shot list
${shotDesc}

## Review criteria
1. STORY: Does the narrative make sense from start to finish? Any logic gaps?
2. PACING: Is the rhythm right? Any shots too long or too short?
3. TRANSITIONS: Are cuts between shots jarring or smooth?
4. AUDIO CONTINUITY: Does audio flow naturally between shots?
5. CHARACTER CONSISTENCY: Does each character look the same across all shots?
6. EMOTIONAL ARC: Does the emotional journey land?
7. THE ENDING: Is the resolution earned?

## Output format (MUST follow exactly)
SCORE: X/10
ONE_FIX: [the single most important thing to fix]
RECOMMENDATION: [accept|needs_work]
DETAIL: [your full analysis with timestamps]
PROMPT_FIX: [what to change in production]`;

  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } },
          { type: "text", text: prompt },
        ],
      },
    ],
    max_tokens: 8000,
  };

  return await callAndParse(config.apiKey, payload);
}

// --- Internal helpers ---

async function callAndParse(
  apiKey: string,
  payload: any
): Promise<ReviewResult> {
  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://film-cli.local",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });

  const data = await resp.json() as any;

  if (!data.choices || data.choices.length === 0) {
    throw new Error(`Gemini API error: ${JSON.stringify(data.error ?? data)}`);
  }

  const raw = data.choices[0].message.content ?? "";
  return parseReviewResponse(raw);
}

/**
 * Parse structured review response.
 * Extracts SCORE, ONE_FIX, RECOMMENDATION, DETAIL, PROMPT_FIX from the response text.
 */
function parseReviewResponse(raw: string): ReviewResult {
  const getField = (name: string): string => {
    const regex = new RegExp(`${name}:\\s*(.+?)(?=\\n[A-Z_]+:|$)`, "s");
    const match = raw.match(regex);
    return match ? match[1].trim() : "";
  };

  const scoreStr = getField("SCORE");
  const scoreMatch = scoreStr.match(/(\d+(?:\.\d+)?)/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;

  return {
    score,
    oneFix: getField("ONE_FIX"),
    recommendation: getField("RECOMMENDATION").toLowerCase().replace(/\s/g, "_"),
    detail: getField("DETAIL"),
    promptFix: getField("PROMPT_FIX"),
    rawResponse: raw,
  };
}
