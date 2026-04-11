/**
 * film assemble — Build final cuts from accepted shots.
 *
 * Supports two engines:
 * 1. Remotion (default): generates a complete React project with transitions + subtitles
 * 2. FFmpeg (fallback): simple concat with optional dip-to-black transitions
 *
 * Post-processing:
 * - Audio normalization: loudnorm with pre-boost (Kling generates quiet audio)
 * - Re-encoding for platform compatibility (H264 High Profile + yuv420p + faststart)
 */

import { openDb, getProject, getEpisode, getShots, getLatestVersion, findProjectRoot } from "../db";
import { success, error, emit } from "../output";
import { reviewAssembly } from "../integrations/gemini";
import { getGeminiConfig } from "../integrations/config";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const HELP = `
film assemble — Build final cuts from accepted shots.

Subcommands:
  rough-cut <ep>               FFmpeg concat of accepted shots (fast, basic)
  remotion <ep>                Generate Remotion project with transitions + subtitles
  render <ep>                  Render Remotion project to final video
  review <ep>                  Send assembly to Gemini Pro for full-film review

Options:
  --transitions <file.json>    Transition config (type + duration per cut)
  --subtitles <file.json>      Subtitle data (start, end, text, speaker)
  --output <path>              Custom output path

Post-processing (automatic):
  - Audio: +4dB pre-boost → loudnorm (I=-12:LRA=7:TP=-1) — Kling audio is quiet
  - Video: H264 High Profile + yuv420p + faststart for macOS/YouTube compatibility

Assembly tip:
  For professional results, use 'remotion' engine (cross-dissolve, blur-cut,
  dip-to-black transitions + per-speaker subtitle styling). For quick previews,
  use 'rough-cut' (ffmpeg concat, hard cuts only).
`;

export async function assembleCmd(args: string[]) {
  if (args.length === 0 || args[0] === "--help") {
    console.log(HELP);
    return;
  }

  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "rough-cut":
      await roughCut(rest);
      break;
    case "remotion":
      await generateRemotion(rest);
      break;
    case "render":
      await renderRemotion(rest);
      break;
    case "review":
      await reviewAssemblyCmd(rest);
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

// ================================================================
// Rough Cut — FFmpeg concat with optional transitions
// ================================================================

async function roughCut(args: string[]) {
  const epNum = parseInt(args[0]);
  if (isNaN(epNum)) { error("Usage: film assemble rough-cut <episode>"); process.exit(1); }

  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  const root = findProjectRoot()!;
  const shots = getShots(db, ep.id, "accepted");
  if (shots.length === 0) { error("No accepted shots. Run production first."); process.exit(1); }

  // Collect accepted video paths
  const videoPaths: { number: number; path: string }[] = [];
  for (const shot of shots) {
    const version = getLatestVersion(db, shot.id);
    if (version?.video_path && existsSync(version.video_path)) {
      videoPaths.push({ number: shot.number, path: version.video_path });
    }
  }

  if (videoPaths.length === 0) { error("No video files found for accepted shots."); process.exit(1); }

  // Create concat file
  const assemblyDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "assembly");
  mkdirSync(assemblyDir, { recursive: true });

  const concatFile = join(assemblyDir, "concat.txt");
  const concatContent = videoPaths.map(v => `file '${v.path}'`).join("\n");
  writeFileSync(concatFile, concatContent);

  const rawOutput = join(assemblyDir, "rough_cut_raw.mp4");
  const finalOutput = parseFlag(args, "--output") ?? join(assemblyDir, "rough_cut.mp4");

  console.error(`  Concatenating ${videoPaths.length} shots...`);

  // Concat with ffmpeg
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${rawOutput}"`,
    { timeout: 120_000, stdio: "pipe" }
  );

  // Post-process: audio normalization + re-encode
  console.error("  Post-processing: audio normalization + re-encoding...");
  execSync(
    `ffmpeg -y -i "${rawOutput}" ` +
    `-af "volume=4dB,loudnorm=I=-12:LRA=7:TP=-1" ` +
    `-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset medium ` +
    `-c:a aac -b:a 192k -movflags +faststart "${finalOutput}"`,
    { timeout: 300_000, stdio: "pipe" }
  );

  // Record in DB
  db.run(
    `INSERT INTO assemblies (episode_id, type, shot_order_json, output_path)
     VALUES (?, 'rough_cut', ?, ?)`,
    [ep.id, JSON.stringify(videoPaths.map(v => v.number)), finalOutput]
  );

  db.close();

  success(`Rough cut assembled: ${finalOutput} (${videoPaths.length} shots)`, {
    episode: epNum,
    shots: videoPaths.length,
    output: finalOutput,
  });
}

