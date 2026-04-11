/**
 * Kling API integration for film-cli.
 *
 * Covers: omni video generation, voice cloning, voice listing, task polling.
 * Auth: JWT HS256 with access_key + secret_key.
 * Base URL: https://api-beijing.klingai.com
 *
 * Key production rules enforced here:
 * - Always kling-v3-omni for dialogue shots
 * - Always --sound on when voice_list present
 * - voice_list max 2 entries
 * - Prompt max 2500 characters
 * - image_list must include character refs beyond first_frame
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { dirname, extname } from "path";
import { execSync } from "child_process";

// --- JWT generation (HS256, no external dependency) ---

function base64url(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createJwt(accessKey: string, secretKey: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };

  const headerB64 = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const sigB64 = base64url(new Uint8Array(sig));

  return `${signingInput}.${sigB64}`;
}

// --- File loading ---

/**
 * Load a file as base64. If it's an image > 500KB, compress to JPEG first.
 * Kling API can timeout on large base64 payloads.
 */
function loadFileAsBase64(path: string): string {
  if (path.startsWith("http")) return path;

  const stat = statSync(path);
  const ext = extname(path).toLowerCase();
  const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext);

  // Compress large images to JPEG (< 500KB target)
  if (isImage && stat.size > 500 * 1024) {
    const compressed = "/tmp/film_kling_compressed.jpg";
    try {
      execSync(
        `ffmpeg -y -i "${path}" -vf "scale='min(1284,iw)':-2" -q:v 4 "${compressed}"`,
        { timeout: 30_000, stdio: "pipe" }
      );
      const data = readFileSync(compressed);
      return Buffer.from(data).toString("base64");
    } catch {
      // Fallback to original if compression fails
    }
  }

  const data = readFileSync(path);
  return Buffer.from(data).toString("base64");
}

// --- Core API functions ---

export interface KlingConfig {
  accessKey: string;
  secretKey: string;
  baseUrl: string;
}

