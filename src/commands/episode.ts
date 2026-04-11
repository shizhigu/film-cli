/**
 * film episode — manage episodes.
 */

import { openDb, getProject, countShotsByStatus } from "../db";
import { emit, success, error, table } from "../output";

const HELP = `
film episode — Manage episodes in the current project.

Subcommands:
  create <number> --title <title>    Create a new episode
  list                               List all episodes with shot progress
  script <number> --file <path>      Import/update episode script

Workflow:
  1. Create episode:  film episode create 1 --title "The Photograph"
  2. Import script:   film episode script 1 --file script.md
  3. Create shots:    film shot create 1 1 --framing MCU ...
  4. Produce shots:   (greedy shot-by-shot loop)
  5. Assemble:        film assemble 1

Tips:
  - Script is a compass, not a map. Each shot may deviate based on
    what previous shots actually look like (greedy adaptation).
  - Episode status progresses: development → pre_production → production →
    post_production → released
`;

export function episodeCmd(args: string[]) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "create":
      createEpisode(rest);
      break;
    case "list":
      listEpisodes();
      break;
    case "script":
      importScript(rest);
      break;
    default:
      error(`Unknown subcommand: ${sub}`);
      console.log(HELP);
      process.exit(1);
  }
}

function createEpisode(args: string[]) {
  const number = parseInt(args[0]);
  if (isNaN(number)) {
    error("Usage: film episode create <number> --title <title>");
    process.exit(1);
  }

  let title = "";
  const titleIdx = args.indexOf("--title");
  if (titleIdx !== -1 && args[titleIdx + 1]) {
    title = args[titleIdx + 1];
  }

  const db = openDb();
  const project = getProject(db);
  if (!project) { error("No project found."); process.exit(1); }

  db.run(
    "INSERT INTO episodes (project_id, number, title, status) VALUES (?, ?, ?, 'development')",
    [project.id, number, title]
  );

  db.close();
  success(`Episode ${number} created: "${title}"`, { episode: number, title });
}

function listEpisodes() {
  const db = openDb();
  const project = getProject(db);
  if (!project) { error("No project found."); process.exit(1); }

  const episodes = db
    .query("SELECT * FROM episodes WHERE project_id = ? ORDER BY number")
    .all(project.id) as Record<string, any>[];

  const rows = episodes.map((ep) => {
    const counts = countShotsByStatus(db, ep.id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const accepted = counts["accepted"] ?? 0;
    return [ep.number, ep.title ?? "", ep.status, `${accepted}/${total}`];
  });

  table(["#", "Title", "Status", "Shots"], rows);
  db.close();
}

function importScript(args: string[]) {
  const number = parseInt(args[0]);
  if (isNaN(number)) {
    error("Usage: film episode script <number> --file <path>");
    process.exit(1);
  }

  let filePath = "";
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    filePath = args[fileIdx + 1];
  }
  if (!filePath) {
    error("--file required");
    process.exit(1);
  }

  const content = Bun.file(filePath).text();
  const db = openDb();
  const project = getProject(db);
  if (!project) { error("No project found."); process.exit(1); }

  db.run(
    "UPDATE episodes SET script_md = ? WHERE project_id = ? AND number = ?",
    [content, project.id, number]
  );

  db.close();
  success(`Script imported for episode ${number}`);
}