// ================================================================
// Remotion — Generate complete React project
// ================================================================

async function generateRemotion(args: string[]) {
  const epNum = parseInt(args[0]);
  if (isNaN(epNum)) { error("Usage: film assemble remotion <episode>"); process.exit(1); }

  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  const root = findProjectRoot()!;
  const shots = getShots(db, ep.id, "accepted");
  if (shots.length === 0) { error("No accepted shots."); process.exit(1); }

  // Load transition config if provided
  const transFile = parseFlag(args, "--transitions");
  let transitions: (null | { type: string; durationFrames: number })[] = [];
  if (transFile && existsSync(transFile)) {
    transitions = JSON.parse(Bun.file(transFile).text() as any);
  }

  // Load subtitle data if provided
  const subFile = parseFlag(args, "--subtitles");
  let subtitles: { start: number; end: number; text: string; speaker?: string }[] = [];
  if (subFile && existsSync(subFile)) {
    subtitles = JSON.parse(Bun.file(subFile).text() as any);
  }

  // Collect shot data
  const shotData: { file: string; dur: number; number: number }[] = [];
  for (const shot of shots) {
    const version = getLatestVersion(db, shot.id);
    if (version?.video_path && existsSync(version.video_path)) {
      // Get duration from ffprobe
      let dur = shot.duration_target ?? 5;
      try {
        const probe = execSync(
          `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${version.video_path}"`,
          { timeout: 10_000 }
        ).toString().trim();
        dur = parseFloat(probe) || dur;
      } catch {}

      shotData.push({
        file: `shot${String(shot.number).padStart(2, "0")}.mp4`,
        dur,
        number: shot.number,
      });
    }
  }

  // Generate Remotion project
  const remotionDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "remotion");
  mkdirSync(join(remotionDir, "src"), { recursive: true });
  mkdirSync(join(remotionDir, "public"), { recursive: true });

  // Copy video files to public/
  for (const shot of shots) {
    const version = getLatestVersion(db, shot.id);
    if (version?.video_path && existsSync(version.video_path)) {
      const dest = join(remotionDir, "public", `shot${String(shot.number).padStart(2, "0")}.mp4`);
      execSync(`cp "${version.video_path}" "${dest}"`, { stdio: "pipe" });
    }
  }

  // Calculate total duration
  const FPS = 24;
  const totalFrames = Math.round(
    shotData.reduce((sum, s) => sum + s.dur, 0) * FPS
  );

  // Write package.json
  writeFileSync(join(remotionDir, "package.json"), JSON.stringify({
    name: `ep${String(epNum).padStart(2, "0")}-assembly`,
    type: "module",
    private: true,
    scripts: {
      preview: "remotion studio src/index.ts",
      render: `remotion render src/index.ts FinalCut --codec h264 --output out/final_cut.mp4`,
    },
    dependencies: {
      remotion: "^4.0.447",
      "@remotion/cli": "^4.0.447",
      "@remotion/transitions": "^4.0.447",
      react: "^19.2.5",
      "react-dom": "^19.2.5",
    },
    devDependencies: {
      "@types/react": "^19.2.14",
      typescript: "^5",
    },
  }, null, 2));

  // Write tsconfig.json
  writeFileSync(join(remotionDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2018",
      module: "commonjs",
      jsx: "react-jsx",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src/**/*"],
  }, null, 2));

  // Write src/index.ts
  writeFileSync(join(remotionDir, "src", "index.ts"),
    `import {registerRoot} from 'remotion';\nimport {RemotionRoot} from './Root';\nregisterRoot(RemotionRoot);\n`
  );

  // Write src/Root.tsx
  writeFileSync(join(remotionDir, "src", "Root.tsx"),
    `import React from 'react';
import {Composition} from 'remotion';
import {FinalCut} from './FinalCut';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="FinalCut"
    component={FinalCut}
    durationInFrames={${totalFrames}}
    fps={${FPS}}
    width={1284}
    height={716}
  />
);
`);

  // Write src/FinalCut.tsx with shots + transitions
  const shotsJson = JSON.stringify(shotData, null, 2);
  const transitionsJson = JSON.stringify(transitions, null, 2);
  const subtitlesJson = JSON.stringify(subtitles, null, 2);

  writeFileSync(join(remotionDir, "src", "FinalCut.tsx"),
    `import React from 'react';
import {AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, interpolate, Easing} from 'remotion';
import {TransitionSeries, linearTiming} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';

const FPS = ${FPS};
const shots = ${shotsJson};
const transitions: (null | {type: string; durationFrames: number})[] = ${transitionsJson};
const subtitles = ${subtitlesJson};

const ShotClip: React.FC<{src: string}> = ({src}) => (
  <AbsoluteFill>
    <OffthreadVideo src={staticFile(src)} style={{width:'100%',height:'100%',objectFit:'cover'}} />
  </AbsoluteFill>
);

const SubtitleOverlay: React.FC = () => {
  const frame = useCurrentFrame();
  const active = subtitles.filter((s: any) => frame >= s.start && frame <= s.end);
  return (
    <AbsoluteFill style={{justifyContent:'flex-end',alignItems:'center',paddingBottom:48}}>
      {active.map((s: any, i: number) => {
        const opacity = interpolate(frame, [s.start, s.start+4, s.end-4, s.end], [0,1,1,0],
          {extrapolateLeft:'clamp',extrapolateRight:'clamp'});
        if (opacity <= 0) return null;
        return (
          <div key={i} style={{
            opacity, fontFamily:'system-ui', fontSize:26, fontWeight:500,
            padding:'8px 24px', borderRadius:6, backgroundColor:'rgba(0,0,0,0.55)',
            color:'#fff', textShadow:'0 1px 4px rgba(0,0,0,0.6)',
            maxWidth:'80%', textAlign:'center', lineHeight:1.4,
          }}>{s.text}</div>
        );
      })}
    </AbsoluteFill>
  );
};

export const FinalCut: React.FC = () => {
  const elements: React.ReactNode[] = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    elements.push(
      <TransitionSeries.Sequence key={\`s\${i}\`} durationInFrames={Math.round(s.dur * FPS)}>
        <ShotClip src={s.file} />
      </TransitionSeries.Sequence>
    );
    if (i < transitions.length && transitions[i] !== null) {
      const t = transitions[i]!;
      elements.push(
        <TransitionSeries.Transition key={\`t\${i}\`}
          presentation={fade()}
          timing={linearTiming({durationInFrames: t.durationFrames})}
        />
      );
    }
  }
  return (
    <AbsoluteFill style={{backgroundColor:'black'}}>
      <TransitionSeries>{elements}</TransitionSeries>
      <SubtitleOverlay />
    </AbsoluteFill>
  );
};
`);

  // Record in DB
  db.run(
    `INSERT INTO assemblies (episode_id, type, shot_order_json, transitions_json, subtitles_json, output_path)
     VALUES (?, 'fine_cut', ?, ?, ?, ?)`,
    [ep.id, JSON.stringify(shotData.map(s => s.number)), JSON.stringify(transitions),
     JSON.stringify(subtitles), join(remotionDir, "out", "final_cut.mp4")]
  );

  db.close();

  success(`Remotion project generated at ${remotionDir}`, {
    episode: epNum,
    shots: shotData.length,
    remotion_dir: remotionDir,
    next_steps: [
      `cd ${remotionDir} && bun install`,
      `bun run preview  # preview in browser`,
      `film assemble render ${epNum}  # render final video`,
    ],
  });
}

