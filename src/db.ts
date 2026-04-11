/**
 * SQLite database layer for film-cli.
 * Uses Bun's native bun:sqlite for zero-dependency embedded database.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join, resolve } from "path";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    config_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    name TEXT NOT NULL,
    description TEXT,
    voice_clone_id TEXT,
    metadata_json TEXT DEFAULT '{}',
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    character_id INTEGER REFERENCES characters(id),
    type TEXT NOT NULL CHECK(type IN ('portrait','turnaround','expression','scene','object','voice_clone')),
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    purpose TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','generated','reviewed','locked')),
    gemini_score REAL,
    review_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    number INTEGER NOT NULL,
    title TEXT,
    script_md TEXT,
    status TEXT DEFAULT 'development' CHECK(status IN ('development','pre_production','production','post_production','released')),
    UNIQUE(project_id, number)
);

CREATE TABLE IF NOT EXISTS shots (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    number INTEGER NOT NULL,
    scene_name TEXT,
    framing TEXT,
    angle TEXT,
    camera_move TEXT,
    duration_target REAL DEFAULT 5.0,
    dialogue_text TEXT,
    voice_ids_json TEXT DEFAULT '[]',
    character_ref_ids_json TEXT DEFAULT '[]',
    scene_ref_id INTEGER REFERENCES assets(id),
    object_ref_ids_json TEXT DEFAULT '[]',
    spec_json TEXT,
    status TEXT DEFAULT 'planned',
    accepted_version INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(episode_id, number)
);

CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY,
    shot_id INTEGER REFERENCES shots(id),
    version_number INTEGER NOT NULL,
    frame_prompt TEXT,
    kling_prompt TEXT,
    kling_params_json TEXT,
    image_list_json TEXT,
    frame_path TEXT,
    video_path TEXT,
    kling_task_id TEXT,
    frame_generated_at TEXT,
    video_generated_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(shot_id, version_number)
);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    version_id INTEGER REFERENCES versions(id),
    review_type TEXT NOT NULL CHECK(review_type IN ('frame','video','assembly')),
    reviewer TEXT DEFAULT 'gemini_pro',
    model_used TEXT,
    score REAL,
    review_text TEXT,
    one_fix TEXT,
    prompt_suggestions TEXT,
    zero_tolerance_failures_json TEXT DEFAULT '[]',
    decision_recommendation TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY,
    version_id INTEGER REFERENCES versions(id),
    action TEXT NOT NULL CHECK(action IN ('accept','reroll','restructure','discard')),
    reason TEXT,
    decided_by TEXT DEFAULT 'agent',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assemblies (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    type TEXT NOT NULL CHECK(type IN ('animatic','rough_cut','fine_cut','final')),
    shot_order_json TEXT NOT NULL,
    transitions_json TEXT DEFAULT '[]',
    subtitles_json TEXT DEFAULT '[]',
    output_path TEXT,
    review_text TEXT,
    review_score REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shots_episode ON shots(episode_id);
CREATE INDEX IF NOT EXISTS idx_shots_status ON shots(status);
CREATE INDEX IF NOT EXISTS idx_versions_shot ON versions(shot_id);
CREATE INDEX IF NOT EXISTS idx_reviews_version ON reviews(version_id);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
`;

/** Walk up from cwd to find film.db */
export function findDbPath(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  while (true) {
    const dbPath = join(dir, "film.db");
    if (existsSync(dbPath)) return dbPath;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Get project root (directory containing film.db) */
export function findProjectRoot(from: string = process.cwd()): string | null {
  const dbPath = findDbPath(from);
  return dbPath ? resolve(dbPath, "..") : null;
}

/** Open database connection */
export function openDb(dbPath?: string): Database {
  const path = dbPath ?? findDbPath();
  if (!path) throw new Error("No film.db found. Run 'film init' first.");
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

/** Initialize database with schema */
export function initDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA_SQL);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
    "schema_version",
    String(SCHEMA_VERSION),
  ]);
  return db;
}

// --- Query helpers ---

export function getProject(db: Database) {
  return db.query("SELECT * FROM projects LIMIT 1").get() as Record<string, any> | null;
}

export function getEpisode(db: Database, epNum: number) {
  const proj = getProject(db);
  if (!proj) return null;
  return db
    .query("SELECT * FROM episodes WHERE project_id = ? AND number = ?")
    .get(proj.id, epNum) as Record<string, any> | null;
}

export function getShot(db: Database, epNum: number, shotNum: number) {
  const ep = getEpisode(db, epNum);
  if (!ep) return null;
  return db
    .query("SELECT * FROM shots WHERE episode_id = ? AND number = ?")
    .get(ep.id, shotNum) as Record<string, any> | null;
}

export function getShots(db: Database, episodeId: number, status?: string) {
  if (status) {
    return db
      .query("SELECT * FROM shots WHERE episode_id = ? AND status = ? ORDER BY number")
      .all(episodeId, status) as Record<string, any>[];
  }
  return db
    .query("SELECT * FROM shots WHERE episode_id = ? ORDER BY number")
    .all(episodeId) as Record<string, any>[];
}

export function getVersions(db: Database, shotId: number) {
  return db
    .query("SELECT * FROM versions WHERE shot_id = ? ORDER BY version_number")
    .all(shotId) as Record<string, any>[];
}

export function getLatestVersion(db: Database, shotId: number) {
  return db
    .query("SELECT * FROM versions WHERE shot_id = ? ORDER BY version_number DESC LIMIT 1")
    .get(shotId) as Record<string, any> | null;
}

export function getLatestReview(db: Database, versionId: number, reviewType: string) {
  return db
    .query("SELECT * FROM reviews WHERE version_id = ? AND review_type = ? ORDER BY id DESC LIMIT 1")
    .get(versionId, reviewType) as Record<string, any> | null;
}

export function countShotsByStatus(db: Database, episodeId: number): Record<string, number> {
  const rows = db
    .query("SELECT status, COUNT(*) as cnt FROM shots WHERE episode_id = ? GROUP BY status")
    .all(episodeId) as { status: string; cnt: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.cnt]));
}

export function getAssets(db: Database, projectId: number, type?: string) {
  if (type) {
    return db
      .query("SELECT * FROM assets WHERE project_id = ? AND type = ? ORDER BY name")
      .all(projectId, type) as Record<string, any>[];
  }
  return db
    .query("SELECT * FROM assets WHERE project_id = ? ORDER BY type, name")
    .all(projectId) as Record<string, any>[];
}
