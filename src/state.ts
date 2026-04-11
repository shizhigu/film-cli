/**
 * Shot state machine for film-cli.
 */

export const MAX_ITERATIONS = 6;

export type ShotStatus =
  | "planned"
  | "frame_generating"
  | "frame_generated"
  | "frame_reviewed"
  | "video_generating"
  | "video_generated"
  | "video_reviewed"
  | "accepted"
  | "rerolled"
  | "restructured"
  | "structural_failure";

/** Valid state transitions */
const TRANSITIONS: Record<ShotStatus, ShotStatus[]> = {
  planned: ["frame_generating"],
  frame_generating: ["frame_generated", "planned"],
  frame_generated: ["frame_reviewed"],
  frame_reviewed: ["frame_generating", "video_generating"],
  video_generating: ["video_generated", "frame_reviewed"],
  video_generated: ["video_reviewed"],
  video_reviewed: ["accepted", "rerolled", "restructured"],
  rerolled: ["planned"],
  restructured: ["planned"],
  accepted: [],
  structural_failure: [],
};

export class InvalidTransition extends Error {
  constructor(from: ShotStatus, to: ShotStatus) {
    const allowed = TRANSITIONS[from] || [];
    super(
      `Cannot transition from '${from}' to '${to}'. Allowed: [${allowed.join(", ")}]`
    );
  }
}

export function validateTransition(from: ShotStatus, to: ShotStatus): void {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new InvalidTransition(from, to);
  }
}

export function isTerminal(status: ShotStatus): boolean {
  return status === "accepted" || status === "structural_failure";
}

export type NextAction =
  | "generate_frame"
  | "review_frame"
  | "generate_video"
  | "review_video"
  | "accept"
  | "reroll"
  | "restructure"
  | "structural_failure"
  | "done";

/** Suggest next action based on shot state and review score */
export function getNextAction(
  status: ShotStatus,
  score: number | null,
  rerollCount: number
): NextAction {
  switch (status) {
    case "planned":
    case "rerolled":
    case "restructured":
      return "generate_frame";
    case "frame_generated":
      return "review_frame";
    case "frame_reviewed":
      return score !== null && score >= 8 ? "generate_video" : "generate_frame";
    case "video_generated":
      return "review_video";
    case "video_reviewed":
      if (score === null) return "review_video";
      if (score >= 8) return "accept";
      if (score >= 7 && rerollCount < 3) return "reroll";
      if (rerollCount >= MAX_ITERATIONS - 1) return "structural_failure";
      return "restructure";
    case "accepted":
      return "done";
    default:
      return "generate_frame";
  }
}
