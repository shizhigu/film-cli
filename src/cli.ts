#!/usr/bin/env bun
/**
 * film CLI — AI filmmaking production harness.
 *
 * Usage:
 *   film init "My Film"
 *   film status
 *   film episode create 1 --title "Pilot"
 *   film shot create 1 1 --framing MCU --dialogue "Where's the bike?"
 *   film shot list 1
 *   film shot status 1 5
 */

import { parseArgs } from "util";
import { initCmd } from "./commands/init";
import { statusCmd } from "./commands/status";
import { configCmd } from "./commands/config";
import { episodeCmd } from "./commands/episode";
import { shotCmd } from "./commands/shot";
import { assetCmd } from "./commands/asset";
import { rulesCmd } from "./commands/rules";
import { assembleCmd } from "./commands/assemble";
import { briefCmd } from "./commands/brief";

const HELP = `
film — AI filmmaking production harness

Commands:
  init <name>              Initialize a new project
  status                   Show project status dashboard
  brief <set|show|set-dna> Manage creative brief & visual DNA
  config <get|set|list>    Manage configuration
  episode <create|list>    Manage episodes
  shot <create|list|next|status|generate-frame|review-frame|
        generate-video|review-video|decide>   The core production loop
  asset <register|list|lock>        Manage assets
  assemble <rough-cut|remotion|render>  Build final cuts
  rules <list|check|failures>       Production rules & knowledge base

Flags:
  --json                   Output JSON for agent consumption
  --help                   Show this help

Workflow (Claude Code drives each step):
  1. film init → brief set → brief set-dna
  2. film asset register (character portraits + scene refs — DO THIS FIRST)
  3. film episode create → film shot create (bind --character-refs)
  4. Greedy loop: generate-frame → review-frame → generate-video → review-video → decide
  5. film shot next (find next shot to work on)
  6. film assemble rough-cut → film assemble review

  Sound is ALWAYS on. Character refs are NOT optional.

Examples:
  film init "Second Hand"
  film status --json
  film brief set --file brief.md
  film asset register portrait.png --type portrait --character "Maggie"
  film episode create 1 --title "The Photograph"
  film shot create 1 1 --framing MCU --scene pawnshop --character-refs 1
  film shot next 1 --json
`;

// Global state
export let jsonMode = false;

async function main() {
  const args = process.argv.slice(2);

  // Handle --json flag globally
  const jsonIdx = args.indexOf("--json");
  if (jsonIdx !== -1) {
    jsonMode = true;
    args.splice(jsonIdx, 1);
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];
  const rest = args.slice(1);

  try {
    switch (command) {
      case "init":
        initCmd(rest);
        break;
      case "status":
        statusCmd(rest);
        break;
      case "config":
        configCmd(rest);
        break;
      case "episode":
        episodeCmd(rest);
        break;
      case "shot":
        await shotCmd(rest);
        break;
      case "asset":
        assetCmd(rest);
        break;
      case "rules":
        rulesCmd(rest);
        break;
      case "brief":
        briefCmd(rest);
        break;
      case "assemble":
        await assembleCmd(rest);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err: any) {
    if (jsonMode) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
