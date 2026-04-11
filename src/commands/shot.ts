/**
 * film shot — the core production loop.
 *
 * This is where the greedy shot-by-shot algorithm lives.
 * Each shot progresses through a state machine with quality gates.
 */

import { openDb, getProject, getEpisode, getShot, getShots, getVersions, getLatestVersion, getLatestReview, findProjectRoot, getAssets } from "../db";
import { getNextAction, type ShotStatus, MAX_ITERATIONS } from "../state";
import { validateFramePrompt, validateKlingPrompt, validateKlingParams, formatResults, hasErrors } from "../rules";
import { emit, success, error, table } from "../output";
import { generateImage } from "../integrations/nb2";
import { generateOmniVideo, type OmniParams } from "../integrations/kling";
import { reviewFrame as geminiReviewFrame, reviewVideo as geminiReviewVideo } from "../integrations/gemini";
import { getNB2Config, getKlingConfig, getGeminiConfig, getProjectDefaults } from "../integrations/config";
import { parseSpecYaml, validateSpec, formatSpecErrors, hasSpecErrors, composeFramePrompt, composeKlingPrompt, validatePromptAgainstSpec, type ShotSpec } from "../spec";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const HELP = `
film shot — Manage shots (the core production loop).

Subcommands:
  create <ep> <shot> [options]       Create a shot in the shot list
  import <ep> --file <json>          Bulk import shots from JSON
  list <ep>                          List all shots with status
  status <ep> <shot>                 Detailed shot status + version history
  generate-frame <ep> <shot> [opts]  Generate first frame via NB2
  review-frame <ep> <shot> [opts]    Review frame with Gemini Pro
  generate-video <ep> <shot> [opts]  Generate video via Kling omni
  review-video <ep> <shot> [opts]    Review video with Gemini Pro
  decide <ep> <shot> <action>        Record accept/reroll/restructure decision

Options for create:
  --scene <name>                   Scene/location name
  --framing <ECU|MCU|MS|MLS|WS>   Shot framing
  --angle <text>                   Camera angle description
  --camera-move <text>             Camera movement description
  --duration <seconds>             Target duration (3-15, default 5)
  --dialogue <text>                Dialogue text for this shot
  --voice-ids <id1,id2>            Kling voice clone IDs (max 2)
  --character-refs <id1,id2>       Asset IDs for character references
  --scene-ref <id>                 Asset ID for scene reference
  --notes <text>                   Production notes

CRITICAL WORKFLOW (Claude Code drives this loop):
  1. film brief set + set-dna       ← set concept + visual language FIRST
  2. film asset register/generate   ← character refs + scene refs BEFORE any shot
  3. film shot create with --character-refs and --scene-ref bound
  4. For each shot (greedy, sequential):
     a. Write frame prompt (6 sections + visual DNA)
     b. film shot generate-frame    ← pass --ref for character consistency
     c. film shot review-frame      ← Gemini scores, gives prompt_fix
     d. If <8: rewrite prompt using Gemini feedback → go to (b)
     e. Write Kling prompt (3-layer motion)
     f. film shot generate-video    ← sound ALWAYS on (ambient audio)
     g. film shot review-video      ← Gemini scores with BOTH prompts
     h. If <8: rewrite prompt → go to (b) or restructure shot design
     i. film shot decide accept
  5. film shot next → get next shot, repeat from 4
  6. film assemble rough-cut → film assemble review → if <7 go fix shots

Rules:
  - Max 6 iterations per shot → structural_failure
  - Character refs are NOT optional — without them every shot looks different
  - Sound is ALWAYS on — Kling generates ambient audio natively
  - Camera MUST move — "static/locked camera" freezes entire output
  - Frozen mid-motion frames > static portraits (stiff animation)
  - 3 motion layers required: camera + subject + atmosphere
  - Single-character MCU > wide two-shot for lip-sync
  - Don't use timestamp sequences in Kling prompts (flattened to one action)
  - When Kling can't do micro-motion, accept the macro and redirect narrative
`;

export async function shotCmd(args: string[]) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "create":
      createShot(rest);
      break;
    case "import":
      importShots(rest);
      break;
    case "list":
      listShots(rest);
      break;
    case "status":
      shotStatus(rest);
      break;
    case "generate-frame":
      await generateFrame(rest);
      break;
    case "review-frame":
      await reviewFrameCmd(rest);
      break;
    case "generate-video":
      await generateVideoCmd(rest);
      break;
    case "review-video":
      await reviewVideoCmd(rest);
      break;
    case "spec":
      shotSpec(rest);
      break;
    case "next":
      shotNext(rest);
      break;
    case "decide":
      shotDecide(rest);
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

