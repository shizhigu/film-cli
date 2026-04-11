/**
 * film rules — production knowledge base.
 *
 * Every rule here prevented or fixed a specific real production failure.
 * These aren't theoretical — they're battle-tested across 35+ shots.
 */

import { readFileSync, existsSync } from "fs";
import { validateFramePrompt, validateKlingPrompt, validateKlingParams, formatResults } from "../rules";
import { emit, error } from "../output";

const HELP = `
film rules — Production rules and knowledge base.

Subcommands:
  list                          List all 30 production rules
  check --type <frame|kling> --prompt-file <path>   Validate a prompt
  failures [--category <cat>]   List known failure modes + fixes

Categories for failures:
  lip_sync, character, physics, audio, prompt, scene

This knowledge base encodes lessons from 35+ shots across two productions.
Each rule saved at least one wasted API call. The rules engine runs
automatically during 'film shot generate-frame' and 'film shot generate-video',
but you can also check prompts manually with 'film rules check'.
`;

const RULES_LIST = `
=== MODEL & ENDPOINT ===
R001  Always kling-v3 or kling-v3-omni. Never switch models.
R002  Always --sound on when voice_list present.
R003  voice_list max 2 entries (API hard limit).
R004  Prompt max 2500 characters (API hard limit).

=== DIALOGUE SYNTAX ===
R005  Inline dialogue: [Character: desc]: Chinese text — only working format.
R006  Chain dialogue with "Immediately," (rapid) or "Then" (new beat).
R007  Never <<<voice_N>>> token (ignores voice_id). Never text field in voice_list.
R008  voice_list order maps to dialogue order (first id = first speaker).

=== SHOT STRUCTURE ===
R009  Single long takes > split sub-shots (omni supports 15s + 4-6 exchanges).
R010  Single-character MCU > wide two-shot for lip-sync reliability.
R011  Frozen mid-motion frames > static portraits for first frames.
R012  Every shot needs 3 motion layers: camera + subject + atmosphere.
R013  Camera MUST move. Never "locked/static camera" — freezes Kling output.

=== CHARACTER CONSISTENCY ===
R014  Always pass character portrait refs in omni image_list (beyond first_frame).
R015  Mouth-blocking objects (pipe/cigarette) → relocate to hand for speaking.
R016  Scene ref images = strict spatial authority. Never add unseen elements.

=== VOICE ===
R017  Never external TTS. Kling native voice_list only (lip-sync in same render pass).
R018  Off-screen voices sound telephone-quality. Split into separate MCU shots.
R019  Chinese dialogue for voice generation. Chinese names for proper nouns.

=== REVIEW ===
R020  Gemini 3.1 Pro for all review. Flash misses narrative/composition issues.
R021  Always include prompt text in review requests (enables prompt engineering feedback).
R022  Quality over cost. Bad product = zero value. Redo until right.

=== PROMPT ENGINEERING ===
R023  NB2: professional cinema vocabulary (ARRI, Cooke, f/2.0, Dehancer Kodak 2383).
R024  Kling: simplified vocabulary (warm table lamp light, shallow focus). Less technical.
R025  Never start NB2 prompts with title text — renders as on-screen watermark.
R026  Performance direction = visible micro-actions, not internal states.
      "Eyes close briefly, jaw tightens" works. "Sad expression" doesn't.

=== PRODUCTION ===
R027  Shot-by-shot greedy algorithm. One shot at a time. Never batch generate.
R028  Dialogue shots need physical action + emotion. Not interview-style stillness.
R029  Restructure content > post-production hacks when AI physics fails.
R030  Kling sometimes adds BGM despite negatives. Accept or filter in post.
R031  Sound ALWAYS on (--sound on). Kling generates ambient audio natively.
R032  Character refs are NOT optional. Without them, every shot is a different person.
R033  Don't use timestamp sequences in Kling prompts (0-2s X, 2-3s Y).
      Kling flattens them to one average action. Use flowing single descriptions.
R034  When Kling can't do micro-motion (eyes-only), accept macro-motion and
      redirect as intentional narrative. Don't fight the model's natural output.
R035  Generate character portraits + scene refs BEFORE any shot production.
      Bind them to shots. This is step 2, not an afterthought.
`;

