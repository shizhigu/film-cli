/**
 * Shot Spec — structured input for every shot.
 *
 * This is the anti-laziness system. Every shot MUST have these elements
 * defined before generation. The CLI validates and rejects incomplete specs.
 *
 * Format: YAML file with required + optional fields.
 * The CLI auto-composes NB2 frame prompt and Kling prompt FROM the spec.
 * Claude Code fills the YAML, CLI validates nothing is missing.
 */

// ================================================================
// Spec schema
// ================================================================

export interface ShotSpec {
  // === REQUIRED for ALL shots ===
  subject: string;        // Who/what is in frame, what state they're in

  // Action MUST be decomposed into visual beats — not abstract descriptions.
  // BAD:  "vampire splits into two"
  // GOOD: "raises right hand palm-up → clenches fist, dark mist seeps between fingers →
  //        opens hand sharply, mist explodes outward in two streams →
  //        mist coalesces into two silhouettes on each side"
  action: string | string[];  // Single flowing description OR array of visual beats

  camera: {
    framing: "ECU" | "MCU" | "MS" | "MLS" | "WS";
    angle: string;        // "eye-level", "low 30°", "over-shoulder", etc.
    move: string;         // "slow push-in 5% over 5s" — REQUIRED, no static
  };
  lighting: string;       // Key light desc: direction, color temp, quality, fill ratio
  audio: {
    room_tone: string;    // "quiet kitchen, refrigerator hum, clock tick"
    sfx?: string;         // "paper crinkle at 3s, door slam at 7s"
  };
  avoid: string[];        // ["no smile", "no mouth opening without dialogue"]

  // === CONTINUITY — connecting shots ===
  // When this shot continues from a previous shot (same scene, continuous action),
  // set continues_from to use the previous shot's LAST FRAME as this shot's FIRST FRAME.
  // This ensures seamless transitions and avoids re-generating inconsistent frames.
  // Use cases:
  //   - Long action split across 2 shots (Kling 15s limit)
  //   - Scene continuation across angle changes
  //   - Reaction shots that follow the action shot
  continues_from?: number;  // Shot number whose last frame becomes this shot's first frame

  // === REQUIRED for DIALOGUE shots ===
  dialogue?: {
    character: string;
    voice_id: string;
    voice_desc: string;   // "35-year-old woman, controlled anger"
    chinese: string;      // Kling needs Chinese text
    english: string;      // For subtitles
  }[];

  // === REQUIRED for CHARACTER shots ===
  performance?: {
    character: string;
    facial: string;       // "brows furrow, jaw tightens, eyes narrow"
    body: string;         // "shoulders rise, grip tightens on paper"
    arc?: string;         // "casual → suspicious → anger"
  }[];

  // === AUDIO DESIGN (professional 7-layer structure) ===
  // Replaces the simple audio.room_tone + sfx with full professional layers.
  // At minimum: room_tone required. Others enhance production value.
  audio: {
    room_tone: string;    // REQUIRED. Location-specific silence: "quiet kitchen, fridge hum, clock tick"
    foley?: string;       // Reproduced physical sounds: "footsteps on wood, clothing rustle, chair creak"
    sfx?: string;         // Discrete sound effects: "glass shatter at 3s, thunder crack at 7s"
    walla?: string;       // Background voices/crowd: "muffled café conversations, distant laughter"
    ambience?: string;    // Environmental layers: "rain on window, distant traffic, wind through trees"
    music?: string;       // Music direction (NOT for Kling — post-production only): "tense strings swell, piano fades in"
  };
  avoid: string[];

  // === CONTINUITY & TRANSITIONS ===
  continues_from?: number;  // Shot number whose last frame = this shot's first frame

  // Transition INTO this shot from the previous shot.
  // Plan transitions during shot design, not in post.
  transition?: {
    type: "hard_cut" | "cross_dissolve" | "dip_to_black" | "match_cut" | "j_cut" | "l_cut" | "wipe" | "blur_cut";
    duration_frames?: number;  // Transition duration (default 12 for dissolves)
    // For J-cut: audio from THIS shot starts N frames before the visual cut
    // For L-cut: audio from PREVIOUS shot continues N frames into this shot
    audio_overlap_frames?: number;
    // For match_cut: what visual element matches between shots
    match_element?: string;  // "cup shape → doorknob shape" or "hand motion → wheel motion"
  };

