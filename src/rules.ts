/**
 * Production rules engine for film-cli.
 *
 * Validates prompts and API parameters against hard-won production rules
 * before making expensive API calls. Each rule prevented or fixed a specific
 * real production failure.
 */

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  severity: "error" | "warning" | "info";
  message: string;
  passed: boolean;
}

// --- Kling API parameter validation ---

export function validateKlingParams(params: {
  model_name?: string;
  sound?: string;
  voice_list?: any[];
  prompt?: string;
  image_list?: { type?: string }[];
}): RuleResult[] {
  const fails: RuleResult[] = [];

  // R001: Model must be kling-v3 or kling-v3-omni
  const model = params.model_name ?? "";
  if (!["kling-v3", "kling-v3-omni"].includes(model)) {
    fails.push({
      ruleId: "R001",
      ruleName: "model_version",
      severity: "error",
      message: `Model must be kling-v3 or kling-v3-omni, got '${model}'`,
      passed: false,
    });
  }

  // R002: sound must be "on" when voice_list present
  const voiceList = params.voice_list ?? [];
  if (voiceList.length > 0 && params.sound !== "on") {
    fails.push({
      ruleId: "R002",
      ruleName: "sound_with_voice",
      severity: "error",
      message: "sound must be 'on' when voice_list is present",
      passed: false,
    });
  }

  // R003: voice_list max 2
  if (voiceList.length > 2) {
    fails.push({
      ruleId: "R003",
      ruleName: "voice_list_max",
      severity: "error",
      message: `voice_list max 2 entries, got ${voiceList.length}`,
      passed: false,
    });
  }

  // R004: prompt max 2500 chars
  const prompt = params.prompt ?? "";
  if (prompt.length > 2500) {
    fails.push({
      ruleId: "R004",
      ruleName: "prompt_max_length",
      severity: "error",
      message: `Prompt is ${prompt.length} chars, max 2500`,
      passed: false,
    });
  }

  // R011: image_list must include refs beyond first_frame
  const imageList = params.image_list ?? [];
  const nonFirst = imageList.filter((i) => i.type !== "first_frame");
  if (imageList.length > 0 && nonFirst.length === 0) {
    fails.push({
      ruleId: "R011",
      ruleName: "omni_asset_refs",
      severity: "warning",
      message: "image_list has only first_frame — add character refs for consistency",
      passed: false,
    });
  }

  return fails;
}

// --- Kling prompt validation ---

export function validateKlingPrompt(prompt: string): RuleResult[] {
  const fails: RuleResult[] = [];
  const lower = prompt.toLowerCase();

  // R005: Three-layer motion check
  const cameraWords = ["push", "pull", "pan", "tilt", "dolly", "crane", "arc", "track", "lateral"];
  const subjectWords = ["eyes", "hand", "head", "shoulder", "jaw", "blink", "gesture", "turns", "leans", "shifts", "drops", "rises", "tightens"];
  const atmosWords = ["dust", "steam", "smoke", "motes", "particles", "curtain", "flicker", "sway", "drift"];

  if (!cameraWords.some((w) => lower.includes(w))) {
    fails.push({
      ruleId: "R005a",
      ruleName: "three_layer_camera",
      severity: "warning",
      message: "Missing camera movement layer (dolly/pan/push/tilt/crane/arc)",
      passed: false,
    });
  }
  if (!subjectWords.some((w) => lower.includes(w))) {
    fails.push({
      ruleId: "R005b",
      ruleName: "three_layer_subject",
      severity: "warning",
      message: "Missing subject motion layer (eyes/hand/head/gesture/turns/leans)",
      passed: false,
    });
  }
  if (!atmosWords.some((w) => lower.includes(w))) {
    fails.push({
      ruleId: "R005c",
      ruleName: "three_layer_atmosphere",
      severity: "warning",
      message: "Missing atmosphere motion layer (dust/steam/motes/particles)",
      passed: false,
    });
  }

  // R010: No freeze-trap words
  const freezeWords = [
    "static camera", "locked camera", "zero movement",
    "nearly motionless", "mostly still", "locked static",
  ];
  for (const fw of freezeWords) {
    if (lower.includes(fw)) {
      fails.push({
        ruleId: "R010",
        ruleName: "no_freeze_words",
        severity: "warning",
        message: `Freeze-trap word '${fw}' — causes Kling to freeze entire frame`,
        passed: false,
      });
    }
  }

  // R007: No <<<voice_N>>> token
  if (prompt.includes("<<<voice_")) {
    fails.push({
      ruleId: "R007",
      ruleName: "no_voice_token",
      severity: "error",
      message: "Found <<<voice_N>>> token — ignores voice_id. Use [Character: desc]: text instead",
      passed: false,
    });
  }

  return fails;
}

// --- Frame prompt validation ---

export function validateFramePrompt(prompt: string): RuleResult[] {
  const fails: RuleResult[] = [];
  const lower = prompt.toLowerCase();
  const firstLine = prompt.trim().split("\n")[0] ?? "";

  // R012: Must not start with a title line
  const titleStarts = ["CINEMATIC", "FROZEN FIRST FRAME", "Episode", "Shot "];
  for (const ts of titleStarts) {
    if (firstLine.toUpperCase().startsWith(ts.toUpperCase())) {
      fails.push({
        ruleId: "R012",
        ruleName: "no_title_line",
        severity: "warning",
        message: `Prompt starts with '${ts}...' — NB2 may render as on-screen text`,
        passed: false,
      });
      break;
    }
  }

  // R006: Check for frozen mid-motion
  const staticPatterns = ["sits looking at", "holds the ", "stands in ", "looking at camera", "standing still"];
  const motionPatterns = ["mid-turn", "frozen at the apex", "mid-motion", "mid-gesture", "mid-syllable", "halfway through", "mid-action"];

  const hasStatic = staticPatterns.some((p) => lower.includes(p));
  const hasMotion = motionPatterns.some((p) => lower.includes(p));

  if (hasStatic && !hasMotion) {
    fails.push({
      ruleId: "R006",
      ruleName: "frozen_mid_motion",
      severity: "warning",
      message: "Static pose without mid-motion language — produces stiff animation",
      passed: false,
    });
  }

  // Check for mandatory sections
  const sections: Record<string, string[]> = {
    SUBJECT: ["subject", "character", "person", "frozen"],
    COMPOSITION: ["framing", "composition", "angle", "placement"],
    CAMERA: ["camera", "lens", "aperture", "arri", "cooke"],
    LIGHTING: ["lighting", "key light", "fill", "rim", "practical"],
    COLOR: ["color", "grade", "palette", "saturation", "dehancer", "kodak"],
    ATMOSPHERE: ["atmosphere", "particles", "dust", "volumetric", "haze"],
  };

  for (const [name, keywords] of Object.entries(sections)) {
    if (!keywords.some((kw) => lower.includes(kw))) {
      fails.push({
        ruleId: `R_SEC_${name}`,
        ruleName: `missing_section_${name.toLowerCase()}`,
        severity: "info",
        message: `Prompt may be missing ${name} section`,
        passed: false,
      });
    }
  }

  return fails;
}

// --- Display helpers ---

export function formatResults(results: RuleResult[]): string {
  if (results.length === 0) return "  All rules passed.";
  return results
    .map((r) => {
      const icon = { error: "ERROR", warning: " WARN", info: " INFO" }[r.severity];
      return `  [${icon}] ${r.ruleId} ${r.ruleName}: ${r.message}`;
    })
    .join("\n");
}

export function hasErrors(results: RuleResult[]): boolean {
  return results.some((r) => r.severity === "error");
}
