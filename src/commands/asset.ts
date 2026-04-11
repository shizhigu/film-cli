/**
 * film asset — manage production assets.
 */

import { openDb, getProject, getAssets } from "../db";
import { emit, success, error, table } from "../output";

const HELP = `
film asset — Manage production assets (character refs, scene refs, voices).

Subcommands:
  register <file> [options]    Register an existing asset file
  list [--type <type>]         List all assets
  lock <id>                    Lock an asset (mark as canonical, immutable)

Options for register:
  --type <portrait|turnaround|expression|scene|object|voice_clone>
  --character <name>           Character this asset belongs to
  --name <name>                Asset display name
  --purpose <text>             What this asset is for

Asset Types:
  portrait     — Main character reference (front-facing)
  turnaround   — 4-angle character sheet (3/4, front, side, back)
  expression   — 4-6 emotion expression sheet
  scene        — Establishing shot for a location (becomes SPATIAL BIBLE)
  object       — Key prop reference (polaroid, motorcycle, letter)
  voice_clone  — Kling voice clone (stores voice_id)

CRITICAL — Do this BEFORE generating any shots:
  1. Generate/register a portrait for every character
  2. Generate/register an establishing shot for every location
  3. Lock canonical refs with 'film asset lock'
  4. Bind refs to shots with --character-refs and --scene-ref

Without character refs, every shot generates a different-looking person.
This is the #1 quality issue in AI filmmaking — proven across 35+ shots.

Rules:
  - Scene refs are STRICT SPATIAL AUTHORITY — never add elements not in ref
  - Character portraits MUST be passed in every Kling omni image_list
  - Generate turnaround (4 angles) + expression sheet (4-6 emotions)
    for every speaking character
  - Lock assets once approved — locked = canonical, immutable
`;

export function assetCmd(args: string[]) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "register":
      registerAsset(rest);
      break;
    case "list":
      listAssets(rest);
      break;
    case "lock":
      lockAsset(rest);
      break;
    default:
      error(`Unknown subcommand: ${sub}`);
      console.log(HELP);
      process.exit(1);
  }
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

function registerAsset(args: string[]) {
  const filePath = args[0];
  if (!filePath) {
    error("Usage: film asset register <file> --type <type> --name <name> [--character <name>]");
    process.exit(1);
  }

  const type = parseFlag(args, "--type");
  const name = parseFlag(args, "--name") ?? filePath.split("/").pop() ?? "";
  const character = parseFlag(args, "--character");
  const purpose = parseFlag(args, "--purpose") ?? "";

  if (!type) {
    error("--type is required (portrait|turnaround|expression|scene|object|voice_clone)");
    process.exit(1);
  }

  const db = openDb();
  const project = getProject(db);
  if (!project) { error("No project found."); process.exit(1); }

  // Find or create character
  let characterId: number | null = null;
  if (character) {
    const existing = db
      .query("SELECT id FROM characters WHERE project_id = ? AND name = ?")
      .get(project.id, character) as { id: number } | null;

    if (existing) {
      characterId = existing.id;
    } else {
      db.run("INSERT INTO characters (project_id, name) VALUES (?, ?)", [project.id, character]);
      characterId = (db.query("SELECT last_insert_rowid() as id").get() as any).id;
    }
  }

  db.run(
    `INSERT INTO assets (project_id, character_id, type, name, file_path, purpose, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [project.id, characterId, type, name, filePath, purpose]
  );

  const assetId = (db.query("SELECT last_insert_rowid() as id").get() as any).id;
  db.close();

  success(`Asset registered: ${name} (${type})`, {
    id: assetId,
    name,
    type,
    character: character ?? null,
    file_path: filePath,
    status: "pending",
  });
}

function listAssets(args: string[]) {
  const typeFilter = parseFlag(args, "--type");

  const db = openDb();
  const project = getProject(db);
  if (!project) { error("No project found."); process.exit(1); }

  const assets = getAssets(db, project.id, typeFilter);

  const rows = assets.map((a) => {
    // Get character name if linked
    let charName = "-";
    if (a.character_id) {
      const char = db.query("SELECT name FROM characters WHERE id = ?").get(a.character_id) as any;
      if (char) charName = char.name;
    }
    return [
      a.id,
      a.type,
      a.name,
      charName,
      a.status,
      a.gemini_score ?? "-",
    ];
  });

  table(["ID", "Type", "Name", "Character", "Status", "Score"], rows);
  db.close();
}

function lockAsset(args: string[]) {
  const id = parseInt(args[0]);
  if (isNaN(id)) { error("Usage: film asset lock <id>"); process.exit(1); }

  const db = openDb();
  db.run("UPDATE assets SET status = 'locked' WHERE id = ?", [id]);
  db.close();
  success(`Asset ${id} locked (canonical, immutable).`);
}
