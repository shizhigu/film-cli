# film-cli

> A quality-gated CLI harness that enables AI agents to autonomously produce multi-shot narrative films.

## What is this?

film-cli is a TypeScript/Bun command-line tool that wraps the entire AI filmmaking pipeline -- from script to screen -- into atomic, quality-gated commands designed for AI coding agents like Claude Code and Cursor. It enforces greedy sequential shot production, 35+ production rules, and automated review gates to transform stochastic video generation into a repeatable filmmaking process.

## Why?

I noticed that every competing AI film tool uses a generate-and-concatenate pipeline that produces visual noise, not coherent stories. After shipping two narrative micro-films through ad-hoc scripts and losing state to context window compaction, I built film-cli to encode hard-won production knowledge into persistent, machine-enforceable infrastructure.

## How it works

The CLI treats the AI agent as the director and itself as the production infrastructure:

1. **Project Init**: `film init` creates a SQLite database, TOML config, and asset directory structure.
2. **Asset Registration**: Character portraits, turnaround sheets, voice clones, and Kling Element Library 3D identity anchors are registered before any shot production.
3. **Greedy Sequential Production**: Shot N+1 cannot begin until Shot N is accepted (score >= 8/10). Each shot passes through an 8-state machine: planned, frame_generating, frame_generated, frame_reviewed, video_generating, video_generated, video_reviewed, accepted.
4. **Rules Engine**: 35 production rules validate prompts before every API call -- blocking freeze-trap words, enforcing three-layer motion, requiring kinetic verbs, and checking camera rig specifications.
5. **Quality Gates**: Gemini 3.1 Pro reviews every frame and video with prompt-inclusive context, returning actionable `PROMPT_FIX` suggestions rather than vague complaints.
6. **Assembly**: FFmpeg rough-cut with audio normalization, or a full Remotion React project with cross-dissolve transitions and animated subtitles.

All state persists in SQLite. An agent starting a fresh session calls `film status --json` and has full operational context in one command.

## Key Technical Highlights

- **Greedy Algorithm Enforcement**: Shot N+1 is code-blocked until Shot N reaches "accepted" status, forcing the agent to adapt to what AI video models actually produced rather than planning against assumptions.
- **35-Rule Production Engine**: Every rule corresponds to a real production failure -- "static camera" freezing entire frames, `<<<voice_N>>>` tokens breaking lip-sync, single-phase camera movements producing flat cinematography.
- **Dual Output Mode**: Every command supports `--json` for structured agent consumption, making the CLI the single source of truth for production state across sessions.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | TypeScript / Bun |
| State DB | SQLite (bun:sqlite) |
| Config | TOML |
| Video Generation | Kling v3-omni API |
| Frame Generation | Nano Banana 2 (Gemini 3.1 Flash Image) |
| Quality Review | Gemini 3.1 Pro (via OpenRouter) |
| Image Quality | pyiqa (NIQE, MUSIQ, NIMA) |
| Video Processing | FFmpeg |
| Assembly | Remotion 4.x + FFmpeg |

## Quick Start

```bash
git clone https://github.com/gushizhi/film-cli.git
cd film-cli
bun install
cp film.toml.example film.toml   # Add API keys (Kling, OpenRouter)
bun run src/cli.ts init my-film
bun run src/cli.ts status --json
```

## License

MIT