function createShot(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error("Usage: film shot create <episode> <shot> [--scene ...] [--framing ...]");
    process.exit(1);
  }

  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  const scene = parseFlag(args, "--scene") ?? "";
  const framing = parseFlag(args, "--framing") ?? "";
  const angle = parseFlag(args, "--angle") ?? "";
  const cameraMove = parseFlag(args, "--camera-move") ?? "";
  const duration = parseFloat(parseFlag(args, "--duration") ?? "5");
  const dialogue = parseFlag(args, "--dialogue") ?? "";
  const voiceIds = parseFlag(args, "--voice-ids") ?? "[]";
  const charRefs = parseFlag(args, "--character-refs") ?? "[]";
  const sceneRef = parseFlag(args, "--scene-ref");
  const notes = parseFlag(args, "--notes") ?? "";

  db.run(
    `INSERT INTO shots (episode_id, number, scene_name, framing, angle, camera_move,
     duration_target, dialogue_text, voice_ids_json, character_ref_ids_json,
     scene_ref_id, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
    [
      ep.id, shotNum, scene, framing, angle, cameraMove,
      duration, dialogue,
      voiceIds.startsWith("[") ? voiceIds : JSON.stringify(voiceIds.split(",")),
      charRefs.startsWith("[") ? charRefs : JSON.stringify(charRefs.split(",")),
      sceneRef ? parseInt(sceneRef) : null,
      notes,
    ]
  );

  db.close();
  success(`Shot ${shotNum} created in episode ${epNum}`, {
    episode: epNum,
    shot: shotNum,
    scene,
    framing,
    status: "planned",
  });
}

function importShots(args: string[]) {
  const epNum = parseInt(args[0]);
  const filePath = parseFlag(args, "--file");
  if (isNaN(epNum) || !filePath) {
    error("Usage: film shot import <episode> --file <shots.json>");
    process.exit(1);
  }

  const data = JSON.parse(Bun.file(filePath).text() as any);
  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  let count = 0;
  for (const shot of data) {
    db.run(
      `INSERT INTO shots (episode_id, number, scene_name, framing, angle, camera_move,
       duration_target, dialogue_text, notes, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
      [ep.id, shot.number, shot.scene ?? "", shot.framing ?? "", shot.angle ?? "",
       shot.camera_move ?? "", shot.duration ?? 5, shot.dialogue ?? "", shot.notes ?? ""]
    );
    count++;
  }

  db.close();
  success(`Imported ${count} shots into episode ${epNum}`, { episode: epNum, count });
}

function listShots(args: string[]) {
  const epNum = parseInt(args[0]);
  if (isNaN(epNum)) { error("Usage: film shot list <episode>"); process.exit(1); }

  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  const shots = getShots(db, ep.id);
  const rows = shots.map((s) => {
    const versions = getVersions(db, s.id);
    const latest = versions[versions.length - 1];
    let score = "-";
    let review: Record<string, any> | null = null;
    if (latest) {
      review = getLatestReview(db, latest.id, "video") ?? getLatestReview(db, latest.id, "frame");
      if (review?.score) score = String(review.score);
    }
    const action = getNextAction(s.status as ShotStatus, review?.score ?? null, Math.max(0, versions.length - 1));
    return [
      s.number,
      s.framing ?? "",
      s.scene_name ?? "",
      s.status,
      `v${versions.length}`,
      score,
      action,
      (s.dialogue_text ?? "").slice(0, 25) + ((s.dialogue_text?.length ?? 0) > 25 ? ".." : ""),
    ];
  });

  table(["#", "Frame", "Scene", "Status", "Ver", "Score", "Next", "Dialogue"], rows);
  db.close();
}

/** film shot next — Show the next shot to work on and what action to take. */
function shotNext(args: string[]) {
  const epNum = parseInt(args[0]);
  if (isNaN(epNum)) { error("Usage: film shot next <episode>"); process.exit(1); }

  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  const shots = getShots(db, ep.id);

  // Find first non-accepted shot in order
  for (const s of shots) {
    if (s.status === "accepted") continue;

    const versions = getVersions(db, s.id);
    const latest = versions[versions.length - 1];
    let review: Record<string, any> | null = null;
    if (latest) {
      review = getLatestReview(db, latest.id, "video") ?? getLatestReview(db, latest.id, "frame");
    }
    const rerollCount = Math.max(0, versions.length - 1);
    const action = getNextAction(s.status as ShotStatus, review?.score ?? null, rerollCount);

    // Get previous accepted shot's video path for greedy context
    let prevAcceptedVideo: string | null = null;
    for (let i = shots.indexOf(s) - 1; i >= 0; i--) {
      if (shots[i].status === "accepted") {
        const pv = getLatestVersion(db, shots[i].id);
        if (pv?.video_path) prevAcceptedVideo = pv.video_path;
        break;
      }
    }

    const data = {
      episode: epNum,
      shot: s.number,
      status: s.status,
      scene: s.scene_name,
      framing: s.framing,
      dialogue: s.dialogue_text,
      next_action: action,
      version: versions.length,
      latest_score: review?.score ?? null,
      latest_fix: review?.one_fix ?? null,
      previous_accepted_video: prevAcceptedVideo,
      notes: s.notes,
    };

    emit(data, [
      `Next: Shot ${s.number} | ${s.framing ?? "?"} | ${s.scene_name ?? "?"}`,
      `Action: ${action}`,
      `Status: ${s.status} (v${versions.length})`,
      review?.score ? `Last score: ${review.score}/10` : "",
      review?.one_fix ? `Fix: ${review.one_fix}` : "",
      prevAcceptedVideo ? `Previous shot video: ${prevAcceptedVideo}` : "",
      s.dialogue_text ? `Dialogue: ${s.dialogue_text}` : "",
      s.notes ? `Notes: ${s.notes}` : "",
    ].filter(Boolean).join("\n"));

    db.close();
    return;
  }

  // All accepted
  db.close();
  success("All shots accepted! Ready for assembly.", {
    episode: epNum,
    next_action: "assemble",
    command: `film assemble rough-cut ${epNum}`,
  });
}

