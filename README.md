# Home Assistant

# Performance Snapshot (May 7, 2026)

Based on the automated test run, here are the current performance metrics for the system:

| Component | Operation | Avg. Duration | Note |
| :--- | :--- | :--- | :--- |
| **FaceEngine** | `loadModels` | **218.76 ms** | One-time startup |
| **FaceEngine** | `extractDescriptor` | **103.26 ms** | Per-face feature extraction |
| **FaceEngine** | `recognizeFaces` | **57.21 ms** | Full detection pass |
| **SyncManager** | `addVideo` | **0.05 ms** | Ring buffer overhead |
| **Socket** | `calculatePcmLevel` | **0.42 ms** | 1s audio volume analysis |
| **MediaSave** | `safeSave` | **642.10 ms** | 5-frame MP4 synthesis |
| **VoiceUtils** | `normalize` | **0.89 ms** | Text cleanup |

## Hardware Info
- **TensorFlow Backend**: TensorFlow Node (CPU/Accelerator)
- **FFmpeg**: v8.1.1 or compatible
- **Bun Runtime**: v1.3.13

Local Bun + React app for a home monitoring assistant. The frontend is served
from `src/index.html`; runtime modules for camera, audio, sync buffering, face
recognition, and emergency recording live under `src/server`.

To install dependencies:

```bash
bun install
```

To start a development server:

```bash
bun dev
```

To run static checks and a production build:

```bash
bun run check
```

To run for production:

```bash
bun start
```


# Implementation Plan - Automated Testing & Performance Monitoring

This plan outlines the strategy for adding automated test cases and performance tracking to the `server` directory.

## 1. Testing Framework
We use **Bun's built-in test runner (`bun test`)** as it is already integrated into the project and offers high performance.

## 2. Components to Test
### Modules
- **`media/SyncManager`**: Test buffer management, window cleaning, and snapshot retrieval.
- **`media/face/FaceEngine`**: Test model loading, descriptor extraction, and face identification performance.

### Tools
- **`Voice`**: Test transcript normalization and (optionally) Whisper transcription performance.
- **`Socket`**: Test PCM level calculation and message serialization.
- **`Queue`**: Test sequential task processing.
- **`Async_Voice_Video`**: Test MP4 synthesis performance and fallback logic.
- **`WiseRelex`**: Test `DetectionValve` frequency control.

## 3. Performance Monitoring
- Created `measurePerformance` utility in `src/server/test/performance_utils.ts`.
- Integrated performance logs into every test case.
- Added `test:perf` script to `package.json` for extended timeouts during heavy AI tests.

## 4. Test Structure
Tests are located in `src/server/test/`:
- `sync_manager.test.ts`
- `face_engine.test.ts`
- `voice_utils.test.ts`
- `socket.test.ts`
- `queue.test.ts`
- `media_save.test.ts`
- `detection_valve.test.ts`

## 5. Assets
- A sample face image `test_face.png` is provided in `src/server/test/assets/` for consistent AI benchmarking.


# Walkthrough - Running Tests & Performance Metrics

I have added a comprehensive testing suite to the `server` directory. This guide explains how to run them and what the metrics mean.

## 1. Quick Start
To run all tests and see the performance report:
```bash
npm run test
```
Or use the high-timeout version for AI-heavy tasks:
```bash
npm run test:perf
```

## 2. Test Suites
Each suite targets a specific area of the system:

### 🧠 AI Engine Performance (`face_engine.test.ts`)
Measures how long it takes to:
- **Load Models**: Warmup time for TensorFlow and Human.js.
- **Extract Descriptor**: Time to turn an image into a 128D vector.
- **Recognize Faces**: End-to-end detection and identification.

### 🎥 Media Pipeline (`sync_manager.test.ts`, `media_save.test.ts`)
Measures the efficiency of:
- **Ring Buffer**: Adding frames and cleaning old data.
- **MP4 Synthesis**: How fast FFmpeg can stitch together JPEGs and PCM audio.

### 🎙️ Voice & Communication (`voice_utils.test.ts`, `socket.test.ts`)
Tests:
- **Transcript Cleanup**: Removing Whisper hallucinations.
- **Audio Processing**: Calculating RMS/Peak levels for the UI volume meter.

## 3. Understanding the Output
Look for `[Performance]` tags in the terminal output:
- `[Performance] FaceEngine.recognizeFaces took 44.43ms`
- `[Performance] Async_Voice_Video.safeSave took 620.15ms`

## 4. Troubleshooting
- **No faces detected**: Ensure the test image `src/server/test/assets/test_face.png` exists and contains a clear face.
- **FFmpeg errors**: Ensure `ffmpeg` is installed and accessible in your path.
- **Model not found**: Run `npm run download_models` to ensure all weights are present.

