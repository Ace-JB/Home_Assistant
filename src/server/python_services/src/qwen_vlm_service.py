import asyncio
import importlib.util
import io
import json
import os
import time
from pathlib import Path
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field


DEFAULT_MODEL_DIR = "data/python_services/models_cache/qwen-vlm"
STARTED_AT = time.time()
LAST_ERROR: str | None = None
METRIC_FIELDS = (
    "prompt_tokens",
    "generation_tokens",
    "total_tokens",
    "cached_tokens",
    "prompt_tps",
    "generation_tps",
    "peak_memory",
    "finish_reason",
)


def model_dir() -> Path:
    return Path(os.environ.get("QWEN_VLM_MODEL_DIR", DEFAULT_MODEL_DIR)).resolve()


def model_id() -> str:
    return os.environ.get("QWEN_VLM_MODEL_ID", "qwen3-vl-8b-mlx-4bit")


def request_timeout_seconds() -> float:
    return max(1.0, float(os.environ.get("QWEN_MODEL_SERVICE_TIMEOUT_MS", "300000")) / 1000.0)


def model_warmup_enabled() -> bool:
    value = os.environ.get("QWEN_MODEL_WARMUP_ON_START", "1").strip().lower()
    return value not in ("0", "false", "no", "off")


def validate_model_dir(path: Path) -> None:
    missing = [name for name in ("config.json", "tokenizer.json") if not (path / name).exists()]
    weights = (
        list(path.glob("*.safetensors"))
        + list(path.glob("*.npz"))
        + list(path.glob("*.gguf"))
    )
    if not weights:
        missing.append("*.safetensors|*.npz|*.gguf")
    if missing:
        raise RuntimeError(f"Qwen VLM model is incomplete at {path}; missing: {', '.join(missing)}")


class TextMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    system: str = ""
    messages: list[TextMessage] = Field(default_factory=list)
    maxTokens: int = 512
    temperature: float = 0.2
    topP: float = 0.9


class VisionPayload(BaseModel):
    prompt: str
    maxTokens: int = 256
    temperature: float = 0.1


def normalize_generation_result(
    result: Any,
    duration_ms: int | None = None,
    ttft_ms: int | None = None,
) -> dict[str, Any]:
    text = getattr(result, "text", None)
    if not isinstance(text, str):
        text = result if isinstance(result, str) else str(result)

    metrics: dict[str, Any] = {}
    if ttft_ms is not None:
        metrics["ttftMs"] = ttft_ms
    if duration_ms is not None:
        metrics["durationMs"] = duration_ms
    for field in METRIC_FIELDS:
        value = getattr(result, field, None)
        normalized = normalize_metric_value(value)
        if normalized is not None:
            metrics[field] = normalized

    return {
        "text": text,
        "metrics": metrics,
    }


def normalize_metric_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float | str):
        return value
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return normalize_metric_value(item())
        except Exception:
            return None
    return None


def import_mlx_vlm_load() -> Any:
    if importlib.util.find_spec("mlx_vlm") is None:
        raise RuntimeError("mlx-vlm is not installed in qwen-vlm_env")
    try:
        from mlx_vlm import load  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on local MLX env
        raise RuntimeError(f"mlx-vlm import failed: {type(exc).__name__}: {exc}") from exc
    return load


def import_mlx_vlm_generate() -> Any:
    try:
        from mlx_vlm import generate  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on local MLX env
        raise RuntimeError("mlx-vlm generate API is unavailable") from exc
    return generate


def import_mlx_vlm_stream_generate() -> Any:
    try:
        from mlx_vlm import stream_generate  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on local MLX env
        raise RuntimeError("mlx-vlm stream_generate API is unavailable") from exc
    return stream_generate


def next_stream_chunk(iterator: Iterator[dict[str, Any]]) -> dict[str, Any] | None:
    try:
        return next(iterator)
    except StopIteration:
        return None


