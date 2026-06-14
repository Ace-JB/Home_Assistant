# Home Assistant - Sentinel

<!-- TEST_REPORT_START -->
# Performance Snapshot (June 10, 2026) ✅

The system has been verified with **184 automated tests**. Below are the latest local performance metrics from the server test suite:

| Component | Operation | Duration | Note |
| :--- | :--- | :--- | :--- |
| **Async_Voice_Video** | `safeSave` | **129.97 ms** | Optimized MP4 synthesis |
| **FaceEngine** | `detectAll.faces` | **381.00 ms** | face-inference |
| **FaceEngine** | `extractDescriptor` | **39.54 ms** | Per-face feature extraction |
| **FaceEngine** | `loadModels` | **81.74 ms** | One-time startup / warmup |
| **Queue** | `push` | **77.05 ms** | Sequential task queue overhead |
| **Socket** | `calculatePcmLevel` | **<1 ms** | Audio volume analysis |
| **SyncManager** | `addAudio` | **<1 ms** | Audio buffer push overhead |
| **SyncManager** | `addVideo` | **<1 ms** | Frame push overhead |

Latest verification command:

```bash
bun run test
```

Result: **184 pass / 0 fail / 643 assertions** across 29 files in **8.94s**.

Generated reports:
- `test-report.html`
- `performance-report.json`
<!-- TEST_REPORT_END -->

## Hardware & Environment
- **TensorFlow Backend**: TensorFlow Node (Metal/Accelerate)
- **FFmpeg**: v8.1.1 (Apple Silicon optimized)
- **Bun Runtime**: v1.3.13
- **Model Storage**: Local metadata directory (`models/metadata`)

---

## Quick Start

Sentinel is a local, privacy-first home monitoring assistant built with Bun, React, and TensorFlow.js.

### 1. Install Dependencies
```bash
bun install
```

### 2. Prepare Python Services And Models
```bash
bun run python-services:setup
```

### 3. Start Development Server
```bash
bun dev
```

This starts the persistent Web shell only. The Dashboard stays online, but the assistant runtime starts in `stopped` state by default: camera, microphone, realtime socket, WebRTC, FunASR, Qwen model services, CosyVoice, and MDX are not started until explicitly requested.

Open the Dashboard at:

```txt
http://localhost:3000/
```

Use either entry point to control the backend runtime:
- Sidebar bottom status button: opens a confirmation dialog before starting or stopping the assistant runtime.
- Dashboard service card `assistant-runtime`: exposes the same start/stop control for service-oriented troubleshooting.

When the runtime is stopped, Dashboard, logs, memory APIs, and SQLite-backed review surfaces remain available. Live, Memory, Voice, and Logs navigation from the sidebar is gated until the runtime is `running` or `degraded`.

### 4. Run Verification Suite
```bash
# Run all tests
bun run test

# Run tests and generate HTML + JSON performance reports, then sync README.md
bun run test:report

# Type-check and build
bun run typecheck
bun run build
```

### 5. Environment Configuration
Copy `.env.example` to `.env` when local overrides are needed:

```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_SOCKET_URL=ws://localhost:3001/ws/realtime
VITE_MODEL_BASE_PATH=/models
SENTINEL_MODEL_TRACE=0
SENTINEL_MODEL_TRACE_MAX_CHARS=4000
SENTINEL_TTS_PROVIDER=cosyvoice
COSYVOICE_BASE_URL=http://localhost:10102
COSYVOICE_ENDPOINT=/inference_zero_shot
PYTHON_SERVICES_ROOT=data/python_services
PYTHON_SERVICES_SCRIPT_ROOT=src/server/python_services
SENTINEL_DB_DIR=data/db
SENTINEL_MODEL_BASE_PATH=data/models/server-models
COSYVOICE_MODEL_DIR=data/python_services/models_cache/cosyvoice/Fun-CosyVoice3-0.5B-2512-4bit
QWEN_VLM_MODEL_DIR=data/python_services/models_cache/qwen-vlm
QWEN_ROUTER_FAST_MODEL_DIR=data/python_services/models_cache/qwen-router/fast
QWEN_ROUTER_REPAIR_MODEL_DIR=data/python_services/models_cache/qwen-router/repair
COSYVOICE_FALLBACK_TO_SAY=0
```

You can also keep profile-specific overrides in `.env.development`, `.env.production`, or `.env.test`.

#### CosyVoice TTS
CosyVoice is the default TTS provider for local voice replies. It runs as a local MLX-backed FastAPI service and keeps macOS `say` available as an optional fallback.

