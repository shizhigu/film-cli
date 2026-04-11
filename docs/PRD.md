# film-cli — Product Requirements Document

## Problem Statement

**AI video generation models can produce stunning 5-15 second clips. But nobody has solved how to reliably produce a coherent 2-minute narrative film from them.**

The gap: Kling, Runway, Veo, Sora are clip generators. A narrative film requires 10-30 clips that share consistent characters, continuous story logic, matched visual style, dialogue with lip-sync, and professional assembly. Today this requires a human expert driving dozens of API calls across multiple services, manually tracking state in their head, and re-learning the same failure modes every session.

We have proven this workflow works — shipping two narrative micro-films (22 shots + 13 shots) with a conversational AI agent (Claude Code) driving Python scripts. But the process is fragile:

- **State lives in conversation context** — when context compacts, the agent forgets which shots are done, which versions failed, and why
- **No reproducibility** — prompts, reviews, and decisions are lost when the conversation ends  
- **30 production rules exist only as text** — nothing prevents the agent from repeating known mistakes
- **No quality gates enforced** — the agent can skip review, use wrong models, or ignore reference images
- **Assembly is manual** — no automated path from "accepted shots" to "rendered film"

### Why Now

1. Video generation models just crossed the quality threshold for narrative content (Kling v3-omni with multi-image refs + voice_list + lip-sync)
2. AI agents (Claude Code, Codex, etc.) are now capable enough to drive multi-step production workflows
3. The micro-drama market is $11B and doubling annually
4. Deep technical analysis of 8 competing projects (OpenMontage, ViMax, MovieAgent, FilmAgent, MultiShotMaster, etc.) confirmed: **no existing tool implements a closed-loop, quality-gated production pipeline**. They all generate-and-concatenate without review loops.

---

## Customer

**Primary: AI coding agents** (Claude Code, Cursor, Codex) that need to produce narrative video content autonomously or semi-autonomously.

**Secondary: Technical creators** who use AI agents to produce short films, micro-dramas, marketing videos, or educational content.

**The user's life after this ships:** An agent receives "produce a 2-minute short film about X" and drives the entire pipeline — scripting, asset generation, shot-by-shot production with quality gates, assembly — outputting a finished video. The human reviews key decisions via a web dashboard but doesn't need to manage the process.

---

## Success Criteria

1. **End-to-end autonomous production**: An agent can produce a 10-shot, 90-second narrative film from a one-paragraph concept without human intervention, scoring ≥6/10 from Gemini Pro review
2. **Quality-gated production**: No shot enters the final cut without passing VLM review (≥8/10 score)
3. **Cross-session continuity**: Agent can resume production after context loss with a single `film status` command
4. **Rule enforcement**: Zero violations of critical production rules (wrong model, missing refs, static camera prompts) — the CLI blocks them before API calls
5. **Reproducibility**: Every prompt, review, and decision is persisted and queryable

---

## Solution Overview

A Python CLI called `film` with:

1. **SQLite-backed project state** — shots, versions, prompts, reviews, decisions all persisted
2. **Atomic commands** — each operation is one CLI call with structured JSON output
3. **Embedded production rules engine** — validates prompts and parameters before API calls
4. **Three API integrations** — Kling (video), Nano Banana 2 (frames), Gemini Pro (review)
5. **Quality gate enforcement** — frame review required before video generation, video review required before acceptance
6. **Remotion assembly generation** — auto-generates a Remotion project from accepted shots
7. **Web dashboard** — read-only progress view + decision buttons (accept/reject/restructure)

---

## Core Workflow

```
film init "My Film"
    ↓
film brief create --concept "A pawnshop owner helps a daughter find her father's sold motorcycle"
    ↓
film asset generate --type portrait --character "Maggie" --prompt-file maggie.txt
film asset generate --type scene --name "pawnshop" --prompt-file shop.txt
film asset voice-clone --character "Maggie" --audio-url "..."
    ↓
film shot plan 1 --from-brief    (agent + LLM plan the shot list)
    ↓
┌─ FOR EACH SHOT (greedy loop) ─────────────────────────┐
│                                                         │
│  film shot generate-frame 1 5 --prompt-file frame.txt   │
│      ↓ (rules engine validates 6 sections + refs)       │
│  film shot review-frame 1 5 --intent "Maggie enters"    │
│      ↓ (Gemini Pro scores, stores review)               │
│  [score < 8? re-generate frame]                         │
│      ↓                                                  │
│  film shot generate-video 1 5 --prompt-file kling.txt   │
│      ↓ (rules engine validates 3-layer motion, etc.)    │
│  film shot review-video 1 5                             │
│      ↓ (Gemini Pro scores with both prompts)            │
│  film shot decide 1 5 accept --reason "8.5/10"          │
│                                                         │
│  [Next shot designed based on actual output of this one]│
└─────────────────────────────────────────────────────────┘
    ↓
film assemble 1 --transitions --subtitles
    ↓
film render 1 --output final_cut.mp4
```

