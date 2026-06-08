# Home Assistant - Sentinel

<!-- TEST_REPORT_START -->
# Performance Snapshot (June 9, 2026) ✅

The system has been verified with **160 automated tests**. Below are the latest local performance metrics from the server test suite:

| Component | Operation | Duration | Note |
| :--- | :--- | :--- | :--- |
| **Async_Voice_Video** | `safeSave` | **117.34 ms** | Optimized MP4 synthesis |
| **FaceEngine** | `detectAll.faces` | **390.72 ms** | face-inference |
| **FaceEngine** | `extractDescriptor` | **45.35 ms** | Per-face feature extraction |
| **FaceEngine** | `loadModels` | **82.63 ms** | One-time startup / warmup |
| **Queue** | `push` | **78.43 ms** | Sequential task queue overhead |
| **Socket** | `calculatePcmLevel` | **<1 ms** | Audio volume analysis |
| **SyncManager** | `addAudio` | **<1 ms** | Audio buffer push overhead |
| **SyncManager** | `addVideo` | **<1 ms** | Frame push overhead |

Latest verification command:

```bash
bun run test
```

Result: **160 pass / 0 fail / 528 assertions** across 26 files in **3.22s**.

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

### 5. Standalone Module Demos
Video module only:

```bash
bun run dev:video
```

Audio module only:

```bash
bun run dev:audio
```

Open:
- The video module opens `/demo/video` by default.
- The audio module opens `/demo/audio` by default.
- `/demo` - demo entry page
- `/demo/video` - WebRTC preview plus Human detection results
- `/demo/audio` - speech-to-text, audio level, and transcript history

### 6. Environment Configuration
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

### 🧩 Frontend Module Demos (`src/modules`, `src/components/live`, `src/config`)
- **Error Isolation**: `src/shared/ui/ModuleErrorBoundary.tsx` keeps module crashes from taking down the full UI.
- **Config Layer**: `src/config` loads browser/runtime environment values such as API base URL and socket URL.
- **Reusable Live Panels**: `src/components/live` centralizes demo shells, status cards, audio realtime panels, pipeline info, and shared formatting helpers.
- **Standalone Verification**: `src/demos/DemoIndex.tsx` acts as a module verification center and `src/demos/DemoRouter.tsx` routes directly to the standalone video/audio demo pages.
- **Direct Demo Pages**: `src/demos/DemoRouter.tsx` routes to `/demo/video` and `/demo/audio` for split verification of the live view.

### 🎞️ Video Recognition Module (`src/modules/video-recognition`)
- **Standalone Demo**: `bun run dev:video` starts the video-only runtime and opens `/demo/video`.
- **Visible Verification Result**: The video demo shows live WebRTC preview and Human detection results from the same realtime pipeline used in the live view.

### 🎙️ Audio ASR Module (`src/modules/audio-asr`)
- **Audio Companion Demo**: `bun run dev:audio` starts the audio-only runtime and opens `/demo/audio`.
- **Audio View**: The audio demo shows live speech-to-text output, audio level, and transcript history from the realtime socket.

### 🧠 Brain & AI (`@modules/brain`)
- **HomeBrain**: The core logic engine using Ollama with `qwen2.5:7b` for normal voice dialogue and `qwen2.5vl:7b` only for explicit vision requests.
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
- **Python Service Scripts**: `bun run python-services:setup`, `bun run python-services:start`, and `bun run python-services:status` manage local FastAPI helpers under `src/server/python_services`.
- **WebRTC**: Real-time video/audio streaming via WebRTC (UDP).
- **Frequency Control**: `WiseRelex` (DetectionValve) manages AI inference frequency to optimize CPU usage.
- **Identity Verification**: Camera recognition context is passed to `HomeBrain` with `identityVerification`, `similarity`, and threshold details before command execution.
- **Always-on Listening Path**: Voice signal collection and realtime transcription are enabled by default after startup; there is no frontend subtitle toggle gate.

### 📊 Dashboard & Logs (`src/components`, `src/server/services`)
- **Service Dashboard**: `DashboardView` and `DashboardService` surface runtime health, local service status, and start/stop controls for managed helpers.
- **Pipeline Logs**: `LogsView` and `PipelineLogService` connect pipeline events, model calls, incidents, and runtime service logs in one review surface.
- **Environment Loader**: `src/config/loadEnv.ts` loads `.env` plus environment-specific overrides before the app reads runtime configuration.

---

## Current Source Layout

```txt
src/
  components/
    live/                     # Reusable realtime/demo page panels
    MemoryView.tsx            # Conversation and approved-memory management UI
    LogsView.tsx              # Pipeline, model call, incident, and service log review UI
    VoiceControlView.tsx      # CosyVoice speaker material extraction and TTS profile UI
  config/                     # Runtime and browser-facing config helpers
  demos/                      # Lightweight pathname-based demo router
  modules/
    video-recognition/        # Real-time video demo entry
    audio-asr/                # Real-time audio ASR demo entry
  shared/
    ui/                       # Shared module UI wrappers
  server/
    prompts/                  # Centralized Chinese/English prompt text
    observability/            # Model trace logging helpers
    services/                 # Dashboard, FunASR, CosyVoice material, pipeline log, and benchmark services
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
- [x] Startup-time Voice Signal Collection
- [x] CosyVoice MLX TTS with reusable speaker material profiles
- [x] Dashboard controls for managed local services
- [x] Pipeline log, model call, incident, and benchmark review UI
- [x] Dynamic Intention Analysis with Memory Retrieval Decisions
- [x] Long-term Memory Retrieval (`semantic`, `recent_recall`, `hybrid`, `none`)
- [x] Memory Recall + Current-session Follow-up Intent Handling
- [x] Memory Management UI for Sessions and Approved Memories
- [x] Centralized Prompt Management
- [x] Standalone Real-time Video and Audio Demo Modes
- [x] Automated Performance Monitoring
- [x] Privacy Audit Completed (No hardcoded secrets)

---

## Troubleshooting
- **FFmpeg Pixel Format Warning**: Expected on macOS `avfoundation`. The system automatically falls back to `uyvy422` with no performance loss.
- **Microphone Echo**: If the AI hears itself, ensure the `systemSpeaking` lock is enabled in `monitor.ts` (default: ON).
- **Voice Conversation Not Starting**: Voice transcription is enabled by default after startup. Check FunASR logs and microphone permission first; there is no subtitle switch to enable.
- **CosyVoice Not Speaking**: Run `bun run python-services:status`, confirm `COSYVOICE_BASE_URL` points to the local service, verify `COSYVOICE_MODEL_DIR` contains `config.json`, and verify the selected prompt audio path is under `data/voice`.
- **CosyVoice Material Import Fails**: Install or refresh yt-dlp with the voice control UI or `bun run src/server/scripts/install_yt_dlp.ts`, then retry with a direct media URL.
- **Dashboard Service Won't Start**: Check the service log in `DashboardView`, verify the target binary is installed, and confirm the relevant path is allowed by the local config.
- **Pipeline Logs Look Empty**: The logs are created when pipeline, model, service, or incident events are recorded; run a normal voice or memory flow first.
- **Model Initialization**: Ensure `qwen2.5:7b` and `qwen2.5vl:7b` are available in Ollama; normal voice dialogue uses the text model, while vision is on demand.
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
