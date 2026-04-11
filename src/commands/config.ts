/**
 * film config — manage configuration.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { findProjectRoot } from "../db";
import { emit, success, error } from "../output";

function loadToml(path: string): Record<string, any> {
  // Simple TOML parser for our flat config structure
  const content = readFileSync(path, "utf-8");
  const result: Record<string, any> = {};
  let currentSection = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = currentSection ? `${currentSection}.${kvMatch[1]}` : kvMatch[1];
      let value: any = kvMatch[2].trim();
      // Strip quotes
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

export function configCmd(args: string[]) {
  const subcommand = args[0];
  const root = findProjectRoot();
  if (!root) {
    error("No project found. Run 'film init' first.");
    process.exit(1);
  }

  const configPath = join(root, "film.toml");
  if (!existsSync(configPath)) {
    error("No film.toml found.");
    process.exit(1);
  }

  switch (subcommand) {
    case "list": {
      const config = loadToml(configPath);
      emit(config);
      break;
    }
    case "get": {
      const key = args[1];
      if (!key) { error("Usage: film config get <key>"); process.exit(1); }
      const config = loadToml(configPath);
      const value = config[key];
      if (value === undefined) { error(`Key not found: ${key}`); process.exit(1); }
      emit({ key, value }, `${key} = ${value}`);
      break;
    }
    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) { error("Usage: film config set <key> <value>"); process.exit(1); }

      // Read, modify, write
      let content = readFileSync(configPath, "utf-8");
      const parts = key.split(".");
      const fieldName = parts[parts.length - 1];

      // Try to find and replace the line
      const lines = content.split("\n");
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(`${fieldName} =`)) {
          const needsQuotes = isNaN(Number(value)) && value !== "true" && value !== "false";
          lines[i] = `${fieldName} = ${needsQuotes ? `"${value}"` : value}`;
          found = true;
          break;
        }
      }
      if (found) {
        Bun.write(configPath, lines.join("\n"));
        success(`Set ${key} = ${value}`, { key, value });
      } else {
        error(`Key not found in config: ${key}`);
        process.exit(1);
      }
      break;
    }
    default:
      error("Usage: film config <get|set|list>");
      process.exit(1);
  }
}