function shotStatus(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error("Usage: film shot status <episode> <shot>");
    process.exit(1);
  }

  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found in episode ${epNum}.`); process.exit(1); }

  const versions = getVersions(db, shot.id);
  const latest = versions[versions.length - 1];

  let latestReview: Record<string, any> | null = null;
  if (latest) {
    latestReview = getLatestReview(db, latest.id, "video") ?? getLatestReview(db, latest.id, "frame");
  }

  const rerollCount = versions.length - 1;
  const nextAction = getNextAction(
    shot.status as ShotStatus,
    latestReview?.score ?? null,
    rerollCount
  );

  const data = {
    episode: epNum,
    shot: shotNum,
    status: shot.status,
    scene: shot.scene_name,
    framing: shot.framing,
    camera_move: shot.camera_move,
    duration_target: shot.duration_target,
    dialogue: shot.dialogue_text,
    versions: versions.length,
    accepted_version: shot.accepted_version,
    latest_score: latestReview?.score ?? null,
    latest_fix: latestReview?.one_fix ?? null,
    latest_recommendation: latestReview?.decision_recommendation ?? null,
    next_action: nextAction,
    notes: shot.notes,
  };

  emit(data, [
    `Shot ${shotNum} | ${shot.framing ?? "?"} | ${shot.scene_name ?? "?"}`,
    `Status:  ${shot.status} (v${versions.length})`,
    latestReview ? `Score:   ${latestReview.score}/10` : "",
    latestReview?.one_fix ? `Fix:     ${latestReview.one_fix}` : "",
    `Next:    ${nextAction}`,
    shot.dialogue_text ? `Dialog:  ${shot.dialogue_text}` : "",
    shot.notes ? `Notes:   ${shot.notes}` : "",
  ].filter(Boolean).join("\n"));

  db.close();
}

// ================================================================
// film shot spec — Import structured shot specification (YAML)
//
// This is the ANTI-LAZINESS enforcement. Every shot must define:
//   subject, action, camera.move, lighting, audio, performance, dialogue
// The CLI validates completeness and rejects incomplete specs.
// ================================================================

function shotSpec(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error(`Usage: film shot spec <ep> <shot> --file <spec.yaml>

Shot specification — the anti-laziness enforcer. Every shot MUST define
all required fields. The CLI rejects vague or incomplete specs.

=== REQUIRED FIELDS ===
  subject:      Who/what is in frame + their state
  action:       Visual beats (NOT abstract). Decompose into body parts + directions + FX.
                BAD:  "vampire splits into two"
                GOOD: ["raises hand palm-up", "dark mist seeps between fingers",
                       "mist explodes outward in two streams",
                       "streams coalesce into two silhouettes"]
  camera:
    framing:    ECU / MCU / MS / MLS / WS
    angle:      "eye-level" / "low 30° up" / "over-shoulder"
    move:       Camera movement (REQUIRED — "static" is BLOCKED)
    focus:      Focus pull: "rack focus from hands to face at 3s"
    lens:       Override project DNA: "anamorphic 40mm"
  lighting:     Key light direction + color temp + fill ratio
  audio:
    room_tone:  REQUIRED. Location-specific silence/ambient
    foley:      Physical sounds: "footsteps, clothing rustle, chair creak"
    sfx:        Discrete effects: "glass shatter at 3s"
    walla:      Background voices: "muffled café conversations"
    ambience:   Environmental: "rain on window, distant traffic"
    music:      Post-production only: "tense strings swell"
  avoid:        Negative constraints list

=== DIALOGUE SHOTS ===
  dialogue:     character, voice_id, voice_desc, chinese, english

=== CHARACTER SHOTS ===
  performance:  character, facial micro-actions, body language, emotional arc

=== CONTINUITY & TRANSITIONS ===
  continues_from: 3        Previous shot's last frame = this shot's first frame
  transition:
    type:       hard_cut / cross_dissolve / dip_to_black / match_cut / j_cut / l_cut
    duration_frames: 12
    audio_overlap_frames: 15   (for J/L cuts)
    match_element: "cup shape → doorknob"  (for match cuts)