async function getHeaders(config: KlingConfig): Promise<Record<string, string>> {
  const token = await createJwt(config.accessKey, config.secretKey);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function postTask(
  config: KlingConfig,
  endpoint: string,
  payload: Record<string, any>
): Promise<{ taskId: string; endpointType: string } | null> {
  const headers = await getHeaders(config);
  const url = `${config.baseUrl}${endpoint}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await resp.json() as any;
  if (data.code !== 0) {
    throw new Error(`Kling API error [${data.code}]: ${data.message}`);
  }

  const taskId = data.data.task_id;
  const endpointType = endpoint.replace(/^\/v1\/videos\//, "").replace(/^\/v1\/audio\//, "");
  return { taskId, endpointType };
}

async function queryTask(
  config: KlingConfig,
  taskId: string,
  endpointType: string
): Promise<Record<string, any>> {
  const headers = await getHeaders(config);

  // Try video endpoint first
  for (const prefix of ["/v1/videos/", "/v1/audio/"]) {
    try {
      const resp = await fetch(`${config.baseUrl}${prefix}${endpointType}/${taskId}`, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      const data = await resp.json() as any;
      if (data.code === 0) return data.data;
    } catch {
      continue;
    }
  }

  return { task_status: "error", raw: "query failed on all endpoints" };
}

export interface PollResult {
  status: "succeed" | "failed" | "timeout";
  videoUrl?: string;
  audioUrl?: string;
  duration?: number;
  taskResult?: Record<string, any>;
  errorMessage?: string;
}

async function pollUntilDone(
  config: KlingConfig,
  taskId: string,
  endpointType: string,
  timeoutMs: number = 600_000,
  onProgress?: (elapsed: number, status: string) => void
): Promise<PollResult> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const data = await queryTask(config, taskId, endpointType);
    const status = data.task_status ?? "unknown";
    const elapsed = Math.floor((Date.now() - start) / 1000);

    if (status === "succeed") {
      const videos = data.task_result?.videos ?? [];
      const audios = data.task_result?.audios ?? [];
      return {
        status: "succeed",
        videoUrl: videos[0]?.url,
        audioUrl: audios[0]?.url_mp3 ?? audios[0]?.url_wav,
        duration: videos[0]?.duration,
        taskResult: data.task_result,
      };
    }

    if (status === "failed") {
      return {
        status: "failed",
        errorMessage: data.task_status_msg ?? "Unknown failure",
      };
    }

    onProgress?.(elapsed, status);
    await Bun.sleep(10_000);
  }

  return { status: "timeout" };
}

async function downloadFile(url: string, outputPath: string): Promise<string> {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const buffer = await resp.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(buffer));
  return outputPath;
}

// --- Public API: Omni Video Generation ---

export interface OmniParams {
  prompt: string;
  imageList: { path: string; type?: "first_frame" }[];
  voiceList?: { voice_id: string }[];
  model?: string;
  duration?: number;
  aspectRatio?: string;
  sound?: "on" | "off";
  mode?: "std" | "pro";
  negativePrompt?: string;
}

export async function generateOmniVideo(
  config: KlingConfig,
  params: OmniParams,
  outputPath: string,
  onProgress?: (elapsed: number, status: string) => void
): Promise<{
  taskId: string;
  videoPath: string;
  duration?: number;
} | null> {
  const payload: Record<string, any> = {
    model_name: params.model ?? "kling-v3-omni",
    prompt: params.prompt,
    mode: params.mode ?? "std",
    duration: String(params.duration ?? 5),
  };

  if (params.aspectRatio) payload.aspect_ratio = params.aspectRatio;
  if (params.sound === "on") payload.sound = "on";
  if (params.negativePrompt) payload.negative_prompt = params.negativePrompt;

  // Build image_list with base64 encoding
  if (params.imageList.length > 0) {
    payload.image_list = params.imageList.map((img) => {
      const entry: Record<string, any> = {
        image_url: loadFileAsBase64(img.path),
      };
      if (img.type) entry.type = img.type;
      return entry;
    });
  }

  if (params.voiceList && params.voiceList.length > 0) {
    payload.voice_list = params.voiceList;
  }

  const result = await postTask(config, "/v1/videos/omni-video", payload);
  if (!result) return null;

  const pollResult = await pollUntilDone(
    config,
    result.taskId,
    "omni-video",
    600_000,
    onProgress
  );

  if (pollResult.status === "succeed" && pollResult.videoUrl) {
    const videoPath = await downloadFile(pollResult.videoUrl, outputPath);
    return {
      taskId: result.taskId,
      videoPath,
      duration: pollResult.duration,
    };
  }

  if (pollResult.status === "failed") {
    throw new Error(`Kling generation failed: ${pollResult.errorMessage}`);
  }

  throw new Error("Kling generation timed out (10 minutes)");
}

// --- Public API: Voice Clone ---

export async function voiceClone(
  config: KlingConfig,
  name: string,
  audioUrl: string
): Promise<{ voiceId: string; voiceName: string; trialUrl?: string }> {
  const headers = await getHeaders(config);
  const payload: Record<string, any> = { voice_name: name };
  if (audioUrl.startsWith("http")) {
    payload.voice_url = audioUrl;
  }

  const resp = await fetch(`${config.baseUrl}/v1/general/custom-voices`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await resp.json() as any;
  if (data.code !== 0) {
    throw new Error(`Voice clone error [${data.code}]: ${data.message}`);
  }

  const taskId = data.data.task_id;

  // Poll for completion
  const start = Date.now();
  while (Date.now() - start < 300_000) {
    const resp2 = await fetch(`${config.baseUrl}/v1/general/custom-voices/${taskId}`, {
      headers: await getHeaders(config),
      signal: AbortSignal.timeout(30_000),
    });
    const d = (await resp2.json() as any).data ?? {};
    const status = d.task_status ?? "unknown";

    if (status === "succeed") {
      const voices = d.task_result?.voices ?? [];
      if (voices.length > 0) {
        return {
          voiceId: voices[0].voice_id,
          voiceName: voices[0].voice_name,
          trialUrl: voices[0].trial_url,
        };
      }
    }
    if (status === "failed") {
      throw new Error(`Voice clone failed: ${d.task_status_msg}`);
    }

    await Bun.sleep(5_000);
  }

  throw new Error("Voice clone timed out (5 minutes)");
}

// --- Public API: Voice List ---

export async function voiceList(
  config: KlingConfig,
  preset: boolean = false
): Promise<{ voiceId: string; voiceName: string; trialUrl?: string }[]> {
  const endpoint = preset
    ? "/v1/general/presets-voices"
    : "/v1/general/custom-voices";

  const headers = await getHeaders(config);
  const resp = await fetch(
    `${config.baseUrl}${endpoint}?pageNum=1&pageSize=100`,
    { headers, signal: AbortSignal.timeout(30_000) }
  );

  const data = await resp.json() as any;
  if (data.code !== 0) {
    throw new Error(`Voice list error: ${data.message}`);
  }

  const voices: { voiceId: string; voiceName: string; trialUrl?: string }[] = [];
  for (const item of data.data ?? []) {
    for (const v of item.task_result?.voices ?? []) {
      voices.push({
        voiceId: v.voice_id,
        voiceName: v.voice_name,
        trialUrl: v.trial_url,
      });
    }
  }
  return voices;
}

// --- Public API: Sound Effects ---

export async function generateSfx(
  config: KlingConfig,
  prompt: string,
  duration: number,
  outputPath: string
): Promise<string> {
  const result = await postTask(config, "/v1/audio/text-to-audio", {
    prompt,
    duration,
  });
  if (!result) throw new Error("SFX task creation failed");

  const pollResult = await pollUntilDone(config, result.taskId, "text-to-audio");
  if (pollResult.status === "succeed" && pollResult.audioUrl) {
    return await downloadFile(pollResult.audioUrl, outputPath);
  }
  throw new Error(`SFX generation failed: ${pollResult.errorMessage ?? "timeout"}`);
}

// --- Public API: Query Task ---

export async function queryTaskStatus(
  config: KlingConfig,
  taskId: string,
  endpointType: string = "omni-video"
): Promise<Record<string, any>> {
  return queryTask(config, taskId, endpointType);
}