// ================================================================
// Render — Render Remotion project
// ================================================================

async function renderRemotion(args: string[]) {
  const epNum = parseInt(args[0]);
  if (isNaN(epNum)) { error("Usage: film assemble render <episode>"); process.exit(1); }

  const root = findProjectRoot()!;
  const remotionDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "remotion");
  if (!existsSync(remotionDir)) {
    error(`Remotion project not found. Run 'film assemble remotion ${epNum}' first.`);
    process.exit(1);
  }

  // Install deps if needed
  if (!existsSync(join(remotionDir, "node_modules"))) {
    console.error("  Installing Remotion dependencies...");
    execSync("bun install", { cwd: remotionDir, timeout: 120_000, stdio: "pipe" });
  }

  const outputDir = join(remotionDir, "out");
  mkdirSync(outputDir, { recursive: true });
  const rawOutput = join(outputDir, "final_cut_raw.mp4");
  const finalOutput = parseFlag(args, "--output") ?? join(outputDir, "final_cut.mp4");

  console.error("  Rendering Remotion composition...");
  execSync(
    `npx remotion render src/index.ts FinalCut --codec h264 --output "${rawOutput}"`,
    { cwd: remotionDir, timeout: 600_000, stdio: "inherit" }
  );

  // Post-process for platform compatibility
  console.error("  Post-processing: re-encoding for compatibility...");
  execSync(
    `ffmpeg -y -i "${rawOutput}" ` +
    `-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 -preset medium ` +
    `-c:a aac -b:a 192k -movflags +faststart "${finalOutput}"`,
    { timeout: 300_000, stdio: "pipe" }
  );

  success(`Final cut rendered: ${finalOutput}`, {
    episode: epNum,
    output: finalOutput,
  });
}

