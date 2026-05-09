# Home Assistant - Sentinel

# Performance Snapshot (May 9, 2026) ✅

The system has been verified with **14 automated tests** passing at 100%. Below are the current performance metrics:

| Component | Operation | Avg. Duration | Note |
| :--- | :--- | :--- | :--- |
| **FaceEngine** | `loadModels` | **276.88 ms** | One-time startup / Warmup |
| **FaceEngine** | `extractDescriptor` | **119.73 ms** | Per-face feature extraction |
| **FaceEngine** | `recognizeFaces` | **50.80 ms** | Full multi-face detection pass |
| **SyncManager** | `addVideo` | **0.13 ms** | Ring buffer push overhead |
| **Socket** | `calculatePcmLevel` | **0.40 ms** | 1s audio volume analysis |
| **MediaSave** | `safeSave` | **139.93 ms** | Optimized MP4 synthesis |
| **VoiceUtils** | `normalize` | **0.15 ms** | Text cleanup & VAD filtering |

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

# Run tests and generate HTML report
bun run test:report
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