Install the local CosyVoice runtime:

```bash
bun run python-services:setup cosyvoice
```

Start or check the service:

```bash
bun run python-services:start
bun run python-services:status
```

Useful environment variables:
- `SENTINEL_TTS_PROVIDER` - set to `cosyvoice` for MLX CosyVoice or `say` for macOS native speech.
- `COSYVOICE_BASE_URL` and `COSYVOICE_ENDPOINT` - local service URL and inference endpoint.
- `PYTHON_SERVICES_ROOT` - runtime root for Python virtual environments, model caches, process ids, and logs.
- `COSYVOICE_MODEL_DIR` - fixed local MLX model directory, normally `data/python_services/models_cache/cosyvoice/Fun-CosyVoice3-0.5B-2512-4bit`.
- `COSYVOICE_PROMPT_AUDIO_PATH` and `COSYVOICE_PROMPT_TEXT` - active zero-shot speaker material selected from the voice control UI.
- `COSYVOICE_FALLBACK_TO_SAY` - set to `1` to fall back to macOS `say` when CosyVoice fails.

The voice control UI can extract speaker material from uploaded media or imported audio URLs. Generated uploads, speaker profiles, trace files, and extracted WAV files are stored under `data/voice`, which is ignored by git because it may contain private voice samples and transcripts.

#### MLX Model Services
Qwen VLM and router models run as managed Python services, not through Ollama. `bun run python-services:setup` installs the lightweight core Python services. Qwen model dependencies and model snapshots are heavier, so install them explicitly when you are ready to use the model services. The setup script downloads model snapshots through the shared Hugging Face cache at `data/python_services/models_cache/hf-cache`, then links the active snapshot into fixed model directories:

- `data/python_services/models_cache/qwen-vlm`
- `data/python_services/models_cache/qwen-router/fast`
- `data/python_services/models_cache/qwen-router/repair`

Install or refresh the model service environments:

```bash
bun run python-services:setup:models
```

For unstable networks, install the smaller router models first and the large VLM snapshot separately:

```bash
bun run python-services:setup:router
HF_TOKEN=... bun run python-services:setup:vlm
```

You can also run `huggingface-cli login` once; the setup script will read the cached token from `~/.cache/huggingface/token` automatically. Use `QWEN_HF_TOKEN_FILE` to point at another token file.

Default model repositories:

- `QWEN_VLM_REPO=mlx-community/Qwen3-VL-8B-Instruct-4bit`
- `QWEN_ROUTER_FAST_REPO=mlx-community/Qwen2.5-0.5B-Instruct-4bit`
- `QWEN_ROUTER_REPAIR_REPO=mlx-community/Qwen2.5-1.5B-Instruct-4bit`

To include Qwen model services in the default setup command, run `QWEN_SETUP=1 bun run python-services:setup`. To install dependencies without downloading model snapshots, set `QWEN_DOWNLOAD_MODELS=0`. To make setup fail when model files are missing, run it with `QWEN_REQUIRE_MODELS=1`. Use `HF_TOKEN`, `QWEN_HF_TOKEN`, or a cached Hugging Face CLI token for authenticated downloads; `QWEN_HF_MAX_WORKERS=1` is the default to avoid SSL retry storms on large snapshots. The setup script pins `HF_HOME`, `HF_HUB_CACHE`, and `HF_XET_CACHE` under `data/python_services/models_cache` so interrupted downloads stay project-local. `QWEN_HF_DISABLE_XET=1` and `HF_HUB_ENABLE_HF_TRANSFER=0` are the defaults because the standard downloader is more predictable for resumable weak-network downloads; change them only when you want backend-specific acceleration.