  // === CAMERA (expanded) ===
  camera: {
    framing: "ECU" | "MCU" | "MS" | "MLS" | "WS";
    angle: string;
    move: string;         // REQUIRED — no static camera
    focus?: string;       // Focus pull: "rack focus from hands to face at 3s" or "deep focus throughout"
    lens?: string;        // Override project DNA: "anamorphic 40mm" or "macro 100mm"
  };

  // === LIGHTING (expanded) ===
  lighting: string;       // Key light description
  color_grade?: {
    lut?: string;         // "Kodak 2383" or "Fuji 3510" — override project DNA for this shot
    reference_shot?: number;  // Match color to this shot number
    mood_shift?: string;  // "warmer than previous" or "desaturate 20%"
  };

  // === VFX COMPLEXITY ===
  vfx?: {
    complexity: "none" | "low" | "medium" | "high";  // Flags shots needing special attention
    elements?: string[];  // ["blood mist particles", "clone duplication", "screen replacement"]
    notes?: string;       // "Kling will struggle with clone — may need post compositing"
  };

  // === REQUIRED for DIALOGUE shots ===
  dialogue?: {
    character: string;
    voice_id: string;
    voice_desc: string;
    chinese: string;
    english: string;
  }[];

  // === REQUIRED for CHARACTER shots ===
  performance?: {
    character: string;
    facial: string;
    body: string;
    arc?: string;
  }[];

  // === OTHER ===
  atmosphere?: string;
  style_ref?: string;
  duration?: number;      // 3-15 seconds
  notes?: string;
}

// ================================================================
// Validation — reject incomplete specs
// ================================================================

export interface SpecError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export function validateSpec(spec: ShotSpec, hasCharacters: boolean = true): SpecError[] {
  const errors: SpecError[] = [];

  // Required for ALL shots
  if (!spec.subject?.trim()) {
    errors.push({ field: "subject", message: "Missing: who/what is in the frame", severity: "error" });
  }

  // Action validation — must be decomposed into visual beats
  const actionText = Array.isArray(spec.action) ? spec.action.join(". ") : (spec.action ?? "");
  if (!actionText.trim()) {
    errors.push({ field: "action", message: "Missing: what physical action happens", severity: "error" });
  }
  if (!spec.camera?.move?.trim()) {
    errors.push({ field: "camera.move", message: "Missing: camera movement (no static camera!)", severity: "error" });
  }
  if (!spec.camera?.framing) {
    errors.push({ field: "camera.framing", message: "Missing: framing (ECU/MCU/MS/MLS/WS)", severity: "error" });
  }
  if (!spec.camera?.angle?.trim()) {
    errors.push({ field: "camera.angle", message: "Missing: camera angle", severity: "warning" });
  }
  if (!spec.lighting?.trim()) {
    errors.push({ field: "lighting", message: "Missing: lighting description", severity: "error" });
  }
  if (!spec.audio?.room_tone?.trim()) {
    errors.push({ field: "audio.room_tone", message: "Missing: room tone / ambient sound", severity: "error" });
  }
  if (!spec.avoid?.length) {
    errors.push({ field: "avoid", message: "Missing: avoid list (negative constraints)", severity: "warning" });
  }

  // Action QUALITY check — must be decomposed visual beats, not abstract
  if (actionText.trim()) {
    const actionLen = actionText.length;
    const hasBodyParts = /\b(hand|finger|arm|head|eye|jaw|shoulder|foot|leg|wrist|lip|brow|chin|torso|chest)\b/i.test(actionText);
    const hasVisualDetail = /\b(mist|glow|light|shadow|smoke|spark|blur|particle|flash|trail|shimmer|ripple|crack|shatter|spread|float|drift|rise|fall|pour|splash|explode|dissolve|fade|morph|coalesce|emerge)\b/i.test(actionText);
    const hasDirection = /\b(left|right|up|down|toward|away|forward|backward|outward|inward)\b/i.test(actionText);
    const clauseCount = actionText.split(/[,;.→\n]/).filter(s => s.trim().length > 5).length;

    if (actionLen < 50) {
      errors.push({ field: "action", message: `Action too short (${actionLen} chars). Decompose into visual beats with body parts + directions + visual effects.`, severity: "warning" });
    }
    if (clauseCount < 2) {
      errors.push({ field: "action", message: "Action needs multiple visual beats (use commas, arrows →, or array format). One sentence = one abstract idea = lazy.", severity: "warning" });
    }
    if (!hasBodyParts && hasCharacters) {
      errors.push({ field: "action", message: "Action missing body part specifics (hand/eye/jaw/shoulder...). Which body part does what?", severity: "warning" });
    }
    if (!hasDirection) {
      errors.push({ field: "action", message: "Action missing spatial direction (left/right/toward/up/down). Where does the movement go?", severity: "info" });
    }
  }

