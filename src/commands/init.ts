/**
 * film init — initialize a new project.
 */

import { mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { initDb } from "../db";
import { success, error } from "../output";

export function initCmd(args: string[]) {
  const name = args[0];
  if (!name) {
    error("Usage: film init <project-name> [--path <dir>]");
    process.exit(1);
  }

  // Parse --path option
  let dir = process.cwd();
  const pathIdx = args.indexOf("--path");
  if (pathIdx !== -1 && args[pathIdx + 1]) {
    dir = resolve(args[pathIdx + 1]);
  }

  const dbPath = join(dir, "film.db");
  if (existsSync(dbPath)) {
    error(`Project already exists at ${dir} (film.db found)`);
    process.exit(1);
  }

  // Create directory structure
  const dirs = [
    "assets/characters",
    "assets/scenes",
    "assets/objects",
    "assets/voices",
    "episodes",
    "knowledge",
  ];
  for (const d of dirs) {
    mkdirSync(join(dir, d), { recursive: true });
  }

  // Initialize database
  const db = initDb(dbPath);
  db.run("INSERT INTO projects (name) VALUES (?)", [name]);

  // Create default config
  const configContent = `[project]
name = "${name}"
aspect_ratio = "16:9"
fps = 24

[api.kling]
access_key = ""
secret_key = ""
base_url = "https://api-beijing.klingai.com"
default_model = "kling-v3-omni"
default_mode = "std"
default_duration = 5

[api.openrouter]
api_key = ""

[api.review]
model = "google/gemini-3.1-pro-preview"
auto_accept_threshold = 0

[api.image]
model = "google/gemini-3.1-flash-image-preview"

[assembly]
engine = "remotion"
loudnorm = "I=-12:LRA=7:TP=-1"
pre_boost_db = 4

[rules]
strict = true
`;
  Bun.write(join(dir, "film.toml"), configContent);

  db.close();

  success(`Project '${name}' initialized at ${dir}`, {
    project: name,
    path: dir,
    db: dbPath,
  });
}