Useful environment variables:
- `QWEN_VLM_PORT` and `QWEN_ROUTER_PORT` - local FastAPI service ports.
- `QWEN_VLM_MODEL_DIR` - Qwen3-VL MLX model directory.
- `QWEN_ROUTER_FAST_MODEL_DIR` - Qwen2.5 0.5B router model directory.
- `QWEN_ROUTER_REPAIR_MODEL_DIR` - Qwen2.5 1.5B repair model directory.
- `QWEN_HF_CACHE_DIR` - shared Hugging Face cache used for resumable snapshot downloads; default `data/python_services/models_cache/hf-cache`.
- `QWEN_HF_HOME_DIR` - project-local Hugging Face home directory; default `data/python_services/models_cache/hf-home`.
- `QWEN_HF_XET_CACHE_DIR` - project-local Xet cache directory for opt-in Xet downloads; default `data/python_services/models_cache/hf-cache/xet`.
- `QWEN_HF_DISABLE_XET` - disables the Xet backend by default for more predictable resume behavior on weak networks.
- `QWEN_HF_DOWNLOAD_TIMEOUT` and `QWEN_HF_ETAG_TIMEOUT` - Hugging Face request timeouts; defaults are `60` and `30` seconds.
- `QWEN_VLM_REPO`, `QWEN_ROUTER_FAST_REPO`, and `QWEN_ROUTER_REPAIR_REPO` - Hugging Face repositories downloaded by `python-services:setup:models`.
- `QWEN_HF_MAX_WORKERS` - Hugging Face snapshot download worker count; default `1` is slower but more reliable on weak networks.
- `QWEN_HF_TOKEN_FILE` - optional token file path; default `~/.cache/huggingface/token`.
- `QWEN_ROUTER_REPAIR_WAIT_MS` - max wait for repair model prewarm before returning an explicit model-service error.

#### Model Decision Trace Logs
Set `SENTINEL_MODEL_TRACE=1` only during local debugging to print model prompts, decisions, summaries, and raw outputs:

```bash
SENTINEL_MODEL_TRACE=1 bun run dev
```

Use `SENTINEL_MODEL_TRACE_MAX_CHARS` to raise or lower the per-log truncation limit:

```bash
SENTINEL_MODEL_TRACE=1 SENTINEL_MODEL_TRACE_MAX_CHARS=8000 bun run dev
```

Trace logs are emitted with the `[ModelTrace:*]` prefix and currently cover:
- `Intention` - request context, raw model JSON, normalized intent decision, and JSON repair output.
- `Brain` - intent decision, injected memories, visual summary, recent conversation context, and final raw reply.
- `Vision` - visual prompt, detector reference, prepared image size, and visual summary output.
- `MemoryPrune` - pruning prompt and generated memory draft JSON.

These logs may include user conversation content, approved memories, visual summaries, and model raw output. Keep `SENTINEL_MODEL_TRACE=0` outside local debugging.

---

## Architecture Overview

The project is structured into modular layers for maximum performance and maintainability:

### 🧩 Frontend Web Shell (`src/components`, `src/components/live`, `src/config`)
- **Persistent Dashboard Shell**: `bun dev` and `bun start` open the Web shell first; neither command automatically starts camera, microphone, ASR, WebRTC, or Python model services.
- **Runtime Control Surface**: The Sidebar bottom status button and the Dashboard `assistant-runtime` service card are the explicit start/stop controls for the assistant runtime.
- **Navigation Gate**: Dashboard remains accessible while the runtime is stopped; Live, Memory, Voice, and Logs navigation is disabled until runtime state becomes `running` or `degraded`.
- **Config Layer**: `src/config` loads browser/runtime environment values such as API base URL and socket URL.
- **Reusable Live Panels**: `src/components/live` centralizes realtime status cards, audio realtime panels, pipeline info, and shared formatting helpers.

### 🧭 Assistant Runtime (`src/server/services/AssistantRuntimeService.ts`)
- **Runtime States**: `stopped`, `starting`, `running`, `stopping`, `degraded`, and `error` are tracked in memory only; service restart returns to `stopped`.
- **Minimal Startup**: Runtime start defaults to `minimal`, which starts FunASR, required MLX model services, audio monitor / wake ASR, and realtime socket only.
- **Optional Startup Tools**: The startup dialog can also prewarm CosyVoice TTS, Live / Vision, and MDX voice separation. Choosing Live / Vision promotes that start to `full` so camera, WebRTC, and visual detection start together.
- **Shutdown Scope**: Runtime stop releases monitor, realtime socket clients/server, WebRTC/UDP resources, and local Python model services while keeping the Web HTTP server, Dashboard APIs, pipeline logs, memory DB, and SQLite handles online.
- **Failure Semantics**: Python helper failures with a working monitor mark the runtime `degraded`; monitor startup failure marks it `error` and triggers cleanup.
- **WebRTC Gate**: `/webrtc` returns `409` while runtime is offline, so a browser cannot bypass the master runtime switch.

### 🧠 Brain & AI (`@modules/brain`)
- **HomeBrain**: The core logic engine calls managed MLX model services: Qwen3-VL handles main dialogue and visual summaries, while the router service handles fast intent routing and repair.
- **FaceEngine**: Real-time face detection and identification using `Human.js` and TensorFlow.
- **Prompt Files**: Prompt text is centralized under `src/server/prompts`, with Chinese and English variants kept together by responsibility.
- **Follow-up Intent Guard**: Short affirmative replies such as “可以呀” after an assistant proposal are resolved as current-session follow-ups instead of long-term memory recall.