  // Camera move anti-patterns
  const moveLower = (spec.camera?.move ?? "").toLowerCase();
  if (moveLower.includes("static") || moveLower.includes("locked") || moveLower.includes("no movement")) {
    errors.push({ field: "camera.move", message: "BLOCKED: 'static/locked camera' freezes Kling output. Must have real movement.", severity: "error" });
  }

  // Dialogue validation
  if (spec.dialogue?.length) {
    for (let i = 0; i < spec.dialogue.length; i++) {
      const d = spec.dialogue[i];
      if (!d.voice_id?.trim()) {
        errors.push({ field: `dialogue[${i}].voice_id`, message: `Missing voice_id for ${d.character}`, severity: "error" });
      }
      if (!d.chinese?.trim()) {
        errors.push({ field: `dialogue[${i}].chinese`, message: `Missing Chinese text for ${d.character} (Kling needs Chinese)`, severity: "error" });
      }
      if (!d.english?.trim()) {
        errors.push({ field: `dialogue[${i}].english`, message: `Missing English translation for subtitle`, severity: "warning" });
      }
      if (!d.voice_desc?.trim()) {
        errors.push({ field: `dialogue[${i}].voice_desc`, message: `Missing voice description for ${d.character}`, severity: "warning" });
      }
    }
    if (spec.dialogue.length > 2) {
      errors.push({ field: "dialogue", message: "Max 2 voices per shot (Kling API limit). Split into separate shots.", severity: "error" });
    }
  }

  // Performance validation for character shots
  if (hasCharacters && !spec.performance?.length) {
    errors.push({ field: "performance", message: "Missing: character performance direction (facial + body micro-actions)", severity: "warning" });
  }
  if (spec.performance?.length) {
    for (let i = 0; i < spec.performance.length; i++) {
      const p = spec.performance[i];
      if (!p.facial?.trim()) {
        errors.push({ field: `performance[${i}].facial`, message: `Missing facial micro-actions for ${p.character}. Use specifics: 'jaw tightens, eyes narrow', NOT 'sad expression'`, severity: "warning" });
      }
      if (!p.body?.trim()) {
        errors.push({ field: `performance[${i}].body`, message: `Missing body action for ${p.character}. Avoid interview-style stillness.`, severity: "warning" });
      }
    }
  }

  // Action quality check — no vague descriptions
  const actionLower = actionText.toLowerCase();
  const vagueActions = ["stands there", "sits quietly", "looks at", "stands in"];
  for (const va of vagueActions) {
    if (actionLower.includes(va)) {
      errors.push({ field: "action", message: `Vague action '${va}' — be specific about physical movement`, severity: "warning" });
    }
  }

  // Transition validation
  if (spec.transition) {
    if (spec.transition.type === "match_cut" && !spec.transition.match_element) {
      errors.push({ field: "transition.match_element", message: "Match cut needs match_element: what visual element connects the shots?", severity: "warning" });
    }
    if ((spec.transition.type === "j_cut" || spec.transition.type === "l_cut") && !spec.transition.audio_overlap_frames) {
      errors.push({ field: "transition.audio_overlap_frames", message: `${spec.transition.type} needs audio_overlap_frames: how many frames of audio overlap?`, severity: "warning" });
    }
  }

  // VFX complexity advisory
  if (spec.vfx?.complexity === "high") {
    errors.push({ field: "vfx", message: `High VFX complexity: ${spec.vfx.elements?.join(", ")}. Kling may struggle — plan for restructure or post-compositing.`, severity: "info" });
  }

