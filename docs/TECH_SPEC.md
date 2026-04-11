# film-cli — Technical Specification

## 1. Project Structure

```
film-cli/
├── pyproject.toml              # Package config, dependencies, entry point
├── README.md
├── docs/
│   ├── PRD.md
│   └── TECH_SPEC.md
├── src/
│   └── film/
│       ├── __init__.py
│       ├── cli.py              # Click CLI entry point + command groups
│       ├── db.py               # SQLite schema, migrations, queries
│       ├── models.py           # Dataclasses for Project, Episode, Shot, Version, etc.
│       ├── state.py            # Shot state machine logic
│       ├── rules.py            # Rules engine (load TOML, validate)
│       ├── config.py           # film.toml config management
│       │
│       ├── commands/           # CLI command implementations
│       │   ├── __init__.py
│       │   ├── init.py         # film init
│       │   ├── config_cmd.py   # film config
│       │   ├── asset.py        # film asset *
│       │   ├── episode.py      # film episode *
│       │   ├── shot.py         # film shot *
│       │   ├── assemble.py     # film assemble *
│       │   ├── render.py       # film render
│       │   ├── knowledge.py    # film rules, film failures
│       │   └── status.py       # film status
│       │
│       ├── integrations/       # API wrappers
│       │   ├── __init__.py
│       │   ├── kling.py        # Kling API (omni, i2v, voice-clone, etc.)
│       │   ├── nb2.py          # Nano Banana 2 / Gemini Flash Image
│       │   ├── gemini.py       # Gemini 3.1 Pro review
│       │   └── base.py         # Shared: auth, retry, compression
│       │
│       ├── knowledge/          # Embedded production knowledge
│       │   ├── rules.toml      # 30+ machine-readable rules
│       │   ├── failures.toml   # Known failure modes + solutions
│       │   └── templates/      # Prompt templates
│       │       ├── frame_prompt.md
│       │       ├── kling_prompt.md
│       │       ├── review_frame.md
│       │       ├── review_video.md
│       │       └── visual_dna.md
│       │
│       └── output.py           # JSON/table output formatting
│
├── dashboard/                  # Next.js web dashboard
│   ├── package.json
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        # Project overview
│   │   │   ├── shots/
│   │   │   │   └── page.tsx    # Shot kanban board
│   │   │   ├── shots/[id]/
│   │   │   │   └── page.tsx    # Shot detail + version timeline
│   │   │   ├── assets/
│   │   │   │   └── page.tsx    # Asset gallery
│   │   │   └── api/
│   │   │       └── [...route]/
│   │   │           └── route.ts # Thin API layer reading film.db
│   │   └── components/
│   └── tailwind.config.ts
│
└── tests/
    ├── test_db.py
    ├── test_rules.py
    ├── test_state.py
    └── test_cli.py
```

## 2. Database Schema