### 🧠 Intention & Memory (`src/server/modules/intention`, `src/server/modules/memory`)
- **Dynamic Intention Analysis**: `analyzeCommand` classifies user input into `qa`, `follow_up`, `memory_recall`, `visual`, `device_control`, `conversation_end`, `acknowledgement`, or `non_actionable`.
- **Memory Retrieval Modes**: Long-term retrieval supports `semantic`, `recent_recall`, `hybrid`, and `none`; pure device control, closings, acknowledgements, and ASR noise skip memory injection.
- **Short Confirmation Handling**: Replies such as “可以呀 / 来一个 / 好啊” are treated as `answer_to_assistant` follow-ups only when the latest assistant message contains an actionable proposal.
- **Conversation Sessions**: `memory.sqlite` stores current-session conversation turns for follow-up context and later review.
- **Approved Long-term Memories**: Human-approved pruned memories are saved separately with topic, score, user state, behavior signal, situation metadata, hit count, and heat-decay ranking.
- **Memory Management UI**: `MemoryView` exposes conversation search, session deletion, memory pruning, approved-memory editing, and approved-memory removal through `/api/conversations` and `/api/memories`.

### 🎥 Media Pipeline (`@modules/media`)
- **SyncManager**: Manages high-performance ring buffers for synchronized A/V streams.
- **Synthesizer**: Handles lazy MP4 synthesis via FFmpeg for emergency recording.

### 🎙️ Voice & Tools (`@server/tools`)
- **Voice**: Text-to-Speech (TTS) uses the MLX CosyVoice service by default, keeps macOS `say` as fallback, and uses FunASR for transcription.
- **CosyVoice Material Workflow**: `VoiceControlView` extracts prompt audio and transcript candidates from local uploads or imported audio URLs, saves reusable speaker profiles, and applies the selected profile to the running TTS configuration.
- **Python Service Scripts**: `bun run python-services:setup`, `bun run python-services:start`, and `bun run python-services:status` manage local FastAPI helpers under `src/server/python_services`, including FunASR, CosyVoice, MDX, Qwen VLM, and Qwen router.
- **WebRTC**: Real-time video/audio streaming via WebRTC (UDP), created lazily only while the assistant runtime is active.
- **Frequency Control**: `WiseRelex` (DetectionValve) manages AI inference frequency to optimize CPU usage.
- **Identity Verification**: Camera recognition context is passed to `HomeBrain` with `identityVerification`, `similarity`, and threshold details before command execution.
- **Runtime-bound Listening Path**: Voice signal collection and realtime transcription are enabled only after the assistant runtime is started; realtime transcript display has no separate subtitle toggle.

### 📊 Dashboard & Logs (`src/components`, `src/server/services`)
- **Service Dashboard**: `DashboardView` and `DashboardService` surface four product-level services (`Web Shell`, `Assistant Runtime`, `Voice ASR`, `Live / Vision`) first, with Qwen VLM, Qwen router, CosyVoice, MDX, FFmpeg, yt-dlp, realtime socket, and WebRTC details folded under advanced dependencies.
- **Pipeline Logs**: `LogsView` and `PipelineLogService` connect pipeline events, model calls, incidents, and runtime service logs in one review surface.
- **Environment Loader**: `src/config/loadEnv.ts` loads `.env` plus environment-specific overrides before the app reads runtime configuration.

---

## Current Source Layout

```txt
src/
  components/
    live/                     # Reusable realtime page panels
    Sidebar.tsx               # Runtime status control and navigation gate
    DashboardView.tsx         # Web shell dashboard and service control surface
    MemoryView.tsx            # Conversation and approved-memory management UI
    LogsView.tsx              # Pipeline, model call, incident, and service log review UI
    VoiceControlView.tsx      # CosyVoice speaker material extraction and TTS profile UI
  config/                     # Runtime and browser-facing config helpers
  hooks/
    useAssistantRuntime.ts    # Frontend runtime polling and start/stop actions
  shared/
    ui/                       # Shared module UI wrappers
  server/
    prompts/                  # Centralized Chinese/English prompt text
    observability/            # Model trace logging helpers
    services/                 # Assistant runtime, Dashboard, FunASR, CosyVoice material, pipeline log, and benchmark services
    python_services/          # Managed local FastAPI helpers for FunASR, CosyVoice, and MDX
    scripts/                  # Local maintenance and media helper scripts
    modules/
      brain/                  # Response generation, vision gating, memory injection
      intention/              # Dynamic intent analysis and memory retrieval decisions
      memory/                 # Conversation sessions and approved long-term memories
      media/                  # Face engine, synchronization, media synthesis
    tools/                    # Socket, WebRTC, Voice, Camera, Queue tools
```