  // Audio completeness — more layers = richer production
  if (spec.dialogue?.length && !spec.audio.foley) {
    errors.push({ field: "audio.foley", message: "Dialogue shot missing foley layer (clothing rustle, footsteps). Adds realism.", severity: "info" });
  }
  if (!spec.audio.ambience && !spec.audio.walla) {
    errors.push({ field: "audio.ambience", message: "No ambience or walla layer specified. Scenes feel empty without environmental depth.", severity: "info" });
  }

  // Focus pull planning
  if (spec.camera?.focus) {
    const focusLower = spec.camera.focus.toLowerCase();
    if (focusLower.includes("rack") && !focusLower.includes("to ") && !focusLower.includes("from ")) {
      errors.push({ field: "camera.focus", message: "Rack focus needs 'from X to Y' — what pulls to what?", severity: "warning" });
    }
  }

  return errors;
}

// ================================================================
// Prompt composition — build prompts FROM spec fields
// ================================================================

export function composeFramePrompt(spec: ShotSpec, visualDna?: string): string {
  const parts: string[] = [];
  const actionText = Array.isArray(spec.action) ? spec.action.join(". ") : spec.action;

  // If continues_from, note it
  if (spec.continues_from) {
    parts.push(`[Continuation from shot ${spec.continues_from} — first frame extracted from previous shot's last frame]\n`);
  }

  // Subject (frozen mid-motion) — use first beat of action for the frozen moment
  const firstBeat = Array.isArray(spec.action) ? spec.action[0] : spec.action;
  parts.push(spec.subject + ". Frozen mid-action: " + firstBeat);

  // Composition
  parts.push(`\n${spec.camera.framing} framing, ${spec.camera.angle ?? "eye-level"}.`);

  // Camera + lens from visual DNA or defaults
  if (visualDna) {
    // Extract lens info based on framing
    const lensMap: Record<string, string> = {
      ECU: "100mm macro, f/2.8",
      MCU: "50mm, f/2.0",
      MS: "32mm, f/2.8",
      MLS: "25mm, f/2.8",
      WS: "25mm, f/4",
    };
    parts.push(`\nARRI Alexa Mini LF, Cooke S4/i ${lensMap[spec.camera.framing] ?? "50mm, f/2.0"}.`);
  }

  // Lighting
  parts.push(`\n${spec.lighting}`);

  // Atmosphere
  if (spec.atmosphere) {
    parts.push(`\n${spec.atmosphere}`);
  }

  // Style reference
  if (spec.style_ref) {
    parts.push(`\n${spec.style_ref}. 35mm grain.`);
  }

  // Performance direction in frame description
  if (spec.performance?.length) {
    const perfDesc = spec.performance
      .map(p => `${p.character}: ${p.facial}`)
      .join(". ");
    parts.push(`\nExpression: ${perfDesc}`);
  }

  // Avoid
  if (spec.avoid?.length) {
    parts.push(`\n${spec.avoid.join(", ")}`);
  }

  return parts.join("");
}

export function composeKlingPrompt(spec: ShotSpec, visualDna?: string): string {
  const parts: string[] = [];
  const maxChars = 2500;

  // Image references
  parts.push("<<<image_1>>> establishes the scene.");

  // Camera movement
  parts.push(`\n${spec.camera.move}.`);

  // Action / subject motion (all beats as flowing description)
  const actionForKling = Array.isArray(spec.action) ? spec.action.join(". ") : spec.action;
  parts.push(`\n${actionForKling}`);

  // Performance direction
  if (spec.performance?.length) {
    for (const p of spec.performance) {
      parts.push(`\n${p.character}: ${p.facial}. ${p.body}.`);
    }
  }

  // Atmosphere
  if (spec.atmosphere) {
    parts.push(`\n${spec.atmosphere}`);
  }

  // Dialogue (Kling inline syntax)
  if (spec.dialogue?.length) {
    parts.push("");
    for (const d of spec.dialogue) {
      parts.push(`[${d.character}: ${d.voice_desc}]: ${d.chinese}`);
    }
  }

  // Audio environment (all available layers)
  parts.push(`\nRoom tone: ${spec.audio.room_tone}.`);
  if (spec.audio.foley) parts.push(`Foley: ${spec.audio.foley}.`);
  if (spec.audio.sfx) parts.push(`SFX: ${spec.audio.sfx}.`);
  if (spec.audio.walla) parts.push(`Background voices: ${spec.audio.walla}.`);
  if (spec.audio.ambience) parts.push(`Ambience: ${spec.audio.ambience}.`);
  parts.push("No music."); // Music is post-production only, never in Kling prompt

  // Avoid
  if (spec.avoid?.length) {
    parts.push(`\n${spec.avoid.join(", ")}`);
  }

  // Truncate if over 2500
  let result = parts.join(" ").trim();
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 3) + "...";
  }

  return result;
}

