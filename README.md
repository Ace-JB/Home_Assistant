# Home Assistant - Sentinel

<!-- TEST_REPORT_START -->
# Performance Snapshot (May 22, 2026) ✅

The system has been verified with **61 automated tests**. Below are the latest local performance metrics from the server test suite:

| Component | Operation | Duration | Note |
| :--- | :--- | :--- | :--- |
| **Async_Voice_Video** | `safeSave` | **138.25 ms** | Optimized MP4 synthesis |
| **FaceEngine** | `extractDescriptor` | **191.19 ms** | Per-face feature extraction |
| **FaceEngine** | `loadModels` | **380.39 ms** | One-time startup / warmup |
| **FaceEngine** | `recognizeFaces` | **54.31 ms** | Detection plus similarity-based identity check |
| **Queue** | `push` | **97.95 ms** | Sequential task queue overhead |
| **Socket** | `calculatePcmLevel` | **<1 ms** | Audio volume analysis |
| **SyncManager** | `addAudio` | **<1 ms** | Audio buffer push overhead |
| **SyncManager** | `addVideo` | **<1 ms** | Frame push overhead |

Latest verification command:

```bash
bun run test
```

Result: **61 pass / 0 fail / 176 assertions** across 12 files in **2.97s**.

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

### 2. Download AI Models
```bash
bun run download_models
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
- 视频模块启动后，浏览器默认进入 `/demo/video`
- 语音模块启动后，浏览器默认进入 `/demo/audio`
- `/demo` - demo 入口页
- `/demo/video` - 只看 WebRTC 回显 + Human 识别结果
- `/demo/audio` - 只看语音转文字 + 音量变化 + 历史文本

### 6. Environment Configuration
Copy `.env.example` to `.env` when local overrides are needed:

```bash
VITE_API_BASE_URL=http://localhost:3000
VITE_SOCKET_URL=ws://localhost:3001/ws/realtime
VITE_MODEL_BASE_PATH=/models
```

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
- **Voice**: Text-to-Speech (TTS) using macOS native voices and FunASR transcription.
- **WebRTC**: Real-time video/audio streaming via WebRTC (UDP).
- **Frequency Control**: `WiseRelex` (DetectionValve) manages AI inference frequency to optimize CPU usage.
- **Identity Verification**: Camera recognition context is passed to `HomeBrain` with `identityVerification`, `similarity`, and threshold details before command execution.
- **Always-on Listening Path**: Voice signal collection and realtime transcription are enabled by default after startup; there is no frontend subtitle toggle gate.

---

## Current Source Layout

```txt
src/
  components/
    live/                     # Reusable realtime/demo page panels
    MemoryView.tsx            # Conversation and approved-memory management UI
  config/                     # Runtime and browser-facing config helpers
  demos/                      # Lightweight pathname-based demo router
  modules/
    video-recognition/        # Real-time video demo entry
    audio-asr/                # Real-time audio ASR demo entry
  shared/
    ui/                       # Shared module UI wrappers
  server/
    prompts/                  # Centralized Chinese/English prompt text
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
- **Model Initialization**: Ensure `qwen2.5:7b` and `qwen2.5vl:7b` are available in Ollama; normal voice dialogue uses the text model, while vision is on demand.
- **Face Recognition Mismatch**: If logs show `candidateLabel` but low `similarity`, re-register the member with `bun src/server/scripts/register_face.ts --name master --camera`.