---

## Key Features

### 1. Project State Management
- SQLite database (`film.db`) at project root
- Every shot has a state: `planned → frame_generated → frame_reviewed → video_generated → video_reviewed → accepted`
- Every version stores: prompts used, artifacts generated, reviews received, decisions made
- `film status` returns complete project state in one call

### 2. Rules Engine
- 30+ production rules encoded as machine-readable TOML
- Validated BEFORE API calls (fail fast, save money)
- Categories: model params, prompt structure, reference images, voice config
- Examples:
  - Block `kling-v2` or any non-v3 model
  - Warn if prompt lacks 3-layer motion (camera + subject + atmosphere)
  - Error if `voice_list` present but `sound` not `on`
  - Warn if prompt contains "static camera" or "locked"
  - Error if `image_list` has only `first_frame` (missing character refs)

### 3. Quality Gates
- Frame review required before video generation (configurable: can be auto-approved at score ≥ threshold)
- Video review required before acceptance
- Reviews use Gemini 3.1 Pro with structured prompt (includes upstream prompts for actionable feedback)
- 6-iteration cap per shot — after that, forces restructure

### 4. Prompt Templates
- Embedded NB2 frame template (6 mandatory sections)
- Embedded Kling omni template (3-layer motion + performance + dialogue + audio)
- `film prompt build` wizard that walks through each section
- `film prompt check` validates against rules before submission

### 5. Asset Management
- Character portraits, turnarounds, expression sheets, scene refs, voice clones
- Each asset has status: `pending → generated → reviewed → locked`
- Locked assets are immutable canonical references
- Auto-bound to shots via character/scene associations

### 6. Assembly Pipeline
- Auto-generates Remotion project from accepted shots + transition config + subtitles
- `film assemble` handles shot ordering, transition types, subtitle timing
- `film render` calls Remotion to produce final output
- Post-processing: loudnorm audio normalization, re-encoding for platform compatibility

### 7. Web Dashboard
- Local Next.js server started via `film dashboard`
- Shot kanban board (cards by state)
- Shot detail: version timeline with frames, videos, prompts, reviews
- Decision buttons: Accept / Reroll / Restructure
- Assembly timeline preview
- Read-only — all mutations go through CLI

---

## Out of Scope (MVP)

- Multi-user / team collaboration
- Cloud hosting / SaaS deployment
- Real-time preview during generation
- Custom model training (MultiShotMaster-style)
- Non-narrative video (ads, tutorials, music videos)
- Mobile app
- Billing / subscription management

---

## Technical Architecture

```
┌─────────────────────────────────────────────┐
│              AI Agent (Claude Code)           │
│         drives workflow via bash calls        │
└──────────────────┬──────────────────────────┘
                   │ film <command> --json
                   v
┌─────────────────────────────────────────────┐
│              film CLI (Python/Click)          │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │
│  │  Rules   │ │ Prompt   │ │   State      │  │
│  │  Engine  │ │ Templates│ │   Machine    │  │
│  └────┬────┘ └────┬─────┘ └──────┬───────┘  │
│       │           │              │           │
│  ┌────v───────────v──────────────v────────┐  │
│  │           SQLite (film.db)             │  │
│  └───────────────────────────────────────┘  │
│       │           │              │           │
│  ┌────v────┐ ┌────v────┐  ┌─────v──────┐   │
│  │  Kling  │ │  NB2    │  │  Gemini    │   │
│  │  API    │ │  API    │  │  Pro API   │   │
│  └─────────┘ └─────────┘  └────────────┘   │
└──────────────────┬──────────────────────────┘
                   │ reads film.db
                   v
┌─────────────────────────────────────────────┐
│         Web Dashboard (Next.js)              │
│    shot board + detail + decisions           │
└─────────────────────────────────────────────┘
```