```sql
-- Core tables

CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    config_json TEXT DEFAULT '{}'
);

CREATE TABLE characters (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    name TEXT NOT NULL,
    description TEXT,
    voice_clone_id TEXT,
    metadata_json TEXT DEFAULT '{}',
    UNIQUE(project_id, name)
);

CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    character_id INTEGER REFERENCES characters(id),
    type TEXT NOT NULL CHECK(type IN ('portrait','turnaround','expression','scene','object','voice_clone')),
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    purpose TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','generated','reviewed','locked')),
    gemini_score REAL,
    review_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE episodes (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    number INTEGER NOT NULL,
    title TEXT,
    script_md TEXT,
    status TEXT DEFAULT 'development' CHECK(status IN ('development','pre_production','production','post_production','released')),
    UNIQUE(project_id, number)
);

CREATE TABLE shots (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    number INTEGER NOT NULL,
    scene_name TEXT,
    framing TEXT CHECK(framing IN ('ECU','MCU','MS','MLS','WS')),
    angle TEXT,
    camera_move TEXT,
    duration_target REAL DEFAULT 5.0,
    dialogue_text TEXT,
    voice_ids_json TEXT DEFAULT '[]',
    character_ref_ids_json TEXT DEFAULT '[]',
    scene_ref_id INTEGER REFERENCES assets(id),
    object_ref_ids_json TEXT DEFAULT '[]',
    status TEXT DEFAULT 'planned' CHECK(status IN (
        'planned','frame_generating','frame_generated','frame_reviewed',
        'video_generating','video_generated','video_reviewed',
        'accepted','rerolled','restructured','structural_failure'
    )),
    accepted_version INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(episode_id, number)
);

CREATE TABLE versions (
    id INTEGER PRIMARY KEY,
    shot_id INTEGER REFERENCES shots(id),
    version_number INTEGER NOT NULL,
    -- Prompts
    frame_prompt TEXT,
    kling_prompt TEXT,
    kling_params_json TEXT,
    image_list_json TEXT,
    -- Artifacts
    frame_path TEXT,
    video_path TEXT,
    kling_task_id TEXT,
    -- Timestamps
    frame_generated_at TEXT,
    video_generated_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(shot_id, version_number)
);

CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    version_id INTEGER REFERENCES versions(id),
    review_type TEXT NOT NULL CHECK(review_type IN ('frame','video','assembly')),
    reviewer TEXT DEFAULT 'gemini_pro',
    model_used TEXT,
    score REAL,
    review_text TEXT,
    one_fix TEXT,
    prompt_suggestions TEXT,
    zero_tolerance_failures_json TEXT DEFAULT '[]',
    decision_recommendation TEXT CHECK(decision_recommendation IN ('accept','reroll','restructure')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    version_id INTEGER REFERENCES versions(id),
    action TEXT NOT NULL CHECK(action IN ('accept','reroll','restructure','discard')),
    reason TEXT,
    decided_by TEXT DEFAULT 'agent',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE assemblies (
    id INTEGER PRIMARY KEY,
    episode_id INTEGER REFERENCES episodes(id),
    type TEXT NOT NULL CHECK(type IN ('animatic','rough_cut','fine_cut','final')),
    shot_order_json TEXT NOT NULL,
    transitions_json TEXT DEFAULT '[]',
    subtitles_json TEXT DEFAULT '[]',
    output_path TEXT,
    review_text TEXT,
    review_score REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_shots_episode ON shots(episode_id);
CREATE INDEX idx_shots_status ON shots(status);
CREATE INDEX idx_versions_shot ON versions(shot_id);
CREATE INDEX idx_reviews_version ON reviews(version_id);
CREATE INDEX idx_assets_type ON assets(type);
```

## 3. Shot State Machine

```python
# Valid state transitions
TRANSITIONS = {
    'planned':           ['frame_generating'],
    'frame_generating':  ['frame_generated'],  # after API returns
    'frame_generated':   ['frame_reviewed'],
    'frame_reviewed':    ['frame_generating',   # re-generate (score < 8)
                          'video_generating'],  # proceed (score >= 8)
    'video_generating':  ['video_generated'],   # after API returns
    'video_generated':   ['video_reviewed'],
    'video_reviewed':    ['accepted',           # score >= 8
                          'rerolled',           # score 7-8, fixable
                          'restructured'],      # score < 7 or 3+ rerolls
    'rerolled':          ['planned'],           # new version, back to start
    'restructured':      ['planned'],           # new version with structural change
}

MAX_ITERATIONS = 6  # After 6 versions → structural_failure
```

## 4. Rules Engine

```python
# rules.py — loads knowledge/rules.toml, validates against command params

class RuleResult:
    rule_id: str
    severity: str  # 'error' | 'warning' | 'info'
    message: str
    passed: bool

def validate_kling_params(params: dict) -> list[RuleResult]:
    """Called before film shot generate-video"""
    
def validate_frame_prompt(prompt: str) -> list[RuleResult]:
    """Called before film shot generate-frame"""
    
def validate_kling_prompt(prompt: str) -> list[RuleResult]:
    """Called before film shot generate-video"""

# Severity handling:
# - error: block the command, return non-zero exit code
# - warning: print warning, proceed (agent can override with --force)
# - info: print info, always proceed
```

## 5. CLI Output Format

All commands support `--json` flag for agent consumption.

```python
# Human output (default):
$ film shot status 1 5
Shot 05 | MCU | Maggie enters pawnshop
Status: video_reviewed (v2)
Score:  8.5/10
Fix:    "hands slightly stiff"
Rec:    accept

# Agent output (--json):
$ film shot status 1 5 --json
{
  "shot": 5,
  "status": "video_reviewed",
  "version": 2,
  "framing": "MCU",
  "description": "Maggie enters pawnshop",
  "latest_review": {
    "score": 8.5,
    "one_fix": "hands slightly stiff",
    "recommendation": "accept"
  },
  "total_versions": 2,
  "character_refs": ["maggie_main"],
  "scene_ref": "shop_establishing"
}
```

## 6. Integration Layer

### Kling API (`integrations/kling.py`)
Wraps the existing `kling_api.py` logic as importable functions:

