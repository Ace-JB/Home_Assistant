#!/usr/bin/env python3
import asyncio
import gc
import glob
import io
import os
import shutil
import tempfile
import time
import wave
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI(title="Home Assistant CosyVoice Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TTS_MODEL = None
STARTED_AT: float | None = None
LAST_ERROR: str | None = None
SPEAKERS: dict[str, dict[str, str]] = {}
MIN_PROMPT_TEXT_CHARS = 6
INFERENCE_LOCK = asyncio.Lock()
TRIM_DB_EPSILON = 1e-5
DEFAULT_COSYVOICE_MODEL_DIR = "data/python_services/models_cache/cosyvoice/Fun-CosyVoice3-0.5B-2512-4bit"


def service_root() -> Path:
    return Path(os.environ.get("PYTHON_SERVICES_ROOT", "data/python_services")).resolve()


def cache_dir() -> Path:
    cache = service_root() / "models_cache" / "cosyvoice" / "speaker-cache"
    cache.mkdir(parents=True, exist_ok=True)
    return cache


def model_dir() -> Path:
    return Path(os.environ.get("COSYVOICE_MODEL_DIR", DEFAULT_COSYVOICE_MODEL_DIR)).resolve()


def validate_model_dir(path: Path) -> Path:
    if not (path / "config.json").is_file():
        raise RuntimeError(
            f"CosyVoice model config not found at {path}. "
            "Run: bun run python-services:setup cosyvoice"
        )
    return path


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ("0", "false", "no", "off", "")


def configure_hf_offline_mode():
    if env_bool("COSYVOICE_HF_OFFLINE", True):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")


def env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def ensure_started():
    global TTS_MODEL, STARTED_AT, LAST_ERROR
    if TTS_MODEL is not None:
        return
    try:
        configure_hf_offline_mode()
        from mlx_audio.tts.utils import load_model
        resolved_model_dir = validate_model_dir(model_dir())
        print(f"[CosyVoice] loading model={resolved_model_dir}", flush=True)
        TTS_MODEL = load_model(str(resolved_model_dir))
        STARTED_AT = time.time()
        LAST_ERROR = None
    except Exception as exc:
        LAST_ERROR = str(exc)
        raise


def stop_model():
    global TTS_MODEL, STARTED_AT
    TTS_MODEL = None
    STARTED_AT = None
    gc.collect()


def safe_speaker_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in value.strip())
    return cleaned[:96]


def count_spoken_chars(value: str) -> int:
    return len("".join(value.split()))


def validate_prompt_text(prompt_text: str):
    if count_spoken_chars(prompt_text) < MIN_PROMPT_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"prompt_text must contain at least {MIN_PROMPT_TEXT_CHARS} spoken characters",
        )