=== VFX & COLOR ===
  vfx:
    complexity: none / low / medium / high
    elements:   ["blood mist", "clone duplication"]
  color_grade:
    lut:        Override: "Kodak 2383"
    reference_shot: 2      Match color to shot 2
    mood_shift: "warmer than previous"`);
    process.exit(1);
  }

  const file = parseFlag(args, "--file");
  if (!file || !existsSync(file)) {
    error("--file <spec.yaml> required");
    process.exit(1);
  }

  const content = readFileSync(file, "utf-8").trim();
  // Support both YAML and JSON — JSON is more reliable for nested structures
  let spec: ShotSpec;
  if (content.startsWith("{")) {
    spec = JSON.parse(content) as ShotSpec;
  } else {
    spec = parseSpecYaml(content);
  }

  // Validate
  const hasChars = !!(spec.performance?.length || spec.dialogue?.length);
  const errors = validateSpec(spec, hasChars);

  if (errors.length > 0) {
    console.error("  Spec validation:");
    console.error(formatSpecErrors(errors));
  }

  if (hasSpecErrors(errors)) {
    error("Spec has errors. Fix required fields and retry.");
    process.exit(1);
  }

  // Store in DB
  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found in episode ${epNum}.`); process.exit(1); }

  db.run("UPDATE shots SET spec_json = ?, framing = ?, duration_target = ?, dialogue_text = ? WHERE id = ?", [
    JSON.stringify(spec),
    spec.camera?.framing ?? shot.framing,
    spec.duration ?? shot.duration_target,
    spec.dialogue?.map(d => d.english).join(" / ") ?? shot.dialogue_text,
    shot.id,
  ]);

  // Auto-compose and show the prompts that would be generated
  const project = getProject(db);
  const visualDna = JSON.parse(project?.config_json ?? "{}").visual_dna ?? "";
  const framePrompt = composeFramePrompt(spec, visualDna);
  const klingPrompt = composeKlingPrompt(spec, visualDna);

  db.close();

  success(`Spec imported for shot ${shotNum}`, {
    episode: epNum,
    shot: shotNum,
    spec_valid: !hasSpecErrors(errors),
    warnings: errors.filter(e => e.severity === "warning").length,
    has_dialogue: !!(spec.dialogue?.length),
    has_performance: !!(spec.performance?.length),
    composed_frame_prompt_length: framePrompt.length,
    composed_kling_prompt_length: klingPrompt.length,
  });

  // Show composed prompts preview
  console.error(`\n  Frame prompt (${framePrompt.length} chars):`);
  console.error(`  ${framePrompt.slice(0, 120)}...`);
  console.error(`\n  Kling prompt (${klingPrompt.length} chars):`);
  console.error(`  ${klingPrompt.slice(0, 120)}...`);
}