const FAILURE_MODES = [
  { category: "lip_sync", symptom: "Lip-sync dead in wide two-shot", fix: "Split into single-character MCU shots" },
  { category: "lip_sync", symptom: "Mouth doesn't move with pipe/cigarette", fix: "Move object to hand for speaking shots" },
  { category: "lip_sync", symptom: "Off-screen voice sounds telephone-quality", fix: "Give each speaker their own MCU shot" },
  { category: "character", symptom: "Wrong ethnicity mid-shot (camera reveals face)", fix: "Always pass character portrait ref as omni asset image" },
  { category: "character", symptom: "Wardrobe color shifts between shots", fix: "Over-shoulder framing with character's back visible; pass ref" },
  { category: "character", symptom: "Face morphs in long takes (>6s)", fix: "Keep character-heavy takes under 6 seconds" },
  { category: "physics", symptom: "Entire frame frozen (PPT-like output)", fix: "Remove 'locked/static camera' from prompt. Always specify camera movement." },
  { category: "physics", symptom: "Hands/fingers fuse with objects", fix: "Show only fingertips + object edge, or hide hands below frame" },
  { category: "physics", symptom: "Sequential digit countdown skips numbers", fix: "Replace with single sentences, no T-minus counting" },
  { category: "physics", symptom: "Head cropped out of frame during generation", fix: "Ensure sufficient headroom in first frame; keep camera push subtle (2-3%)" },
  { category: "audio", symptom: "Unwanted background music despite negatives", fix: "Accept or filter in post-production; add music only in final mix" },
  { category: "audio", symptom: "Audio too quiet from Kling", fix: "Apply +4dB pre-boost before loudnorm (I=-12:LRA=7:TP=-1)" },
  { category: "audio", symptom: "Voice tone drifts between concatenated clips", fix: "Use single long take (up to 15s) instead of splitting" },
  { category: "audio", symptom: "Wrong voice gender", fix: "Used <<<voice_N>>> token by mistake. Use [Character: desc]: text syntax" },
  { category: "audio", symptom: "Silent output", fix: "Put text field in voice_list by mistake. Put dialogue in prompt only" },
  { category: "prompt", symptom: "On-screen text watermark in generated frame", fix: "Don't start NB2 prompt with title/header text" },
  { category: "prompt", symptom: "'Sad expression' produces nothing", fix: "Use micro-actions: 'eyes close briefly, jaw tightens, single tear'" },
  { category: "prompt", symptom: "Stiff interview-style performance", fix: "Add body language: scoffs, gestures, leans, shakes head, throws hands up" },
  { category: "scene", symptom: "New door appears where window should be", fix: "Scene ref is spatial authority. Never add elements not in the ref." },
  { category: "scene", symptom: "Character on wrong side of counter", fix: "Describe exact spatial relationships matching scene ref in every prompt" },
  { category: "scene", symptom: "Shop looks different across shots", fix: "Always pass scene establishing image as ref anchor" },
  { category: "character", symptom: "Different person in each shot (clothing/age/features change)", fix: "Register character portrait as asset, bind to shots, pass as --ref in every generation" },
  { category: "prompt", symptom: "Timestamp sequences ignored (0-2s X, 2-3s Y flattened)", fix: "Don't use timestamps. Describe one flowing action. AI averages multi-step instructions." },
  { category: "physics", symptom: "Micro-motion ignored (eyes-only, subtle dust settling)", fix: "Kling can't do ultra-subtle motion. Use larger, clearer actions. Accept macro motion." },
  { category: "physics", symptom: "Mouth opens/speaks when not asked to", fix: "Add explicit 'no mouth movement, no speaking' to negatives. Lock facial muscles in prompt." },
  { category: "audio", symptom: "No ambient sound in generated video", fix: "Set --sound on (should be default). Kling generates ambient audio even without voice_list." },
  { category: "physics", symptom: "Dust/particles treated as frozen texture", fix: "Use strong action words: 'actively billowing, visibly swirling'. Subtle descriptions get frozen." },
];

export function rulesCmd(args: string[]) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const sub = args[0];

  switch (sub) {
    case "list":
      console.log(RULES_LIST);
      break;

    case "check": {
      const typeIdx = args.indexOf("--type");
      const fileIdx = args.indexOf("--prompt-file");
      const type = typeIdx !== -1 ? args[typeIdx + 1] : null;
      const file = fileIdx !== -1 ? args[fileIdx + 1] : null;

      if (!type || !file) {
        error("Usage: film rules check --type <frame|kling> --prompt-file <path>");
        process.exit(1);
      }

      if (!existsSync(file)) {
        error(`File not found: ${file}`);
        process.exit(1);
      }

      const prompt = readFileSync(file, "utf-8");
      const results = type === "frame"
        ? validateFramePrompt(prompt)
        : validateKlingPrompt(prompt);

      if (results.length === 0) {
        console.log("  All rules passed.");
      } else {
        console.log(formatResults(results));
      }
      break;
    }

    case "failures": {
      const catIdx = args.indexOf("--category");
      const category = catIdx !== -1 ? args[catIdx + 1] : null;

      const filtered = category
        ? FAILURE_MODES.filter((f) => f.category === category)
        : FAILURE_MODES;

      for (const f of filtered) {
        console.log(`  [${f.category.toUpperCase()}] ${f.symptom}`);
        console.log(`    Fix: ${f.fix}`);
        console.log();
      }
      break;
    }

    default:
      error(`Unknown subcommand: ${sub}`);
      console.log(HELP);
      process.exit(1);
  }
}