---

## Project Status: **Release Candidate v0.1.0**
- [x] WebRTC A/V Synchronization
- [x] Real-time Face Tracking
- [x] Multi-turn Voice Conversation (15s Wake Window)
- [x] Web Shell First Startup with Manual Assistant Runtime Control
- [x] Runtime-bound Voice Signal Collection
- [x] CosyVoice MLX TTS with reusable speaker material profiles
- [x] Dashboard controls for managed local services
- [x] Pipeline log, model call, incident, and benchmark review UI
- [x] Dynamic Intention Analysis with Memory Retrieval Decisions
- [x] Long-term Memory Retrieval (`semantic`, `recent_recall`, `hybrid`, `none`)
- [x] Memory Recall + Current-session Follow-up Intent Handling
- [x] Memory Management UI for Sessions and Approved Memories
- [x] Centralized Prompt Management
- [x] Automated Performance Monitoring
- [x] Privacy Audit Completed (No hardcoded secrets)

---

## Troubleshooting
- **FFmpeg Pixel Format Warning**: Expected on macOS `avfoundation`. The system automatically falls back to `uyvy422` with no performance loss.
- **Microphone Echo**: If the AI hears itself, ensure the `systemSpeaking` lock is enabled in `monitor.ts` (default: ON).
- **Assistant Runtime Is Offline**: This is the default after starting the Web shell. Use the Sidebar bottom status button or the Dashboard `assistant-runtime` card to start the minimal voice runtime; select Live / Vision or other tools in the startup dialog only when needed.
- **Voice Conversation Not Starting**: Confirm the assistant runtime is `running` or `degraded`, then check FunASR logs and microphone permission. There is no subtitle switch to enable.
- **WebRTC Returns 409**: `/webrtc` intentionally rejects connections while assistant runtime is stopped; start the runtime first.
- **CosyVoice Not Speaking**: Run `bun run python-services:status`, confirm `COSYVOICE_BASE_URL` points to the local service, verify `COSYVOICE_MODEL_DIR` contains `config.json`, and verify the selected prompt audio path is under `data/voice`.
- **CosyVoice Material Import Fails**: Install or refresh yt-dlp with the voice control UI or `bun run src/server/scripts/install_yt_dlp.ts`, then retry with a direct media URL. yt-dlp reads Chrome cookies by default via `YT_DLP_COOKIES_FROM_BROWSER=chrome`; use values like `chrome:Profile 1` for another Chrome profile, or set it empty to disable browser cookie loading.
- **Dashboard Service Won't Start**: Check the service log in `DashboardView`, verify the target binary is installed, and confirm the relevant path is allowed by the local config.
- **Pipeline Logs Look Empty**: The logs are created when pipeline, model, service, or incident events are recorded; run a normal voice or memory flow first.
- **Model Initialization**: Ensure Qwen model files exist under `data/python_services/models_cache/qwen-vlm`, `data/python_services/models_cache/qwen-router/fast`, and `data/python_services/models_cache/qwen-router/repair`, then run `bun run python-services:setup`.
- **Face Recognition Mismatch**: If logs show `candidateLabel` but low `similarity`, re-register the member with `bun src/server/scripts/register_face.ts --name master --camera`.

## CodeGraph

This repository is initialized for [CodeGraph](https://github.com/colbymchenry/codegraph) to provide local semantic code navigation.

Local maintenance notes:
- The generated `.codegraph/` directory is ignored and should not be committed.
- After changing source files, run `bun run codegraph:sync` or `bun run codegraph:index` to refresh the graph.
- Check the graph with `bun run codegraph:status`.
- The graph is best at static code structure; it will not fully understand runtime-only paths, environment-variable switches, or external process behavior.
- Keep an eye on these manually maintained areas:
  - server routes in `src/server/core`
  - long-lived services in `src/server/services`
  - cross-cutting UI flows in `src/components`
  - managed Python service workflows under `src/server/python_services`
- If the index becomes stale or locked, use `npx -y @colbymchenry/codegraph unlock .` before reindexing.
- If you want agent access, run `npx -y @colbymchenry/codegraph install` for the assistant you use locally.