// ================================================================
// YAML parsing (simple, no external dependency)
// ================================================================

export function parseSpecYaml(content: string): ShotSpec {
  /**
   * Simple YAML parser for shot specs.
   * Handles: top-level key:value, nested objects, array items with sub-fields.
   */
  const lines = content.split("\n");
  const result: any = {};

  let topKey = ""; // current top-level key (e.g., "dialogue", "camera")
  let inArray = false; // whether topKey is an array
  let currentObj: any = null; // current array item being built

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, ""); // strip comments
    if (!line.trim()) continue;

    const indent = rawLine.search(/\S/);
    const trimmed = line.trim();

    // Array item start: "  - key: value"
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      const kvMatch = rest.match(/^([\w_]+)\s*:\s*(.*)$/);

      if (kvMatch) {
        // Flush previous array object
        if (currentObj && topKey) {
          if (!result[topKey]) result[topKey] = [];
          result[topKey].push(currentObj);
        }
        // Start new object
        currentObj = {};
        inArray = true;
        currentObj[kvMatch[1]] = kvMatch[2].trim().replace(/^["']|["']$/g, "");
      } else {
        // Simple string array item: "  - no smile"
        if (!result[topKey]) result[topKey] = [];
        result[topKey].push(rest.replace(/^["']|["']$/g, ""));
      }
      continue;
    }

    // Key: value
    const kvMatch = trimmed.match(/^([\w_]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const val = kvMatch[2].trim().replace(/^["']|["']$/g, "");

    if (indent === 0) {
      // Flush any pending array object
      if (currentObj && topKey) {
        if (!result[topKey]) result[topKey] = [];
        result[topKey].push(currentObj);
        currentObj = null;
      }
      inArray = false;

      if (val) {
        result[key] = val;
        topKey = "";
      } else {
        topKey = key;
      }
    } else if (indent >= 4 && currentObj && inArray) {
      // Sub-field of array object item (indent 4+)
      currentObj[key] = val;
    } else if (indent >= 2 && topKey && !inArray) {
      // Nested object field (indent 2)
      if (!result[topKey]) result[topKey] = {};
      result[topKey][key] = val;
    }
  }

  // Flush final array object
  if (currentObj && topKey) {
    if (!result[topKey]) result[topKey] = [];
    result[topKey].push(currentObj);
  }

  return result as ShotSpec;
}

export function formatSpecErrors(errors: SpecError[]): string {
  if (errors.length === 0) return "  Spec valid.";
  return errors
    .map(e => {
      const icon = e.severity === "error" ? "ERROR" : " WARN";
      return `  [${icon}] ${e.field}: ${e.message}`;
    })
    .join("\n");
}

export function hasSpecErrors(errors: SpecError[]): boolean {
  return errors.some(e => e.severity === "error");
}

// ================================================================
// Prompt-vs-Spec validation — THE ANTI-LAZINESS CHECK
//
// Claude Code writes the prompt. This function checks whether the
// prompt actually covers what the spec defined. It doesn't check
// prompt quality — just that nothing was forgotten.
// ================================================================

export function validatePromptAgainstSpec(
  prompt: string,
  spec: ShotSpec,
  promptType: "frame" | "kling"
): SpecError[] {
  const errors: SpecError[] = [];
  const lower = prompt.toLowerCase();

  // --- Camera movement (most commonly forgotten) ---
  if (spec.camera?.move) {
    const moveKeywords = spec.camera.move.toLowerCase().split(/[\s,]+/)
      .filter(w => ["push", "pull", "pan", "tilt", "crane", "arc", "dolly", "track", "lateral", "orbit"].includes(w));
    const hasAnyMoveWord = moveKeywords.some(w => lower.includes(w))
      || /\d+%/.test(prompt); // percentage = likely has movement spec
    if (!hasAnyMoveWord) {
      errors.push({
        field: "camera.move",
        message: `Spec says "${spec.camera.move}" but your prompt has no camera movement keywords. Did you forget to write the camera move?`,
        severity: "warning",
      });
    }
  }

  // --- Dialogue (critical for Kling prompt) ---
  if (promptType === "kling" && spec.dialogue?.length) {
    for (const d of spec.dialogue) {
      if (d.chinese && !prompt.includes(d.chinese)) {
        errors.push({
          field: "dialogue",
          message: `Spec has dialogue "${d.chinese}" (${d.english}) but it's not in your Kling prompt. Dialogue must use inline [Character: desc]: 中文 syntax.`,
          severity: "error",
        });
      }
    }
  }

  // --- Audio / sound design ---
  if (promptType === "kling") {
    const hasAudioWords = /\b(room tone|ambient|hum|buzz|wind|silence|creak|rustle|footstep|click|slam|whoosh|thunder|rain)\b/i.test(prompt);
    if (!hasAudioWords && spec.audio?.room_tone) {
      errors.push({
        field: "audio",
        message: `Spec defines audio (${spec.audio.room_tone.slice(0, 40)}...) but your prompt has no sound description. Kling generates better audio when guided.`,
        severity: "warning",
      });
    }
  }

  // --- Lighting ---
  if (spec.lighting) {
    const hasLightWords = /\b(light|lamp|sun|glow|shadow|backlight|rim|fill|warm|cool|golden|fluorescent|pendant|window)\b/i.test(prompt);
    if (!hasLightWords) {
      errors.push({
        field: "lighting",
        message: `Spec defines lighting ("${spec.lighting.slice(0, 40)}...") but your prompt has no lighting description.`,
        severity: "warning",
      });
    }
  }

  // --- Performance / action ---
  if (spec.performance?.length && promptType === "kling") {
    const hasPerformanceWords = /\b(brow|jaw|eye|shoulder|hand|arm|fist|finger|lean|shift|clench|tighten|narrow|widen|nod|shrug|gesture)\b/i.test(prompt);
    if (!hasPerformanceWords) {
      errors.push({
        field: "performance",
        message: "Spec has performance direction but your prompt has no body/facial micro-action words. Characters will be stiff.",
        severity: "warning",
      });
    }
  }

  // --- Film texture / photorealism (THE KEY MISSING PIECE) ---
  if (promptType === "frame") {
    const hasFilmTexture = /\b(film|grain|35mm|kodak|portra|vision3|fuji|lens flare|bokeh|shallow focus|depth of field|handheld|wet|rain|dirt|scratch|sweat|grime|practical effect)\b/i.test(prompt);
    if (!hasFilmTexture) {
      errors.push({
        field: "style",
        message: "Your prompt has NO film texture words (grain/35mm/kodak/lens flare/wet/dirt). This will look like CG/game, not cinema. Add photorealism anchors!",
        severity: "warning",
      });
    }
  }

  // --- Style anchor (specific film reference) ---
  const hasStyleRef = /\b(deakins|villeneuve|nolan|fincher|lubezki|spielberg|malick|scorsese|tarantino|wachowski|blade runner|sicario|arrival|avengers|endgame|inception|matrix|dark knight)\b/i.test(prompt);
  if (!hasStyleRef && spec.style_ref) {
    errors.push({
      field: "style_ref",
      message: `Spec references "${spec.style_ref}" but your prompt has no specific film/director anchor. Vague = generic output.`,
      severity: "info",
    });
  }

  // --- Framing mentioned ---
  if (spec.camera?.framing) {
    const framingWords: Record<string, string[]> = {
      ECU: ["extreme close", "ecu", "macro", "tight on"],
      MCU: ["medium close", "mcu", "chest up", "face and shoulders"],
      MS: ["medium shot", "waist up"],
      MLS: ["medium long", "knees up"],
      WS: ["wide shot", "wide angle", "full body", "establishing"],
    };
    const keywords = framingWords[spec.camera.framing] ?? [];
    if (keywords.length > 0 && !keywords.some(k => lower.includes(k))) {
      errors.push({
        field: "camera.framing",
        message: `Spec says ${spec.camera.framing} but your prompt doesn't mention the framing. The model might compose it wrong.`,
        severity: "info",
      });
    }
  }

  return errors;
}