function shotDecide(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  const action = args[2] as "accept" | "reroll" | "restructure";
  if (isNaN(epNum) || isNaN(shotNum) || !["accept", "reroll", "restructure"].includes(action)) {
    error("Usage: film shot decide <episode> <shot> <accept|reroll|restructure> [--reason <text>]");
    process.exit(1);
  }

  const reason = parseFlag(args, "--reason") ?? "";
  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found.`); process.exit(1); }

  const latest = getLatestVersion(db, shot.id);
  if (!latest) { error("No version exists for this shot."); process.exit(1); }

  // Record decision
  db.run(
    "INSERT INTO decisions (version_id, action, reason) VALUES (?, ?, ?)",
    [latest.id, action, reason]
  );

  // Update shot status
  if (action === "accept") {
    db.run(
      "UPDATE shots SET status = 'accepted', accepted_version = ? WHERE id = ?",
      [latest.version_number, shot.id]
    );
  } else if (action === "reroll") {
    db.run("UPDATE shots SET status = 'rerolled' WHERE id = ?", [shot.id]);
    // Create next version stub
    db.run(
      "INSERT INTO versions (shot_id, version_number) VALUES (?, ?)",
      [shot.id, latest.version_number + 1]
    );
    db.run("UPDATE shots SET status = 'planned' WHERE id = ?", [shot.id]);
  } else if (action === "restructure") {
    db.run("UPDATE shots SET status = 'restructured' WHERE id = ?", [shot.id]);
    db.run(
      "INSERT INTO versions (shot_id, version_number) VALUES (?, ?)",
      [shot.id, latest.version_number + 1]
    );
    db.run("UPDATE shots SET status = 'planned' WHERE id = ?", [shot.id]);
  }

  db.close();
  success(`Shot ${shotNum}: ${action}${reason ? ` — ${reason}` : ""}`, {
    episode: epNum,
    shot: shotNum,
    action,
    reason,
    version: latest.version_number,
  });
}

// ================================================================
// film shot generate-frame — Generate first frame via NB2
// ================================================================

async function generateFrame(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error("Usage: film shot generate-frame <ep> <shot> --prompt <text> | --prompt-file <path>");
    process.exit(1);
  }

  // Get prompt: from spec (auto-compose) > --prompt > --prompt-file
  const db_pre = openDb();
  const shot_pre = getShot(db_pre, epNum, shotNum);
  const project_pre = getProject(db_pre);
  const visualDna_pre = JSON.parse(project_pre?.config_json ?? "{}").visual_dna ?? "";
  let prompt = parseFlag(args, "--prompt") ?? "";
  const promptFile = parseFlag(args, "--prompt-file");
  if (promptFile) {
    if (!existsSync(promptFile)) { error(`Prompt file not found: ${promptFile}`); process.exit(1); }
    prompt = readFileSync(promptFile, "utf-8").trim();
  }
  // Auto-compose from spec if no manual prompt
  let useContinuityFrame = false;
  let continuityFramePath = "";
  if (!prompt && shot_pre?.spec_json) {
    const spec = JSON.parse(shot_pre.spec_json) as ShotSpec;

    // Check continues_from — extract last frame from previous shot's video
    if (spec.continues_from) {
      const prevShot = getShot(db_pre, epNum, spec.continues_from);
      if (prevShot) {
        const prevVersion = getLatestVersion(db_pre, prevShot.id);
        if (prevVersion?.video_path && existsSync(prevVersion.video_path)) {
          const root = findProjectRoot()!;
          const extractDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "shots",
            `shot${String(shotNum).padStart(2, "0")}`);
          const { mkdirSync } = await import("fs");
          mkdirSync(extractDir, { recursive: true });
          continuityFramePath = join(extractDir, "continuity_frame.png");
          try {
            const { execSync } = await import("child_process");
            // Extract last frame from previous shot's video
            execSync(
              `ffmpeg -y -sseof -0.1 -i "${prevVersion.video_path}" -frames:v 1 -q:v 2 "${continuityFramePath}"`,
              { timeout: 30_000, stdio: "pipe" }
            );
            useContinuityFrame = true;
            console.error(`  CONTINUITY: Using last frame from shot ${spec.continues_from} as first frame`);
            console.error(`  Extracted: ${continuityFramePath}`);
          } catch (e) {
            console.error(`  Warning: Could not extract last frame from shot ${spec.continues_from}`);
          }
        }
      }
    }

    if (!useContinuityFrame) {
      prompt = composeFramePrompt(spec, visualDna_pre);
      console.error(`  Auto-composed frame prompt from spec (${prompt.length} chars)`);
    }
  }
  db_pre.close();
  if (!prompt && !useContinuityFrame) { error("No prompt. Either set spec with 'film shot spec' or use --prompt/--prompt-file"); process.exit(1); }

  // If using continuity frame, skip NB2 generation entirely
  if (useContinuityFrame && continuityFramePath) {
    const db = openDb();
    const shot = getShot(db, epNum, shotNum);
    if (!shot) { error(`Shot ${shotNum} not found.`); process.exit(1); }
    const root = findProjectRoot()!;
    const versions = getVersions(db, shot.id);
    const actualVersion = versions.length === 0 ? 1 : versions[versions.length - 1].version_number + 1;
    const shotDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "shots",
      `shot${String(shotNum).padStart(2, "0")}`, `v${actualVersion}`);
    const { mkdirSync, copyFileSync } = await import("fs");
    mkdirSync(shotDir, { recursive: true });
    const framePath = join(shotDir, "frame.png");
    copyFileSync(continuityFramePath, framePath);

    db.run("INSERT INTO versions (shot_id, version_number, frame_prompt, frame_path, frame_generated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      [shot.id, actualVersion, `[CONTINUITY] Last frame from shot ${JSON.parse(shot.spec_json ?? "{}").continues_from}`, framePath]);
    db.run("UPDATE shots SET status = 'frame_generated' WHERE id = ?", [shot.id]);
    db.close();

    success(`Frame from continuity (shot ${JSON.parse(shot.spec_json ?? "{}").continues_from} last frame)`, {
      episode: epNum, shot: shotNum, version: actualVersion,
      frame_path: framePath, continuity: true, status: "frame_generated",
    });
    return;
  }

  // Validate prompt against rules
  const ruleResults = validateFramePrompt(prompt);
  if (ruleResults.length > 0) {
    console.error("  Rules check:");
    console.error(formatResults(ruleResults));
    if (hasErrors(ruleResults) && !args.includes("--force")) {
      error("Blocked by rule errors. Use --force to override.");
      process.exit(1);
    }
  }

  // Validate prompt against spec (anti-laziness check)
  const db_spec = openDb();
  const shot_spec = getShot(db_spec, epNum, shotNum);
  if (shot_spec?.spec_json) {
    const spec = JSON.parse(shot_spec.spec_json) as ShotSpec;
    const specCheck = validatePromptAgainstSpec(prompt, spec, "frame");
    if (specCheck.length > 0) {
      console.error("  Spec compliance check (did you forget something?):");
      console.error(formatSpecErrors(specCheck));
    }
  }
  db_spec.close();

  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found in episode ${epNum}.`); process.exit(1); }

  // Determine version number
  const versions = getVersions(db, shot.id);
  const versionNum = versions.length > 0
    ? (versions[versions.length - 1].version_number || versions.length)
    : 1;
  const newVersion = versions.length > 0 && !versions[versions.length - 1].frame_path
    ? versionNum  // reuse stub version from reroll
    : versionNum + (versions.length > 0 ? 1 : 0);
  const actualVersion = versions.length === 0 ? 1 : newVersion;

  // Resolve ref images from shot's character_ref_ids and scene_ref_id
  const root = findProjectRoot()!;
  const refs: string[] = [];

  // Character refs
  try {
    const charRefIds = JSON.parse(shot.character_ref_ids_json ?? "[]");
    for (const refId of charRefIds) {
      const asset = db.query("SELECT file_path FROM assets WHERE id = ?").get(refId) as any;
      if (asset?.file_path && existsSync(join(root, asset.file_path))) {
        refs.push(join(root, asset.file_path));
      } else if (asset?.file_path && existsSync(asset.file_path)) {
        refs.push(asset.file_path);
      }
    }
  } catch {}

  // Scene ref
  if (shot.scene_ref_id) {
    const sceneAsset = db.query("SELECT file_path FROM assets WHERE id = ?").get(shot.scene_ref_id) as any;
    if (sceneAsset?.file_path) {
      const p = existsSync(join(root, sceneAsset.file_path))
        ? join(root, sceneAsset.file_path)
        : sceneAsset.file_path;
      if (existsSync(p)) refs.push(p);
    }
  }

  // Additional refs from --ref flag
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--ref" && args[i + 1]) {
      refs.push(args[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }

  // Build output path
  const shotDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "shots", `shot${String(shotNum).padStart(2, "0")}`, `v${actualVersion}`);

  // Warn if no character refs — this is the #1 cause of cross-shot inconsistency
  if (refs.length === 0) {
    console.error(`  WARNING: No character/scene refs. Cross-shot consistency will suffer.`);
    console.error(`  Run 'film asset register' + bind refs to shots for character consistency.`);
  }

  console.error(`  Generating frame for Shot ${shotNum} v${actualVersion}...`);
  console.error(`  Refs: ${refs.length} reference images`);
  console.error(`  Prompt: ${prompt.slice(0, 80)}...`);

  const nb2Config = getNB2Config();
  const defaults = getProjectDefaults();
  const outputPath = join(shotDir, "frame.png");

  const result = await generateImage(nb2Config, {
    prompt,
    refs: refs.length > 0 ? refs : undefined,
    aspectRatio: defaults.aspectRatio,
    imageSize: "2K",
  }, outputPath);

  // Store in DB
  const existingVersion = db.query(
    "SELECT id FROM versions WHERE shot_id = ? AND version_number = ?"
  ).get(shot.id, actualVersion) as any;

  if (existingVersion) {
    db.run(
      "UPDATE versions SET frame_prompt = ?, frame_path = ?, frame_generated_at = datetime('now') WHERE id = ?",
      [prompt, result.imagePath, existingVersion.id]
    );
  } else {
    db.run(
      "INSERT INTO versions (shot_id, version_number, frame_prompt, frame_path, frame_generated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      [shot.id, actualVersion, prompt, result.imagePath]
    );
  }

  // Update shot status
  db.run("UPDATE shots SET status = 'frame_generated' WHERE id = ?", [shot.id]);

  // Save prompt to file
  Bun.write(join(shotDir, "frame_prompt.txt"), prompt);

  db.close();

  success(`Frame generated: ${result.imagePath} (${result.sizeKb}KB)`, {
    episode: epNum,
    shot: shotNum,
    version: actualVersion,
    frame_path: result.imagePath,
    size_kb: result.sizeKb,
    status: "frame_generated",
    rule_warnings: ruleResults.filter(r => r.severity === "warning").map(r => r.message),
  });
}