```python
def omni_generate(
    prompt: str,
    image_list: list[dict],  # [{"path": "...", "type": "first_frame"}, {"path": "..."}]
    voice_list: list[dict],  # [{"voice_id": "xxx"}]
    model: str = "kling-v3-omni",
    duration: int = 5,
    aspect_ratio: str = "16:9",
    sound: str = "on",
    mode: str = "std",
) -> dict:  # {"task_id": "...", "video_path": "...", "duration": ...}

def voice_clone(name: str, audio_url: str) -> dict:
def voice_list(preset: bool = False) -> list[dict]:
def query_task(task_id: str, endpoint: str) -> dict:
```

### NB2 Image Generation (`integrations/nb2.py`)
```python
def generate_image(
    prompt: str,
    refs: list[str],  # file paths to reference images
    aspect_ratio: str = "16:9",
    image_size: str = "2K",
) -> str:  # returns path to generated image
```

### Gemini Pro Review (`integrations/gemini.py`)
```python
def review_frame(
    image_path: str,
    frame_prompt: str,
    intent: str,
) -> dict:  # {"score": 8.5, "review_text": "...", "one_fix": "...", "recommendation": "accept"}

def review_video(
    video_path: str,
    frame_prompt: str,
    kling_prompt: str,
    intent: str,
) -> dict:  # same structure

def review_assembly(
    video_path: str,
    shot_list: list[dict],
) -> dict:
```

## 7. Config File (`film.toml`)

```toml
[project]
name = "Second Hand"
aspect_ratio = "16:9"  # default for all shots
fps = 24

[api.kling]
access_key = ""
secret_key = ""
base_url = "https://api-beijing.klingai.com"
default_model = "kling-v3-omni"
default_mode = "std"
default_duration = 5

[api.openrouter]
api_key = ""

[api.review]
model = "google/gemini-3.1-pro-preview"
auto_accept_threshold = 0  # 0 = always require manual decision; 8 = auto-accept ≥8

[api.image]
model = "google/gemini-3.1-flash-image-preview"

[assembly]
engine = "remotion"  # or "ffmpeg"
loudnorm = "I=-12:LRA=7:TP=-1"
pre_boost_db = 4

[rules]
strict = true  # error-level rules block commands
```

## 8. Prompt Templates

### Frame Prompt Template (`knowledge/templates/frame_prompt.md`)
```
=== SUBJECT (frozen mid-motion) ===
{subject_description}

=== COMPOSITION ===
Framing: {framing}
Angle: {angle}
Subject placement: {placement}
Lead room: {lead_room}

=== CAMERA + LENS ===
{camera_lens_from_visual_dna}

=== LIGHTING ===
{lighting_from_visual_dna}

=== COLOR + GRADE ===
{color_grade_from_visual_dna}

=== ATMOSPHERE ===
{atmosphere_from_visual_dna}

=== STYLE ANCHORS ===
{style_anchors_from_visual_dna}

=== AVOID ===
{avoid_list}
```

### Kling Prompt Template (`knowledge/templates/kling_prompt.md`)
```
<<<image_1>>> establishes the location.
<<<image_2>>> shows {character_a} appearance.

=== CAMERA MOVEMENT ===
{camera_movement_description}

=== SUBJECT MOTION ===
{timed_motion_beats}

=== ATMOSPHERIC MOTION ===
{atmosphere_motion}

=== PERFORMANCE ===
{performance_direction}

=== DIALOGUE ===
{inline_dialogue_with_voice_syntax}

=== AUDIO ENVIRONMENT ===
{room_tone_and_diegetic_sounds}

=== AVOID ===
{avoid_list}
```

## 9. Dashboard API Routes

```
GET  /api/project              → project overview + stats
GET  /api/episodes              → episode list with shot counts
GET  /api/episodes/:ep/shots    → shot list with status, score, version count
GET  /api/episodes/:ep/shots/:n → shot detail: all versions, prompts, reviews, decisions
GET  /api/assets                → asset list filterable by type/character/status
GET  /api/knowledge/rules       → all rules with severity
GET  /api/knowledge/failures    → failure modes index
POST /api/episodes/:ep/shots/:n/decide → {version, action, reason} → calls CLI
```

Dashboard reads SQLite directly (read-only). Write operations shell out to `film` CLI to maintain single mutation path.

## 10. Build & Install

```bash
# Development
git clone ... && cd film-cli
pip install -e ".[dev]"

# Usage
film init "My Film"
film config set api.kling.access_key "xxx"
film config set api.openrouter.api_key "xxx"

# Dashboard
cd dashboard && npm install && npm run dev
```

Entry point in `pyproject.toml`:
```toml
[project.scripts]
film = "film.cli:main"
```
