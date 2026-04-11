/**
 * Load API configs from film.toml for integration modules.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { findProjectRoot } from "../db";
import type { KlingConfig } from "./kling";
import type { NB2Config } from "./nb2";
import type { GeminiConfig } from "./gemini";

interface RawConfig {
  [key: string]: string | number | boolean;
}

function loadToml(path: string): RawConfig {
  const content = readFileSync(path, "utf-8");
  const result: RawConfig = {};
  let section = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = section ? `${section}.${kvMatch[1]}` : kvMatch[1];
      let value: any = kvMatch[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else if (value === "true") value = true;
      else if (value === "false") value = false;
      else if (!isNaN(Number(value))) value = Number(value);
      result[key] = value;
    }
  }
  return result;
}

function getProjectConfig(): RawConfig {
  const root = findProjectRoot();
  if (!root) throw new Error("No project found. Run 'film init' first.");
  const configPath = join(root, "film.toml");
  if (!existsSync(configPath)) throw new Error("No film.toml found.");
  return loadToml(configPath);
}

export function getKlingConfig(): KlingConfig {
  const cfg = getProjectConfig();
  const accessKey = String(cfg["api.kling.access_key"] ?? "");
  const secretKey = String(cfg["api.kling.secret_key"] ?? "");
  if (!accessKey || !secretKey) {
    throw new Error(
      "Kling API keys not configured. Run:\n" +
      '  film config set api.kling.access_key "YOUR_KEY"\n' +
      '  film config set api.kling.secret_key "YOUR_SECRET"'
    );
  }
  return {
    accessKey,
    secretKey,
    baseUrl: String(cfg["api.kling.base_url"] ?? "https://api-beijing.klingai.com"),
  };
}

export function getNB2Config(): NB2Config {
  const cfg = getProjectConfig();
  const apiKey = String(cfg["api.openrouter.api_key"] ?? "");
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not configured. Run:\n" +
      '  film config set api.openrouter.api_key "YOUR_KEY"'
    );
  }
  return {
    apiKey,
    model: String(cfg["api.image.model"] ?? "google/gemini-3.1-flash-image-preview"),
  };
}

export function getGeminiConfig(): GeminiConfig {
  const cfg = getProjectConfig();
  const apiKey = String(cfg["api.openrouter.api_key"] ?? "");
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not configured. Run:\n" +
      '  film config set api.openrouter.api_key "YOUR_KEY"'
    );
  }
  return {
    apiKey,
    model: String(cfg["api.review.model"] ?? "google/gemini-3.1-pro-preview"),
  };
}

export function getProjectDefaults(): {
  model: string;
  mode: string;
  duration: number;
  aspectRatio: string;
  autoAcceptThreshold: number;
} {
  const cfg = getProjectConfig();
  return {
    model: String(cfg["api.kling.default_model"] ?? "kling-v3-omni"),
    mode: String(cfg["api.kling.default_mode"] ?? "std"),
    duration: Number(cfg["api.kling.default_duration"] ?? 5),
    aspectRatio: String(cfg["project.aspect_ratio"] ?? "16:9"),
    autoAcceptThreshold: Number(cfg["api.review.auto_accept_threshold"] ?? 0),
  };
}
