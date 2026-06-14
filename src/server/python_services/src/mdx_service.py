#!/usr/bin/env python3
import gc
import logging
import os
import platform
import shutil
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Home Assistant MDX Service")

SEPARATOR = None
MODEL = ""
PROVIDERS: list[str] = []
STARTED_AT: float | None = None
LAST_ERROR: str | None = None
BUSY = False


class SeparateRequest(BaseModel):
    inputPath: str
    outputPath: str


def service_root() -> Path:
    return Path(os.environ.get("PYTHON_SERVICES_ROOT", "data/python_services")).resolve()


def model_dir() -> Path:
    raw = os.environ.get("VOICE_SEPARATION_MODEL_DIR")
    path = Path(raw).resolve() if raw else service_root() / "models_cache" / "mdx"
    path.mkdir(parents=True, exist_ok=True)
    return path


def choose_providers(raw: str, device: str) -> list[str]:
    providers = [item.strip() for item in raw.split(",") if item.strip()]
    if device == "cpu":
        return ["CPUExecutionProvider"]
    if device in ("auto", "mps") and platform.system() == "Darwin" and platform.machine() == "arm64":
        return providers or ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    return providers or ["CPUExecutionProvider"]


def resolve_model() -> str:
    explicit = os.environ.get("VOICE_SEPARATION_MODEL", "").strip()
    if explicit:
        return explicit
    profile = os.environ.get("VOICE_SEPARATION_MODEL_PROFILE", "balanced")
    return {
        "fast": "UVR-MDX-NET-Inst_Main.onnx",
        "balanced": "UVR-MDX-NET-Inst_HQ_3.onnx",
        "quality": "Kim_Vocal_2.onnx",
    }.get(profile, "UVR-MDX-NET-Inst_HQ_3.onnx")


def resolve_model_path(model_name: str, directory: Path) -> Path:
    candidate = Path(model_name)
    path = candidate if candidate.is_absolute() else directory / candidate
    resolved = path.resolve()
    if not resolved.is_file():
        raise RuntimeError(
            f"MDX offline mode requires local model file {resolved}. "
            "Place the ONNX model in VOICE_SEPARATION_MODEL_DIR before starting the service."
        )
    return resolved


def ensure_started():
    global SEPARATOR, MODEL, PROVIDERS, STARTED_AT, LAST_ERROR
    if SEPARATOR is not None:
        return
    try:
        from audio_separator.separator import Separator
    except Exception as exc:
        raise RuntimeError(f"audio-separator import failed in mdx_env: {exc}") from exc

    try:
        MODEL = resolve_model()
        PROVIDERS = choose_providers(
            os.environ.get("VOICE_SEPARATION_ONNX_PROVIDERS", "CoreMLExecutionProvider,CPUExecutionProvider"),
            os.environ.get("VOICE_SEPARATION_DEVICE", os.environ.get("PYTHON_SERVICES_DEVICE", "mps")),
        )
        cache = model_dir()
        model_path = resolve_model_path(MODEL, cache)
        MODEL = model_path.name if model_path.parent == cache.resolve() else str(model_path)
        SEPARATOR = Separator(
            output_dir=str(cache),
            model_file_dir=str(cache),
            log_level=logging.ERROR,
        )
        SEPARATOR.load_model(model_filename=MODEL)
        STARTED_AT = time.time()
        LAST_ERROR = None
    except Exception as exc:
        LAST_ERROR = str(exc)
        traceback.print_exc()
        raise


def stop_model():
    global SEPARATOR, STARTED_AT
    SEPARATOR = None
    STARTED_AT = None
    gc.collect()


def find_vocal_output(search_dirs: list[Path], outputs, started_at: float) -> Path | None:
    candidates: list[Path] = []
    if isinstance(outputs, list):
        for item in outputs:
            output_item = Path(str(item))
            if not is_vocal_output(output_item):
                continue
            if output_item.is_absolute():
                candidates.append(output_item)
            for directory in search_dirs:
                candidates.append(directory / output_item)
    for directory in search_dirs:
        candidates.extend(directory.glob("*Vocals*.wav"))
        candidates.extend(directory.glob("*vocals*.wav"))
        candidates.extend(directory.glob("*vocal*.wav"))

    seen: set[Path] = set()
    unique_candidates: list[Path] = []
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique_candidates.append(resolved)

    for candidate in sorted(unique_candidates, key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True):
        if candidate.exists() and candidate.is_file() and is_vocal_output(candidate) and candidate.stat().st_mtime >= started_at - 1:
            return candidate
    return None


def is_vocal_output(path: Path) -> bool:
    name = path.name.lower()
    return ("vocal" in name or "vocals" in name) and "instrumental" not in name and "no_vocal" not in name


@app.get("/health")
async def health():
    return {
        "ok": SEPARATOR is not None,
        "ready": SEPARATOR is not None,
        "busy": BUSY,
        "pid": os.getpid(),
        "startedAt": int(STARTED_AT * 1000) if STARTED_AT else None,
        "uptimeSeconds": int(time.time() - STARTED_AT) if STARTED_AT else None,
        "model": MODEL or resolve_model(),
        "onnxProviders": PROVIDERS or choose_providers(
            os.environ.get("VOICE_SEPARATION_ONNX_PROVIDERS", "CoreMLExecutionProvider,CPUExecutionProvider"),
            os.environ.get("VOICE_SEPARATION_DEVICE", os.environ.get("PYTHON_SERVICES_DEVICE", "mps")),
        ),
        "queueLength": 1 if BUSY else 0,
        "lastError": LAST_ERROR,
    }


@app.post("/start")
async def start():
    try:
        ensure_started()
        return await health()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/stop")
async def stop():
    stop_model()
    return {"ok": True, "ready": False, "pid": os.getpid()}


@app.post("/separate")
async def separate(request: SeparateRequest):
    global BUSY, LAST_ERROR
    ensure_started()
    input_path = Path(request.inputPath).resolve()
    output_path = Path(request.outputPath).resolve()
    if not input_path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {input_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = output_path.parent / f".mdx-{int(time.time() * 1000)}"
    work_dir.mkdir(parents=True, exist_ok=True)
    started_at = time.time()
    try:
        BUSY = True
        assert SEPARATOR is not None
        SEPARATOR.output_dir = str(work_dir)
        outputs = SEPARATOR.separate(str(input_path))
        produced = find_vocal_output([work_dir, model_dir()], outputs, started_at)
        if produced is None:
            raise RuntimeError("MDX-Net did not produce a vocal output file.")
        shutil.copyfile(produced, output_path)
        return {
            "ok": True,
            "outputPath": str(output_path),
            "model": MODEL,
            "onnxProviders": PROVIDERS,
            "durationMs": round((time.time() - started_at) * 1000),
        }
    except Exception as exc:
        LAST_ERROR = str(exc)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        BUSY = False
        shutil.rmtree(work_dir, ignore_errors=True)