class QwenVlmEngine:
    def __init__(self) -> None:
        self.model: Any = None
        self.processor: Any = None
        self.loaded_at: float | None = None
        self.lock = asyncio.Lock()
        self.warmup_completed_at: float | None = None
        self.warmup_duration_ms: int | None = None
        self.warmup_last_error: str | None = None

    @property
    def ready(self) -> bool:
        return self.model is not None and self.processor is not None

    def load(self) -> None:
        global LAST_ERROR
        if self.ready:
            return
        path = model_dir()
        validate_model_dir(path)
        load = import_mlx_vlm_load()
        self.model, self.processor = load(str(path))
        self.loaded_at = time.time()
        LAST_ERROR = None

    def format_messages(self, request: ChatRequest) -> str:
        lines: list[str] = []
        if request.system:
            lines.append(f"System: {request.system}")
        for message in request.messages:
            lines.append(f"{message.role.capitalize()}: {message.content}")
        lines.append("Assistant:")
        return "\n".join(lines)

    def generate_text(self, request: ChatRequest) -> dict[str, Any]:
        self.load()
        generate = import_mlx_vlm_generate()
        prompt = self.format_messages(request)
        started_at = time.time()
        result = generate(
            self.model,
            self.processor,
            prompt=prompt,
            image=None,
            max_tokens=request.maxTokens,
            temperature=request.temperature,
            top_p=request.topP,
        )
        duration_ms = int((time.time() - started_at) * 1000)
        return normalize_generation_result(result, duration_ms, duration_ms)

    def stream_text(self, request: ChatRequest) -> Iterator[dict[str, Any]]:
        self.load()
        stream_generate = import_mlx_vlm_stream_generate()
        prompt = self.format_messages(request)
        started_at = time.time()
        first_delta_at: float | None = None
        last_result: Any = None

        for result in stream_generate(
            self.model,
            self.processor,
            prompt=prompt,
            image=None,
            max_tokens=request.maxTokens,
            temperature=request.temperature,
            top_p=request.topP,
        ):
            last_result = result
            delta = getattr(result, "text", None)
            if not isinstance(delta, str):
                delta = result if isinstance(result, str) else str(result)
            if delta:
                if first_delta_at is None:
                    first_delta_at = time.time()
                yield {"delta": delta, "done": False}

        finished_at = time.time()
        duration_ms = int((finished_at - started_at) * 1000)
        ttft_ms = int(((first_delta_at or finished_at) - started_at) * 1000)
        metrics = normalize_generation_result(last_result or "", duration_ms, ttft_ms)["metrics"]
        yield {
            "delta": "",
            "done": True,
            "modelId": model_id(),
            "metadata": metrics,
        }

    def describe_image(self, payload: VisionPayload, image_bytes: bytes) -> dict[str, Any]:
        self.load()
        try:
            from mlx_vlm import generate  # type: ignore
            from PIL import Image
        except Exception as exc:  # pragma: no cover - depends on local MLX env
            raise RuntimeError("mlx-vlm vision dependencies are unavailable") from exc
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        started_at = time.time()
        result = generate(
            self.model,
            self.processor,
            prompt=payload.prompt,
            image=image,
            max_tokens=payload.maxTokens,
            temperature=payload.temperature,
        )
        duration_ms = int((time.time() - started_at) * 1000)
        return normalize_generation_result(result, duration_ms, duration_ms)

    def warmup(self) -> None:
        global LAST_ERROR
        if not model_warmup_enabled() or self.warmup_completed_at is not None:
            return
        started_at = time.time()
        try:
            self.generate_text(ChatRequest(messages=[TextMessage(role="user", content="ping")], maxTokens=1, temperature=0.0, topP=1.0))
            self.warmup_completed_at = time.time()
            self.warmup_duration_ms = int((self.warmup_completed_at - started_at) * 1000)
            self.warmup_last_error = None
        except Exception as exc:
            self.warmup_last_error = str(exc)
            LAST_ERROR = self.warmup_last_error

    def load_and_warmup(self) -> None:
        self.load()
        self.warmup()

    def warmup_status(self) -> dict[str, Any]:
        return {
            "enabled": model_warmup_enabled(),
            "completedAt": int(self.warmup_completed_at * 1000) if self.warmup_completed_at else None,
            "durationMs": self.warmup_duration_ms,
            "lastError": self.warmup_last_error,
        }


ENGINE = QwenVlmEngine()
app = FastAPI(title="Home Assistant Qwen VLM Service")


@app.on_event("startup")
async def startup() -> None:
    global LAST_ERROR
    try:
        await asyncio.to_thread(ENGINE.load_and_warmup)
    except Exception as exc:
        LAST_ERROR = str(exc)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": ENGINE.ready,
        "ready": ENGINE.ready,
        "backend": "mlx-vlm",
        "pid": os.getpid(),
        "model": str(model_dir()),
        "modelId": model_id(),
        "loaded": ENGINE.ready,
        "cache": {
            "loadedAt": int(ENGINE.loaded_at * 1000) if ENGINE.loaded_at else None,
        },
        "warmup": ENGINE.warmup_status(),
        "startedAt": int(STARTED_AT * 1000),
        "uptimeSeconds": int(time.time() - STARTED_AT),
        "lastError": LAST_ERROR,
    }


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest) -> StreamingResponse:
    async def stream() -> AsyncIterator[bytes]:
        global LAST_ERROR
        try:
            async with ENGINE.lock:
                iterator = ENGINE.stream_text(request)
                while True:
                    chunk = await asyncio.wait_for(
                        asyncio.to_thread(next_stream_chunk, iterator),
                        timeout=request_timeout_seconds(),
                    )
                    if chunk is None:
                        break
                    yield (json.dumps(chunk, ensure_ascii=False) + "\n").encode("utf-8")
            LAST_ERROR = None
        except Exception as exc:
            LAST_ERROR = str(exc)
            yield (json.dumps({"error": LAST_ERROR, "done": True}, ensure_ascii=False) + "\n").encode("utf-8")

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.post("/vision/describe")
async def vision_describe(payload: str = Form(...), image: UploadFile = File(...)) -> dict[str, Any]:
    global LAST_ERROR
    try:
        parsed = VisionPayload.parse_raw(payload)
        image_bytes = await image.read()
        if not image_bytes:
            raise HTTPException(status_code=400, detail="image is empty")
        async with ENGINE.lock:
            result = await asyncio.wait_for(
                asyncio.to_thread(ENGINE.describe_image, parsed, image_bytes),
                timeout=request_timeout_seconds(),
            )
        LAST_ERROR = None
        return {
            "text": result["text"],
            "modelId": model_id(),
            "durationMs": result["metrics"].get("durationMs"),
            "metadata": result["metrics"],
        }
    except HTTPException:
        raise
    except Exception as exc:
        LAST_ERROR = str(exc)
        raise HTTPException(status_code=500, detail=LAST_ERROR) from exc


@app.post("/start")
async def start() -> dict[str, Any]:
    global LAST_ERROR
    try:
        await asyncio.to_thread(ENGINE.load_and_warmup)
        if ENGINE.warmup_last_error is None:
            LAST_ERROR = None
        return await health()
    except Exception as exc:
        LAST_ERROR = str(exc)
        raise HTTPException(status_code=500, detail=LAST_ERROR) from exc


@app.post("/stop")
async def stop() -> dict[str, bool]:
    asyncio.get_running_loop().call_later(0.1, os._exit, 0)
    return {"ok": True}
