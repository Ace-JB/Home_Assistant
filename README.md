# Home Assistant - Sentinel

# Performance Snapshot (May 12, 2026) ✅

The system has been verified with **18 automated tests** passing at 100%. Below are the latest local performance metrics from the server test suite:

| Component | Operation | Avg. Duration | Note |
| :--- | :--- | :--- | :--- |
| **FaceEngine** | `loadModels` | **223.33 ms** | One-time startup / warmup |
| **FaceEngine** | `extractDescriptor` | **104.23 ms** | Per-face feature extraction |
| **FaceEngine** | `recognizeFaces` | **49.77 ms** | Detection plus similarity-based identity check |
| **SyncManager** | `addVideo` | **0.19 ms** | Batched expiry cleanup / frame push overhead |
| **Socket** | `calculatePcmLevel` | **0.94 ms** | 1s audio volume analysis |
| **MediaSave** | `safeSave` | **133.15 ms** | Optimized MP4 synthesis |
| **VoiceUtils** | `normalize` | **<1 ms** | Text cleanup & VAD filtering |

Latest verification command:

```bash
bun test src/server/test/*.test.ts --timeout 60000
```

Result: **18 pass / 0 fail / 40 assertions** across 8 files in **2.53s**.

Generated reports:
- `test-report.html`
- `performance-report.json`

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
bun test src/server/test/*.test.ts --timeout 60000

# Run tests and generate HTML + JSON performance reports
bun src/server/test/generate_report.ts

# Type-check and build
./node_modules/.bin/tsc --noEmit
bun build.ts
```

---

## Architecture Overview

The project is structured into modular layers for maximum performance and maintainability:

### 🧠 Brain & AI (`@modules/brain`)
- **HomeBrain**: The core logic engine using Ollama (Qwen 2.5) for natural language understanding and tool calling.
- **FaceEngine**: Real-time face detection and identification using `Human.js` and TensorFlow.

### 🎥 Media Pipeline (`@modules/media`)
- **SyncManager**: Manages high-performance ring buffers for synchronized A/V streams.
- **Synthesizer**: Handles lazy MP4 synthesis via FFmpeg for emergency recording.

### 🎙️ Voice & Tools (`@server/tools`)
- **Voice**: Text-to-Speech (TTS) using macOS native voices and FunASR transcription.
- **WebRTC**: Real-time video/audio streaming via WebRTC (UDP).
- **Frequency Control**: `WiseRelex` (DetectionValve) manages AI inference frequency to optimize CPU usage.
- **Identity Verification**: Camera recognition context is passed to `HomeBrain` with `identityVerification`, `similarity`, and threshold details before command execution.

---

## Project Status: **Release Candidate v0.1.0**
- [x] WebRTC A/V Synchronization
- [x] Real-time Face Tracking
- [x] Multi-turn Voice Conversation (15s Wake Window)
- [x] Automated Performance Monitoring
- [x] Privacy Audit Completed (No hardcoded secrets)

---

## Troubleshooting
- **FFmpeg Pixel Format Warning**: Expected on macOS `avfoundation`. The system automatically falls back to `uyvy422` with no performance loss.
- **Microphone Echo**: If the AI hears itself, ensure the `systemSpeaking` lock is enabled in `monitor.ts` (default: ON).
- **Model Initialization**: Ensure you have at least 8GB of RAM for the `qwen2.5:7b` model running via Ollama.
- **Face Recognition Mismatch**: If logs show `candidateLabel` but low `similarity`, re-register the member with `bun src/server/scripts/register_face.ts --name master --camera`.