// ================================================================
// film shot review-frame — Review frame with Gemini Pro
// ================================================================

async function reviewFrameCmd(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error("Usage: film shot review-frame <ep> <shot> [--intent <text>]");
    process.exit(1);
  }

  const intent = parseFlag(args, "--intent") ?? "Review this shot's first frame";

  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found.`); process.exit(1); }

  const latest = getLatestVersion(db, shot.id);
  if (!latest?.frame_path) { error("No frame generated yet. Run 'film shot generate-frame' first."); process.exit(1); }
  if (!existsSync(latest.frame_path)) { error(`Frame file not found: ${latest.frame_path}`); process.exit(1); }

  console.error(`  Reviewing frame for Shot ${shotNum} v${latest.version_number}...`);

  const geminiConfig = getGeminiConfig();
  const result = await geminiReviewFrame(
    geminiConfig,
    latest.frame_path,
    latest.frame_prompt ?? "",
    intent
  );

  // Store review in DB
  db.run(
    `INSERT INTO reviews (version_id, review_type, reviewer, model_used, score, review_text,
     one_fix, prompt_suggestions, decision_recommendation)
     VALUES (?, 'frame', 'gemini_pro', ?, ?, ?, ?, ?, ?)`,
    [
      latest.id,
      geminiConfig.model ?? "google/gemini-3.1-pro-preview",
      result.score,
      result.rawResponse,
      result.oneFix,
      result.promptFix,
      result.recommendation,
    ]
  );

  // Update shot status
  db.run("UPDATE shots SET status = 'frame_reviewed' WHERE id = ?", [shot.id]);

  // Save review to file
  const root = findProjectRoot()!;
  const reviewPath = latest.frame_path.replace("frame.png", "frame_review.md");
  Bun.write(reviewPath, result.rawResponse);

  db.close();

  success(`Frame reviewed: ${result.score}/10 — ${result.recommendation}`, {
    episode: epNum,
    shot: shotNum,
    version: latest.version_number,
    score: result.score,
    one_fix: result.oneFix,
    recommendation: result.recommendation,
    prompt_fix: result.promptFix,
    status: "frame_reviewed",
  });
}

// ================================================================
// film shot generate-video — Generate video via Kling omni
// ================================================================

async function generateVideoCmd(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error("Usage: film shot generate-video <ep> <shot> --prompt <text> | --prompt-file <path>");
    process.exit(1);
  }

  // Get prompt: from spec (auto-compose) > --prompt > --prompt-file
  let prompt = parseFlag(args, "--prompt") ?? "";
  const promptFile = parseFlag(args, "--prompt-file");
  if (promptFile) {
    if (!existsSync(promptFile)) { error(`File not found: ${promptFile}`); process.exit(1); }
    prompt = readFileSync(promptFile, "utf-8").trim();
  }

  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found.`); process.exit(1); }

  // Auto-compose from spec if no manual prompt
  if (!prompt && shot.spec_json) {
    const spec = JSON.parse(shot.spec_json) as ShotSpec;
    const proj = getProject(db);
    const vdna = JSON.parse(proj?.config_json ?? "{}").visual_dna ?? "";
    prompt = composeKlingPrompt(spec, vdna);
    console.error(`  Auto-composed Kling prompt from spec (${prompt.length} chars)`);
  }
  if (!prompt) { error("No prompt. Either set spec with 'film shot spec' or use --prompt/--prompt-file"); process.exit(1); }

  const latest = getLatestVersion(db, shot.id);
  if (!latest?.frame_path) {
    error("No accepted frame yet. Run 'film shot generate-frame' + 'film shot review-frame' first.");
    process.exit(1);
  }

  // Check frame was reviewed
  const frameReview = getLatestReview(db, latest.id, "frame");
  if (!frameReview && !args.includes("--force")) {
    error("Frame not reviewed yet. Run 'film shot review-frame' first, or use --force to skip.");
    process.exit(1);
  }
  if (frameReview && frameReview.score < 8 && !args.includes("--force")) {
    error(`Frame score ${frameReview.score}/10 < 8. Re-generate frame or use --force to proceed anyway.`);
    process.exit(1);
  }

  // Build image_list: first_frame + character refs
  const root = findProjectRoot()!;
  const imageList: { path: string; type?: "first_frame" }[] = [
    { path: latest.frame_path, type: "first_frame" },
  ];

  // Add character refs from shot config
  const project = getProject(db)!;
  try {
    const charRefIds = JSON.parse(shot.character_ref_ids_json ?? "[]");
    for (const refId of charRefIds) {
      const asset = db.query("SELECT file_path FROM assets WHERE id = ?").get(refId) as any;
      if (asset?.file_path) {
        const p = existsSync(join(root, asset.file_path))
          ? join(root, asset.file_path)
          : asset.file_path;
        if (existsSync(p)) imageList.push({ path: p });
      }
    }
  } catch {}

  // Additional refs from --ref
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--ref" && args[i + 1]) {
      imageList.push({ path: args[i + 1] });
      i += 2;
    } else {
      i++;
    }
  }

  // Parse voice_list from spec > --voice-ids > shot config
  let voiceList: { voice_id: string }[] = [];
  if (shot.spec_json) {
    const spec = JSON.parse(shot.spec_json) as ShotSpec;
    if (spec.dialogue?.length) {
      voiceList = spec.dialogue
        .filter(d => d.voice_id)
        .map(d => ({ voice_id: d.voice_id }));
      console.error(`  Voice list from spec: ${voiceList.length} voice(s)`);
    }
  }
  if (voiceList.length === 0) {
    const voiceIdsStr = parseFlag(args, "--voice-ids") ?? shot.voice_ids_json ?? "[]";
    try {
      const parsed = JSON.parse(voiceIdsStr);
      if (Array.isArray(parsed)) {
        voiceList = parsed.map((v: any) =>
          typeof v === "string" ? { voice_id: v } : v
        );
      }
    } catch {}
  }

  // Build Kling params for validation
  const defaults = getProjectDefaults();
  const klingParams = {
    model_name: parseFlag(args, "--model") ?? defaults.model,
    prompt,
    sound: parseFlag(args, "--sound") ?? "on",  // ALWAYS on — Kling generates ambient audio natively
    voice_list: voiceList,
    image_list: imageList.map(img => ({ type: img.type })),
    duration: parseFlag(args, "--duration") ?? String(defaults.duration),
  };

  // Validate rules
  const paramResults = validateKlingParams(klingParams);
  const promptResults = validateKlingPrompt(prompt);
  const allResults = [...paramResults, ...promptResults];

  if (allResults.length > 0) {
    console.error("  Rules check:");
    console.error(formatResults(allResults));
    if (hasErrors(allResults) && !args.includes("--force")) {
      error("Blocked by rule errors. Fix issues or use --force.");
      process.exit(1);
    }
  }

  // Validate prompt against spec (anti-laziness check)
  if (shot.spec_json) {
    const specForCheck = JSON.parse(shot.spec_json) as ShotSpec;
    const specCheck = validatePromptAgainstSpec(prompt, specForCheck, "kling");
    if (specCheck.length > 0) {
      console.error("  Spec compliance check (did you forget something?):");
      console.error(formatSpecErrors(specCheck));
    }
  }

  // Build output path
  const shotDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "shots",
    `shot${String(shotNum).padStart(2, "0")}`, `v${latest.version_number}`);
  const outputPath = join(shotDir, "video.mp4");

  console.error(`  Generating video for Shot ${shotNum} v${latest.version_number}...`);
  console.error(`  Model: ${klingParams.model_name} | Duration: ${klingParams.duration}s | Sound: ${klingParams.sound}`);
  console.error(`  Images: ${imageList.length} refs | Voices: ${voiceList.length}`);
  console.error(`  Prompt: ${prompt.slice(0, 80)}...`);

  const klingConfig = getKlingConfig();
  const result = await generateOmniVideo(
    klingConfig,
    {
      prompt,
      imageList,
      voiceList: voiceList.length > 0 ? voiceList : undefined,
      model: klingParams.model_name,
      duration: parseInt(klingParams.duration as string),
      aspectRatio: defaults.aspectRatio,
      sound: klingParams.sound as "on" | "off",
      mode: defaults.mode as "std" | "pro",
    },
    outputPath,
    (elapsed, status) => {
      process.stderr.write(`\r  [${Math.floor(elapsed/60)}m${(elapsed%60).toString().padStart(2,"0")}s] ${status}...`);
    }
  );

  if (!result) { error("Video generation failed."); process.exit(1); }

  // Store in DB
  db.run(
    `UPDATE versions SET kling_prompt = ?, video_path = ?, kling_task_id = ?,
     kling_params_json = ?, image_list_json = ?, video_generated_at = datetime('now')
     WHERE id = ?`,
    [
      prompt,
      result.videoPath,
      result.taskId,
      JSON.stringify(klingParams),
      JSON.stringify(imageList.map(img => ({ path: img.path, type: img.type }))),
      latest.id,
    ]
  );

  db.run("UPDATE shots SET status = 'video_generated' WHERE id = ?", [shot.id]);

  // Save prompt to file
  Bun.write(join(shotDir, "kling_prompt.txt"), prompt);

  db.close();

  console.error(""); // newline after progress
  success(`Video generated: ${result.videoPath} (${result.duration ?? "?"}s)`, {
    episode: epNum,
    shot: shotNum,
    version: latest.version_number,
    video_path: result.videoPath,
    task_id: result.taskId,
    duration: result.duration,
    status: "video_generated",
    rule_warnings: allResults.filter(r => r.severity === "warning").map(r => r.message),
  });
}

