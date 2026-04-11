/**
 * film brief — Manage the creative brief (concept, characters, visual DNA).
 *
 * The creative brief is the project's compass. It stores:
 * - Concept: one-paragraph story summary
 * - Characters: name, description, voice_id
 * - Visual DNA: camera, lens, lighting, color grade, atmosphere
 * - Emotional arc: start → turning point → end
 *
 * This data is used by the agent to generate consistent prompts across all shots.
 * The brief is stored in film.db and can be queried with --json for agent consumption.
 */

import { openDb, getProject, findProjectRoot } from "../db";
import { emit, success, error } from "../output";
import { readFileSync, existsSync } from "fs";

const HELP = `
film brief — Manage the creative brief.

Subcommands:
  set --file <brief.md>       Import creative brief from markdown file
  show                        Display the current brief
  set-dna --file <dna.md>     Import visual DNA from markdown file
  show-dna                    Display visual DNA

The creative brief is your project's compass:
  - What is the story? (one paragraph)
  - Who are the characters? (name, role, appearance, voice)
  - What is the emotional arc? (start → turn → end)
  - What are the format rules? (aspect ratio, duration, platform)

Visual DNA is your project's visual language:
  - Camera body + lens choices by framing
  - Lighting recipe (key, fill, rim, practicals)
  - Color grade reference (LUT, film stock)
  - Atmosphere (particles, haze, volumetric)
  - Style anchors (specific DP/director film references)

Both are stored in film.db and embedded in --json output for agent use.
`;

export function briefCmd(args: string[]) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const sub = args[0];
  const db = openDb();
  const project = getProject(db);
  if (!project) { error("No project found."); process.exit(1); }

  switch (sub) {
    case "set": {
      const fileIdx = args.indexOf("--file");
      const file = fileIdx !== -1 ? args[fileIdx + 1] : null;
      if (!file || !existsSync(file)) { error("Usage: film brief set --file <brief.md>"); process.exit(1); }
      const content = readFileSync(file, "utf-8");
      const config = JSON.parse(project.config_json || "{}");
      config.brief = content;
      db.run("UPDATE projects SET config_json = ? WHERE id = ?", [JSON.stringify(config), project.id]);
      success(`Brief imported (${content.length} chars)`);
      break;
    }
    case "show": {
      const config = JSON.parse(project.config_json || "{}");
      const brief = config.brief ?? "(no brief set — run 'film brief set --file brief.md')";
      emit({ brief }, brief);
      break;
    }
    case "set-dna": {
      const fileIdx = args.indexOf("--file");
      const file = fileIdx !== -1 ? args[fileIdx + 1] : null;
      if (!file || !existsSync(file)) { error("Usage: film brief set-dna --file <dna.md>"); process.exit(1); }
      const content = readFileSync(file, "utf-8");
      const config = JSON.parse(project.config_json || "{}");
      config.visual_dna = content;
      db.run("UPDATE projects SET config_json = ? WHERE id = ?", [JSON.stringify(config), project.id]);
      success(`Visual DNA imported (${content.length} chars)`);
      break;
    }
    case "show-dna": {
      const config = JSON.parse(project.config_json || "{}");
      const dna = config.visual_dna ?? "(no visual DNA set — run 'film brief set-dna --file dna.md')";
      emit({ visual_dna: dna }, dna);
      break;
    }
    default:
      error(`Unknown: ${sub}`);
      console.log(HELP);
  }

  db.close();
}