// ================================================================
// Review — Send assembled film to Gemini Pro for full-film review
// ================================================================

async function reviewAssemblyCmd(args: string[]) {
  const epNum = parseInt(args[0]);
  if (isNaN(epNum)) { error("Usage: film assemble review <episode> [--file <path>]"); process.exit(1); }

  const db = openDb();
  const ep = getEpisode(db, epNum);
  if (!ep) { error(`Episode ${epNum} not found.`); process.exit(1); }

  const root = findProjectRoot()!;

  // Find the assembly file
  let videoPath = parseFlag(args, "--file");
  if (!videoPath) {
    // Look for rough_cut or final_cut
    const assemblyDir = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "assembly");
    const candidates = ["final_cut.mp4", "rough_cut.mp4"];
    for (const c of candidates) {
      const p = join(assemblyDir, c);
      if (existsSync(p)) { videoPath = p; break; }
    }
    // Also check remotion output
    const remotionOut = join(root, "episodes", `ep${String(epNum).padStart(2, "0")}`, "remotion", "out", "final_cut.mp4");
    if (!videoPath && existsSync(remotionOut)) videoPath = remotionOut;
  }

  if (!videoPath || !existsSync(videoPath)) {
    error("No assembly found. Run 'film assemble rough-cut' or 'film assemble render' first.");
    process.exit(1);
  }

  // Build shot list for context
  const shots = getShots(db, ep.id, "accepted");
  const shotList = shots.map(s => ({
    number: s.number,
    dialogue: s.dialogue_text ?? undefined,
    scene: s.scene_name,
    framing: s.framing,
  }));

  console.error(`  Reviewing assembly: ${videoPath}`);
  console.error(`  ${shotList.length} accepted shots in episode ${epNum}`);

  const geminiConfig = getGeminiConfig();
  const result = await reviewAssembly(geminiConfig, videoPath, shotList);

  // Store review in assemblies table
  db.run(
    `UPDATE assemblies SET review_text = ?, review_score = ? WHERE episode_id = ? ORDER BY id DESC LIMIT 1`,
    [result.rawResponse, result.score, ep.id]
  );

  // Also save to file
  const reviewPath = videoPath.replace(".mp4", "_review.md");
  Bun.write(reviewPath, result.rawResponse);

  db.close();

  success(`Assembly reviewed: ${result.score}/10 — ${result.recommendation}`, {
    episode: epNum,
    score: result.score,
    one_fix: result.oneFix,
    recommendation: result.recommendation,
    detail: result.detail.slice(0, 500),
    review_file: reviewPath,
  });
}
