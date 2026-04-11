/**
 * Image Quality Assessment — objective, algorithmic metrics.
 *
 * Uses pyiqa (Python) to compute deterministic scores:
 * - NIQE: naturalness (lower = more natural, real photos ~3-4, CG ~5+)
 * - MUSIQ: technical quality (higher = better, good frames ~45+)
 * - NIMA: aesthetics (higher = better, 1-10 scale)
 *
 * These are FIXED ALGORITHMS — same image always gives same score.
 * NOT LLM-based. NOT subjective. Quantifiable and reproducible.
 */

import { execSync } from "child_process";

export interface IQAScores {
  niqe: number;   // lower = more natural/real
  musiq: number;  // higher = better technical quality
  nima: number;   // higher = better aesthetics (1-10)
  verdict: "photorealistic" | "acceptable" | "cg_warning" | "poor";
}

export function assessImageQuality(imagePath: string): IQAScores {
  const script = `
import pyiqa, json, sys, warnings
warnings.filterwarnings('ignore')

path = '${imagePath.replace(/'/g, "\\'")}'
try:
    niqe = pyiqa.create_metric('niqe')
    musiq = pyiqa.create_metric('musiq')
    nima = pyiqa.create_metric('nima')
    n = niqe(path).item()
    m = musiq(path).item()
    a = nima(path).item()
    print(json.dumps({"niqe": round(n, 2), "musiq": round(m, 2), "nima": round(a, 2)}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

  try {
    const result = execSync(`python3 -c '${script.replace(/'/g, "'\"'\"'")}'`, {
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();

    // Find the JSON line (skip warnings)
    const lines = result.split("\n");
    const jsonLine = lines.find(l => l.startsWith("{"));
    if (!jsonLine) {
      return { niqe: 0, musiq: 0, nima: 0, verdict: "poor" };
    }

    const data = JSON.parse(jsonLine);
    if (data.error) {
      console.error(`  IQA error: ${data.error}`);
      return { niqe: 0, musiq: 0, nima: 0, verdict: "poor" };
    }

    // Determine verdict
    let verdict: IQAScores["verdict"] = "acceptable";
    if (data.niqe <= 4.0 && data.musiq >= 40) {
      verdict = "photorealistic";
    } else if (data.niqe > 5.0 || data.musiq < 30) {
      verdict = "cg_warning";
    } else if (data.niqe > 6.0 || data.musiq < 20) {
      verdict = "poor";
    }

    return { ...data, verdict };
  } catch (err: any) {
    console.error(`  IQA unavailable (install: pip install pyiqa)`);
    return { niqe: 0, musiq: 0, nima: 0, verdict: "acceptable" };
  }
}

export function formatIQA(scores: IQAScores): string {
  const verdictIcon = {
    photorealistic: "REAL",
    acceptable: " OK ",
    cg_warning: " CG!",
    poor: "POOR",
  }[scores.verdict];

  return [
    `  [${verdictIcon}] NIQE: ${scores.niqe} (natural<4, CG>5) | MUSIQ: ${scores.musiq} (good>40) | NIMA: ${scores.nima}/10`,
    scores.verdict === "cg_warning" ? "  WARNING: Image looks like CG/game render. Add film grain, wet surfaces, lens imperfections." : "",
    scores.verdict === "photorealistic" ? "  Photorealistic quality confirmed." : "",
  ].filter(Boolean).join("\n");
}
