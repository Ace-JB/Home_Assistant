#!/usr/bin/env python3
import gc
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Home Assistant FunASR Service")

MODEL = None
MATERIAL_MODEL = None
MATERIAL_FALLBACK_MODEL = None
STARTED_AT: float | None = None
LAST_ERROR: str | None = None


class AudioPathRequest(BaseModel):
    wavPath: str


def service_root() -> Path:
    return Path(os.environ.get("PYTHON_SERVICES_ROOT", "data/python_services")).resolve()


def model_cache() -> str:
    cache = service_root() / "models_cache" / "funasr"
    cache.mkdir(parents=True, exist_ok=True)
    return str(cache)


def resolve_model_name(model_name: str) -> str:
    cached = Path(model_cache()) / "models" / model_name
    if cached.is_dir():
        return str(cached)
    return model_name


def create_model(model_name: str, punc_model: str = "", spk_model: str = ""):
    os.environ["MODELSCOPE_CACHE"] = model_cache()
    os.environ["MODELSCOPE_LOG_LEVEL"] = "40"
    os.environ["FUNASR_LOG_LEVEL"] = "ERROR"
    from funasr import AutoModel

    kwargs = dict(
        model=resolve_model_name(model_name),
        model_revision="v2.0.4",
        vad_model=resolve_model_name("iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"),
        vad_model_revision="v2.0.4",
        disable_update=True,
        device="cpu",
        max_end_silence_time=1000,
        max_single_segment_time=100000,
    )
    if punc_model:
        kwargs["punc_model"] = resolve_model_name(punc_model)
        kwargs["punc_model_revision"] = "v2.0.4"
    if spk_model:
        kwargs["spk_model"] = resolve_model_name(spk_model)
        kwargs["spk_model_revision"] = "v2.0.2"
    return AutoModel(**kwargs)


def ensure_started():
    global MODEL, MATERIAL_MODEL, MATERIAL_FALLBACK_MODEL, STARTED_AT, LAST_ERROR
    if MODEL is not None:
        return
    try:
        model_name = os.environ.get("FUNASR_MODEL", "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
        material_model = os.environ.get("FUNASR_MATERIAL_MODEL", "iic/speech_paraformer-large-vad-punc_asr_nat-zh-cn-16k-common-vocab8404-pytorch")
        punc_model = os.environ.get("FUNASR_PUNC_MODEL", "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch")
        spk_model = os.environ.get("FUNASR_SPK_MODEL", "iic/speech_campplus_sv_zh-cn_16k-common")
        MODEL = create_model(model_name, punc_model, spk_model)
        if material_model and material_model != model_name:
            MATERIAL_MODEL = create_model(material_model, punc_model, spk_model)
            MATERIAL_FALLBACK_MODEL = create_model(material_model, punc_model, "")
        STARTED_AT = time.time()
        LAST_ERROR = None
    except Exception as exc:
        LAST_ERROR = str(exc)
        raise


def stop_models():
    global MODEL, MATERIAL_MODEL, MATERIAL_FALLBACK_MODEL, STARTED_AT
    MODEL = None
    MATERIAL_MODEL = None
    MATERIAL_FALLBACK_MODEL = None
    STARTED_AT = None
    gc.collect()


def normalize_segment(item: dict[str, Any], fallback_text: str = "") -> dict[str, Any]:
    text = str(item.get("text") or fallback_text or "").strip()
    start = item.get("start")
    end = item.get("end")
    timestamp = item.get("timestamp")
    if (start is None or end is None) and isinstance(timestamp, list) and timestamp:
        first = timestamp[0]
        last = timestamp[-1]
        if isinstance(first, list) and len(first) >= 2:
            start = first[0]
        if isinstance(last, list) and len(last) >= 2:
            end = last[1]
    return {
        "start_ms": int(start or 0),
        "end_ms": int(end or 0),
        "text": text,
        "spk": str(item.get("spk") or item.get("speaker") or "SPK0"),
        "confidence": item.get("confidence") or item.get("score"),
    }


def normalize_result(res):
    if not res:
        return {"text": "", "segments": [], "raw": []}
    first = res[0] if isinstance(res, list) and len(res) > 0 else res
    if not isinstance(first, dict):
        return {"text": "", "segments": [], "raw": res}
    text = str(first.get("text") or "").strip()
    raw_segments = first.get("sentence_info")
    if not isinstance(raw_segments, list):
        raw_segments = first.get("segments")
    if not isinstance(raw_segments, list):
        raw_segments = []
    segments = [normalize_segment(item) for item in raw_segments if isinstance(item, dict)]
    if not segments and text:
        segments = [normalize_segment(first, text)]
    return {"text": text, "segments": segments, "raw": res}


def generate_with_timestamps(model, audio_path: str, mode: str):
    try:
        cfg = {"batch_size_s": 300, "sentence_timestamp": True, "pred_timestamp": True}
        cfg["return_spk_res"] = mode == "material"
        return model.generate(input=audio_path, **cfg)
    except TypeError:
        return model.generate(input=audio_path, batch_size_s=300)


def material_analysis(audio_path: str):
    active_model = MATERIAL_MODEL if MATERIAL_MODEL is not None else MODEL
    if MATERIAL_FALLBACK_MODEL is None:
        return generate_with_timestamps(active_model, audio_path, "material")
    try:
        return generate_with_timestamps(active_model, audio_path, "material")
    except Exception as exc:
        if str(exc).strip("'") != "timestamp":
            raise
        return MATERIAL_FALLBACK_MODEL.generate(
            input=audio_path,
            batch_size_s=300,
            sentence_timestamp=True,
            pred_timestamp=True,
            return_spk_res=False,
        )


def validate_audio_path(wav_path: str) -> str:
    path = Path(wav_path).resolve()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    return str(path)


@app.get("/health")
async def health():
    uptime = int(time.time() - STARTED_AT) if STARTED_AT else None
    return {
        "ok": MODEL is not None,
        "ready": MODEL is not None,
        "pid": os.getpid(),
        "startedAt": int(STARTED_AT * 1000) if STARTED_AT else None,
        "uptimeSeconds": uptime,
        "queueLength": 0,
        "lastError": LAST_ERROR,
        "model": os.environ.get("FUNASR_MODEL", ""),
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
    stop_models()
    return {"ok": True, "ready": False, "pid": os.getpid()}


@app.post("/transcribe")
async def transcribe(request: AudioPathRequest):
    ensure_started()
    audio_path = validate_audio_path(request.wavPath)
    try:
        parsed = normalize_result(generate_with_timestamps(MODEL, audio_path, "text"))
        return {"ok": True, "text": parsed["text"], "raw": parsed["raw"]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/analyze-material")
async def analyze_material(request: AudioPathRequest):
    ensure_started()
    audio_path = validate_audio_path(request.wavPath)
    try:
        parsed = normalize_result(material_analysis(audio_path))
        parsed["ok"] = True
        return parsed
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