def save_upload_to_path(upload: UploadFile, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    upload.file.seek(0)
    with path.open("wb") as output:
        shutil.copyfileobj(upload.file, output)


def find_generated_wav(prefix: Path) -> Path:
    exact = Path(f"{prefix}.wav")
    if exact.is_file():
        return exact
    candidates = [Path(item) for item in glob.glob(f"{prefix}*.wav") if Path(item).is_file()]
    if not candidates:
        raise RuntimeError(f"mlx_audio did not generate a wav file for prefix {prefix}")
    return max(candidates, key=lambda item: item.stat().st_mtime)


def generate_wav(tts_text: str, ref_audio: str, ref_text: str) -> bytes:
    configure_hf_offline_mode()
    from mlx_audio.tts.generate import generate_audio

    request_dir = Path(tempfile.mkdtemp(prefix="ha-cosyvoice-mlx-"))
    output_prefix = request_dir / "speech"
    started_at = time.time()
    try:
        result = generate_audio(
            text=tts_text,
            model=TTS_MODEL,
            ref_audio=ref_audio,
            ref_text=ref_text,
            file_prefix=str(output_prefix),
            audio_format="wav",
            lang_code="zh",
            verbose=True,
        )
        output_path = Path(result) if isinstance(result, (str, os.PathLike)) and Path(result).is_file() else find_generated_wav(output_prefix)
        audio = output_path.read_bytes()
        elapsed_ms = int((time.time() - started_at) * 1000)
        print(f"[CosyVoice] inference ok chars={len(tts_text)} bytes={len(audio)} ms={elapsed_ms}", flush=True)
        return audio
    finally:
        shutil.rmtree(request_dir, ignore_errors=True)


def trim_wav_silence(
    audio: bytes,
    threshold_db: float | None = None,
    frame_ms: int | None = None,
    head_pad_ms: int | None = None,
    tail_pad_ms: int | None = None,
) -> bytes:
    if not env_bool("COSYVOICE_TRIM_SILENCE", True):
        return audio

    threshold = threshold_db if threshold_db is not None else env_float("COSYVOICE_TRIM_THRESHOLD_DB", -42.0)
    frame_duration_ms = max(1, frame_ms if frame_ms is not None else env_int("COSYVOICE_TRIM_FRAME_MS", 10))
    head_padding_ms = max(0, head_pad_ms if head_pad_ms is not None else env_int("COSYVOICE_TRIM_HEAD_PAD_MS", 50))
    tail_padding_ms = max(0, tail_pad_ms if tail_pad_ms is not None else env_int("COSYVOICE_TRIM_TAIL_PAD_MS", 110))

    try:
        import numpy as np

        with wave.open(io.BytesIO(audio), "rb") as wav:
            params = wav.getparams()
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frame_count = wav.getnframes()
            compression = wav.getcomptype()
            raw_data = wav.readframes(frame_count)

        if compression != "NONE" or sample_width != 2 or channels < 1 or sample_rate <= 0 or frame_count <= 0:
            print(
                f"[CosyVoice] trim fallback reason=unsupported_format channels={channels} width={sample_width} rate={sample_rate} comp={compression}",
                flush=True,
            )
            return audio

        samples = np.frombuffer(raw_data, dtype=np.int16)
        if samples.size == 0:
            print("[CosyVoice] trim fallback reason=empty_pcm", flush=True)
            return audio
        if samples.size % channels != 0:
            print("[CosyVoice] trim fallback reason=misaligned_channels", flush=True)
            return audio

        pcm = samples.reshape(-1, channels)
        frame_size = max(1, int(sample_rate * frame_duration_ms / 1000))
        analysis_frame_count = pcm.shape[0] // frame_size
        if analysis_frame_count <= 0:
            print("[CosyVoice] trim fallback reason=too_short", flush=True)
            return audio

        analysis_samples = pcm[:analysis_frame_count * frame_size].reshape(analysis_frame_count, frame_size, channels)
        rms_per_frame = np.sqrt(np.mean(analysis_samples.astype(np.float64) ** 2, axis=(1, 2)))
        normalized_rms = rms_per_frame / 32768.0
        db_per_frame = 20 * np.log10(normalized_rms + TRIM_DB_EPSILON)
        active_frames = np.where(db_per_frame > threshold)[0]
        if active_frames.size == 0:
            print("[CosyVoice] trim fallback reason=pure_silence", flush=True)
            return audio

        head_pad_frames = int(head_padding_ms / frame_duration_ms)
        tail_pad_frames = int(tail_padding_ms / frame_duration_ms)
        start_frame = max(0, int(active_frames[0]) - head_pad_frames)
        end_frame = min(analysis_frame_count, int(active_frames[-1]) + tail_pad_frames + 1)
        start_sample = start_frame * frame_size
        end_sample = min(pcm.shape[0], end_frame * frame_size)
        if start_sample <= 0 and end_sample >= pcm.shape[0]:
            print("[CosyVoice] trim skipped reason=no_silence_detected", flush=True)
            return audio
        if end_sample <= start_sample:
            print("[CosyVoice] trim fallback reason=empty_after_trim", flush=True)
            return audio

        trimmed_pcm = pcm[start_sample:end_sample].reshape(-1)
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setparams(params)
            wav.setnframes(trimmed_pcm.size // channels)
            wav.writeframes(trimmed_pcm.astype(np.int16, copy=False).tobytes())

        original_ms = frame_count / sample_rate * 1000
        trimmed_ms = (trimmed_pcm.size // channels) / sample_rate * 1000
        head_trim_ms = start_sample / sample_rate * 1000
        tail_trim_ms = max(0.0, (pcm.shape[0] - end_sample) / sample_rate * 1000)
        print(
            "[CosyVoice] trim ok "
            f"originalMs={round(original_ms)} trimmedMs={round(trimmed_ms)} "
            f"headTrimMs={round(head_trim_ms)} tailTrimMs={round(tail_trim_ms)} "
            f"thresholdDb={threshold} headPadMs={head_padding_ms} tailPadMs={tail_padding_ms}",
            flush=True,
        )
        return output.getvalue()
    except Exception as exc:
        print(f"[CosyVoice] trim fallback reason={type(exc).__name__}: {exc}", flush=True)
        return audio


@app.get("/health")
async def health():
    sample_rate = getattr(TTS_MODEL, "sample_rate", 24000) if TTS_MODEL is not None else 24000
    return {
        "ok": TTS_MODEL is not None,
        "ready": TTS_MODEL is not None,
        "backend": "mlx",
        "pid": os.getpid(),
        "model": model_dir(),
        "sample_rate": sample_rate,
        "startedAt": int(STARTED_AT * 1000) if STARTED_AT else None,
        "uptimeSeconds": int(time.time() - STARTED_AT) if STARTED_AT else None,
        "speakers": len(SPEAKERS),
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


@app.post("/cleanup")
async def cleanup():
    for pattern in ("ha-cosyvoice-request-*", "ha-cosyvoice-mlx-*"):
        for item in Path(tempfile.gettempdir()).glob(pattern):
            shutil.rmtree(item, ignore_errors=True)
    return {"ok": True}


@app.post("/speaker/cache")
async def cache_zero_shot_speaker(
    zero_shot_spk_id: str = Form(),
    prompt_text: str = Form(),
    prompt_wav: UploadFile = File(),
):
    try:
        speaker_id = safe_speaker_id(zero_shot_spk_id)
        if not speaker_id:
            raise HTTPException(status_code=400, detail="zero_shot_spk_id is required")
        if not prompt_text.strip():
            raise HTTPException(status_code=400, detail="prompt_text is required")
        validate_prompt_text(prompt_text)
        prompt_path = cache_dir() / f"{speaker_id}.wav"
        meta_path = cache_dir() / f"{speaker_id}.txt"
        save_upload_to_path(prompt_wav, prompt_path)
        meta_path.write_text(prompt_text, encoding="utf-8")
        SPEAKERS[speaker_id] = {"prompt_text": prompt_text, "prompt_wav": str(prompt_path)}
        return {"ok": True, "backend": "mlx", "zero_shot_spk_id": speaker_id}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/inference_zero_shot")
async def inference_zero_shot(
    tts_text: str = Form(),
    prompt_text: str = Form(""),
    zero_shot_spk_id: str = Form(""),
    prompt_wav: UploadFile | None = File(None),
):
    ensure_started()
    text = tts_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="tts_text is required")

    speaker_id = safe_speaker_id(zero_shot_spk_id)
    request_dir = Path(tempfile.mkdtemp(prefix="ha-cosyvoice-request-"))
    try:
        if speaker_id:
            speaker = SPEAKERS.get(speaker_id)
            prompt_path = cache_dir() / f"{speaker_id}.wav"
            meta_path = cache_dir() / f"{speaker_id}.txt"
            if speaker is None and prompt_path.is_file() and meta_path.is_file():
                speaker = {"prompt_wav": str(prompt_path), "prompt_text": meta_path.read_text(encoding="utf-8")}
                SPEAKERS[speaker_id] = speaker
            if speaker is None:
                raise HTTPException(status_code=404, detail=f"zero_shot_spk_id not cached: {speaker_id}")
            ref_audio = speaker["prompt_wav"]
            ref_text = speaker["prompt_text"]
        else:
            if prompt_wav is None:
                raise HTTPException(status_code=400, detail="prompt_wav is required when zero_shot_spk_id is empty")
            if not prompt_text.strip():
                raise HTTPException(status_code=400, detail="prompt_text is required")
            validate_prompt_text(prompt_text)
            prompt_path = request_dir / "prompt.wav"
            save_upload_to_path(prompt_wav, prompt_path)
            ref_audio = str(prompt_path)
            ref_text = prompt_text

        async with INFERENCE_LOCK:
            audio = await asyncio.to_thread(generate_wav, text, ref_audio, ref_text)
        audio = trim_wav_silence(audio)
        return Response(
            content=audio,
            media_type="audio/wav",
            headers={
                "X-CosyVoice-Backend": "mlx",
                "X-CosyVoice-Sample-Rate": "24000",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        shutil.rmtree(request_dir, ignore_errors=True)