// ================================================================
// film shot review-video — Review video with Gemini Pro
// ================================================================

async function reviewVideoCmd(args: string[]) {
  const epNum = parseInt(args[0]);
  const shotNum = parseInt(args[1]);
  if (isNaN(epNum) || isNaN(shotNum)) {
    error("Usage: film shot review-video <ep> <shot> [--intent <text>]");
    process.exit(1);
  }

  const intent = parseFlag(args, "--intent") ?? `Review shot ${shotNum}`;

  const db = openDb();
  const shot = getShot(db, epNum, shotNum);
  if (!shot) { error(`Shot ${shotNum} not found.`); process.exit(1); }

  const latest = getLatestVersion(db, shot.id);
  if (!latest?.video_path) { error("No video generated yet."); process.exit(1); }
  if (!existsSync(latest.video_path)) { error(`Video not found: ${latest.video_path}`); process.exit(1); }

  console.error(`  Reviewing video for Shot ${shotNum} v${latest.version_number}...`);
  console.error(`  Including both frame prompt and Kling prompt for actionable feedback.`);

  const geminiConfig = getGeminiConfig();

  // CRITICAL: Include BOTH prompts for prompt-engineering feedback
  const result = await geminiReviewVideo(
    geminiConfig,
    latest.video_path,
    latest.frame_prompt ?? "",
    latest.kling_prompt ?? "",
    intent
  );

  // Store review
  db.run(
    `INSERT INTO reviews (version_id, review_type, reviewer, model_used, score, review_text,
     one_fix, prompt_suggestions, decision_recommendation)
     VALUES (?, 'video', 'gemini_pro', ?, ?, ?, ?, ?, ?)`,
    [
      latest.id,
      geminiConfig.model ?? "google/gemini-3.1-pro-preview",
      result.score,
      result.rawResponse,
      result.oneFix,
      result.promptFix,
      result.recommendation,
    ]
  );

  db.run("UPDATE shots SET status = 'video_reviewed' WHERE id = ?", [shot.id]);

  // Save review to file
  const reviewPath = latest.video_path.replace("video.mp4", "video_review.md");
  Bun.write(reviewPath, result.rawResponse);

  // Determine recommended action
  const versions = getVersions(db, shot.id);
  const rerollCount = versions.length - 1;
  const nextAction = getNextAction("video_reviewed" as ShotStatus, result.score, rerollCount);

  db.close();

  success(`Video reviewed: ${result.score}/10 — ${result.recommendation}`, {
    episode: epNum,
    shot: shotNum,
    version: latest.version_number,
    score: result.score,
    one_fix: result.oneFix,
    recommendation: result.recommendation,
    prompt_fix: result.promptFix,
    suggested_action: nextAction,
    iteration: versions.length,
    max_iterations: MAX_ITERATIONS,
    status: "video_reviewed",
  });
}

// shotAuto removed — Claude Code IS the director. No need for a separate LLM.
// The correct workflow is Claude Code driving individual commands:
//   film shot next 1 --json → know what to do
//   (Claude writes prompt) → film shot generate-frame 1 N --prompt "..."
//   film shot review-frame 1 N --json → read feedback
//   (Claude rewrites based on feedback) → film shot generate-frame again or proceed
//   (Claude writes kling prompt) → film shot generate-video 1 N --prompt "..."
//   film shot review-video 1 N --json → read feedback
//   film shot decide 1 N accept/reroll/restructure
//   film shot next 1 → move to next shot
//
// This is the CORRECT separation: CLI = execution + memory, Claude Code = brain.
