import argparse
import asyncio
import glob
import logging
import os
import shutil
import tempfile
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from mlx_audio.tts.generate import generate_audio
from mlx_audio.tts.utils import load_model


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50000)
    parser.add_argument("--model_dir", type=str, default="mlx-community/Fun-CosyVoice3-0.5B-2512-4bit")
    parser.add_argument("--cache_dir", type=str, default="data/cosyvoice/mlx-speaker-cache")
    return parser.parse_args()


args = parse_args()
cache_dir = Path(args.cache_dir).resolve()
cache_dir.mkdir(parents=True, exist_ok=True)
logging.getLogger("matplotlib").setLevel(logging.WARNING)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

speakers: dict[str, dict[str, str]] = {}
MIN_PROMPT_TEXT_CHARS = 6
inference_lock = asyncio.Lock()
print(f"[CosyVoiceMLX] loading model={args.model_dir}", flush=True)
tts_model = load_model(args.model_dir)
print(f"[CosyVoiceMLX] model_loaded sample_rate={tts_model.sample_rate}", flush=True)


def save_upload_to_path(upload: UploadFile, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    upload.file.seek(0)
    with path.open("wb") as output:
        shutil.copyfileobj(upload.file, output)


def safe_speaker_id(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in value.strip())
    return cleaned[:96]


def read_audio_bytes(path: Path) -> bytes:
    return path.read_bytes()


def count_spoken_chars(value: str) -> int:
    return len("".join(value.split()))


def validate_prompt_text(prompt_text: str):
    if count_spoken_chars(prompt_text) < MIN_PROMPT_TEXT_CHARS:
        raise HTTPException(
            status_code=400,
            detail=f"prompt_text must contain at least {MIN_PROMPT_TEXT_CHARS} spoken characters",
        )


def find_generated_wav(prefix: Path) -> Path:
    exact = Path(f"{prefix}.wav")
    if exact.is_file():
        return exact

    candidates = [
        Path(item)
        for item in glob.glob(f"{prefix}*.wav")
        if Path(item).is_file()
    ]
    if not candidates:
        raise RuntimeError(f"mlx_audio did not generate a wav file for prefix {prefix}")
    return max(candidates, key=lambda item: item.stat().st_mtime)


def generate_wav(tts_text: str, ref_audio: str, ref_text: str) -> bytes:
    request_dir = Path(tempfile.mkdtemp(prefix="ha-cosyvoice-mlx-"))
    output_prefix = request_dir / "speech"
    started_at = time.time()
    try:
        result = generate_audio(
            text=tts_text,
            model=tts_model,
            ref_audio=ref_audio,
            ref_text=ref_text,
            file_prefix=str(output_prefix),
            audio_format="wav",
            lang_code="zh",
            verbose=True,
        )

        if isinstance(result, (str, os.PathLike)) and Path(result).is_file():
            output_path = Path(result)
        else:
            output_path = find_generated_wav(output_prefix)

        audio = read_audio_bytes(output_path)
        elapsed_ms = int((time.time() - started_at) * 1000)
        print(f"[CosyVoiceMLX] inference ok chars={len(tts_text)} bytes={len(audio)} ms={elapsed_ms}", flush=True)
        return audio
    finally:
        shutil.rmtree(request_dir, ignore_errors=True)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "backend": "mlx",
        "model": args.model_dir,
        "sample_rate": 24000,
        "speakers": len(speakers),
    }


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

        prompt_path = cache_dir / f"{speaker_id}.wav"
        meta_path = cache_dir / f"{speaker_id}.txt"
        save_upload_to_path(prompt_wav, prompt_path)
        meta_path.write_text(prompt_text, encoding="utf-8")
        speakers[speaker_id] = {
            "prompt_text": prompt_text,
            "prompt_wav": str(prompt_path),
        }
        print(f"[CosyVoiceMLX] speaker_cache ok id={speaker_id} audio={prompt_path}", flush=True)
        return {"ok": True, "backend": "mlx", "zero_shot_spk_id": speaker_id}
    except HTTPException:
        raise
    except Exception as error:
        print(f"[CosyVoiceMLX] speaker_cache failed id={zero_shot_spk_id}: {error}", flush=True)
        raise HTTPException(status_code=500, detail=str(error)) from error


@app.post("/inference_zero_shot")
async def inference_zero_shot(
    tts_text: str = Form(),
    prompt_text: str = Form(""),
    zero_shot_spk_id: str = Form(""),
    prompt_wav: UploadFile | None = File(None),
):
    text = tts_text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="tts_text is required")

    speaker_id = safe_speaker_id(zero_shot_spk_id)
    temp_prompt_path = ""
    if speaker_id:
        speaker = speakers.get(speaker_id)
        prompt_path = cache_dir / f"{speaker_id}.wav"
        meta_path = cache_dir / f"{speaker_id}.txt"
        if speaker is None and prompt_path.is_file() and meta_path.is_file():
            speaker = {
                "prompt_wav": str(prompt_path),
                "prompt_text": meta_path.read_text(encoding="utf-8"),
            }
            speakers[speaker_id] = speaker
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
        temp_file = tempfile.NamedTemporaryFile(prefix="ha-cosyvoice-mlx-prompt-", suffix=".wav", delete=False)
        temp_prompt_path = temp_file.name
        temp_file.close()
        save_upload_to_path(prompt_wav, Path(temp_prompt_path))
        ref_audio = temp_prompt_path
        ref_text = prompt_text

    try:
        async with inference_lock:
            audio = await asyncio.to_thread(generate_wav, text, ref_audio, ref_text)
    except Exception as error:
        print(f"[CosyVoiceMLX] inference failed chars={len(text)} speaker={speaker_id or 'inline'} error={error}", flush=True)
        raise HTTPException(status_code=500, detail=str(error)) from error
    finally:
        if temp_prompt_path:
            try:
                os.unlink(temp_prompt_path)
            except OSError:
                pass

    return Response(
        content=audio,
        media_type="audio/wav",
        headers={
            "X-CosyVoice-Backend": "mlx",
            "X-CosyVoice-Sample-Rate": "24000",
        },
    )


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=args.port)