### Data Storage
- **SQLite** for relational data (projects, episodes, shots, versions, reviews, decisions)
- **Filesystem** for binary artifacts (`episodes/ep01/shots/shot05/v1/frame.png`)
- **TOML** for rules and config (`knowledge/rules.toml`, `film.toml`)

### Dependencies
- Python 3.11+, Click, sqlite3 (stdlib), requests, PyJWT
- Node.js 18+ (for Remotion assembly)
- ffmpeg (for audio normalization, video compression)

---

## Implementation Plan

### Phase 1: Core CLI + Database (Week 1)
- Project init, config, directory structure
- SQLite schema + migrations
- Shot CRUD + state machine
- Asset registration + listing
- `film status` command

### Phase 2: Generation + Review Loop (Week 2)
- Frame generation (NB2 wrapper)
- Frame review (Gemini Pro wrapper)
- Video generation (Kling omni wrapper)
- Video review (Gemini Pro wrapper with dual-prompt context)
- Decision recording
- Rules engine (TOML-based validation)

### Phase 3: Assembly + Dashboard (Week 3)
- Remotion project generation from DB
- Rough cut assembly (ffmpeg fallback)
- Subtitle generation from dialogue data
- Audio normalization
- Web dashboard: shot board, detail view, decision buttons

### Phase 4: Polish + Agent Integration (Week 4)
- JSON output mode on all commands
- Prompt templates + `film prompt build` wizard
- Knowledge base commands (`film rules`, `film failures`)
- Cost tracking
- End-to-end test: agent produces a complete 5-shot film

---

## Key Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| CLI-first, not API-first | CLI | Single code path for validation; works without web server; agent calls via bash |
| SQLite, not Postgres | SQLite | Zero deployment overhead; embedded; trivially backed up |
| Wrapper scripts, not reimplementation | Wrap existing .py | Proven API integration code; preserves retry logic; faster to build |
| Rules as TOML, not hardcoded | TOML | User/agent can add rules without modifying source |
| Remotion for assembly | Remotion | Proven transition quality; programmatic; already used in production |
| Gemini Pro for review | Gemini 3.1 Pro | Only model that catches narrative/composition issues (Flash misses them) |
| Greedy sequential, not parallel | Sequential | Shot N+1 design depends on shot N's actual output; this is the methodology's core insight |

---

## Risks

| Risk | Mitigation |
|---|---|
| Kling API changes/deprecation | Wrapper abstraction; Veo/Runway as fallback backends |
| Gemini Pro review quality degrades | Score calibration tests; human override always available |
| Agent can't drive CLI reliably | Structured JSON output; self-documenting help text; example workflows |
| SQLite limits at scale | Unlikely at micro-film scale (10-30 shots); migrate to Postgres if needed |
| Remotion Node.js dependency | ffmpeg fallback for basic assembly |

---

## Appendix: The 30 Production Rules

*(Extracted from real production — each rule prevented or fixed a specific failure)*

### Model & Endpoint
1. Always `kling-v3-omni` for dialogue/character shots
2. Always `--sound on` when voice_list present
3. `voice_list` max 2 entries
4. Prompt max 2500 characters

### Dialogue Syntax
5. Inline dialogue: `[Character: desc]: Chinese text` only
6. Chain with `Immediately,` or `Then`
7. Never `<<<voice_1>>>` token (ignores voice_id)
8. voice_list order = dialogue order

### Shot Structure
9. Single long takes > split sub-shots (up to 15s)
10. Single-character MCU > wide two-shot for lip-sync
11. Frozen mid-motion frames > static portraits
12. Every shot needs 3 motion layers
13. Camera must move — never "locked/static camera"

### Character Consistency
14. Always pass character portrait refs in omni image_list
15. Mouth-blocking objects → relocate to hand for speaking
16. Scene ref images are strict spatial authority

### Voice
17. Never external TTS — Kling native voice only
18. Off-screen voices sound telephone-quality — avoid
19. Chinese dialogue for voice generation

### Review
20. Gemini 3.1 Pro for all review (never Flash)
21. Always include prompt text in review requests
22. Quality over cost — redo until right

### Prompt Engineering
23. NB2: professional cinema vocabulary
24. Kling: simplified vocabulary (doesn't understand camera terms)
25. Never start NB2 prompts with title text
26. Performance direction = visible micro-actions, not internal states

### Production
27. Shot-by-shot greedy algorithm — never batch
28. Dialogue shots need physical action + emotion
29. Restructure content > post-production hacks
30. Kling sometimes adds BGM despite negatives — accept or filter
