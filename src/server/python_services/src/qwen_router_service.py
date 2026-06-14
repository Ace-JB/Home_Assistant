import asyncio
import importlib.util
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


DEFAULT_FAST_MODEL_DIR = "data/python_services/models_cache/qwen-router/fast"
DEFAULT_REPAIR_MODEL_DIR = "data/python_services/models_cache/qwen-router/repair"
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


def fast_model_dir() -> Path:
    return Path(os.environ.get("QWEN_ROUTER_FAST_MODEL_DIR", DEFAULT_FAST_MODEL_DIR)).resolve()


def repair_model_dir() -> Path:
    return Path(os.environ.get("QWEN_ROUTER_REPAIR_MODEL_DIR", DEFAULT_REPAIR_MODEL_DIR)).resolve()


def fast_model_id() -> str:
    return os.environ.get("QWEN_ROUTER_FAST_MODEL_ID", "qwen2.5-0.5b-instruct-mlx")


def repair_model_id() -> str:
    return os.environ.get("QWEN_ROUTER_REPAIR_MODEL_ID", "qwen2.5-1.5b-instruct-mlx")


def repair_wait_seconds() -> float:
    return max(0.1, float(os.environ.get("QWEN_ROUTER_REPAIR_WAIT_MS", "15000")) / 1000.0)


def model_warmup_enabled() -> bool:
    value = os.environ.get("QWEN_MODEL_WARMUP_ON_START", "1").strip().lower()
    return value not in ("0", "false", "no", "off")


def validate_model_dir(path: Path, label: str) -> None:
    missing = [name for name in ("config.json", "tokenizer.json") if not (path / name).exists()]
    weights = (
        list(path.glob("*.safetensors"))
        + list(path.glob("*.npz"))
        + list(path.glob("*.gguf"))
    )
    if not weights:
        missing.append("*.safetensors|*.npz|*.gguf")
    if missing:
        raise RuntimeError(f"{label} model is incomplete at {path}; missing: {', '.join(missing)}")


class TextMessage(BaseModel):
    role: str
    content: str


class GenerateRequest(BaseModel):
    role: str
    messages: list[TextMessage]
    maxTokens: int = 900
    temperature: float = 0.0


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


def build_generation_kwargs(request: GenerateRequest, sampler_factory: Any) -> dict[str, Any]:
    return {
        "max_tokens": request.maxTokens,
        "sampler": sampler_factory(temp=request.temperature),
    }


def import_mlx_lm_load() -> Any:
    if importlib.util.find_spec("mlx_lm") is None:
        raise RuntimeError("mlx-lm is not installed in qwen-router_env")
    try:
        from mlx_lm import load  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on local MLX env
        raise RuntimeError(f"mlx-lm import failed: {type(exc).__name__}: {exc}") from exc
    return load


class LoadedModel:
    def __init__(self, path: Path, model_id: str, label: str) -> None:
        self.path = path
        self.model_id = model_id
        self.label = label
        self.model: Any = None
        self.tokenizer: Any = None
        self.loaded_at: float | None = None

    @property
    def ready(self) -> bool:
        return self.model is not None and self.tokenizer is not None

    def load(self) -> None:
        if self.ready:
            return
        validate_model_dir(self.path, self.label)
        load = import_mlx_lm_load()
        self.model, self.tokenizer = load(str(self.path))
        self.loaded_at = time.time()

    def prompt(self, messages: list[TextMessage]) -> str:
        plain = [{"role": message.role, "content": message.content} for message in messages]
        apply_template = getattr(self.tokenizer, "apply_chat_template", None)
        if callable(apply_template):
            return str(apply_template(plain, tokenize=False, add_generation_prompt=True))
        return "\n".join([f"{message.role.capitalize()}: {message.content}" for message in messages] + ["Assistant:"])

    def generate(self, request: GenerateRequest) -> dict[str, Any]:
        self.load()
        try:
            from mlx_lm import generate  # type: ignore
            from mlx_lm.sample_utils import make_sampler  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on local MLX env
            raise RuntimeError("mlx-lm generate API is unavailable") from exc
        result = generate(
            self.model,
            self.tokenizer,
            prompt=self.prompt(request.messages),
            **build_generation_kwargs(request, make_sampler),
        )
        return normalize_generation_result(result)


class RouterEngine:
    def __init__(self) -> None:
        self.fast = LoadedModel(fast_model_dir(), fast_model_id(), "qwen-router fast")
        self.repair = LoadedModel(repair_model_dir(), repair_model_id(), "qwen-router repair")
        self.lock = asyncio.Lock()
        self.repair_loading: asyncio.Task[None] | None = None
        self.warmup_completed_at: float | None = None
        self.warmup_duration_ms: int | None = None
        self.warmup_last_error: str | None = None

    def load_fast(self) -> None:
        self.fast.load()

    def warmup_fast(self) -> None:
        global LAST_ERROR
        if not model_warmup_enabled() or self.warmup_completed_at is not None:
            return
        started_at = time.time()
        try:
            self.fast.generate(GenerateRequest(
                role="fast",
                messages=[TextMessage(role="user", content="ping")],
                maxTokens=1,
                temperature=0.0,
            ))
            self.warmup_completed_at = time.time()
            self.warmup_duration_ms = int((self.warmup_completed_at - started_at) * 1000)
            self.warmup_last_error = None
        except Exception as exc:
            self.warmup_last_error = str(exc)
            LAST_ERROR = self.warmup_last_error

    def load_fast_and_warmup(self) -> None:
        self.load_fast()
        self.warmup_fast()

    def warmup_status(self) -> dict[str, Any]:
        return {
            "enabled": model_warmup_enabled(),
            "completedAt": int(self.warmup_completed_at * 1000) if self.warmup_completed_at else None,
            "durationMs": self.warmup_duration_ms,
            "lastError": self.warmup_last_error,
        }

    async def prewarm_repair(self) -> None:
        global LAST_ERROR
        try:
            await asyncio.to_thread(self.repair.load)
            if self.warmup_last_error is None:
                LAST_ERROR = None
        except Exception as exc:
            LAST_ERROR = str(exc)

    def start_repair_prewarm(self) -> None:
        if self.repair.ready:
            return
        if self.repair_loading and not self.repair_loading.done():
            return
        self.repair_loading = asyncio.create_task(self.prewarm_repair())

    async def generate(self, request: GenerateRequest) -> tuple[str, str, int, dict[str, Any]]:
        target = self.fast if request.role == "fast" else self.repair
        if request.role == "repair" and not target.ready:
            self.start_repair_prewarm()
            if self.repair_loading:
                await asyncio.wait_for(asyncio.shield(self.repair_loading), timeout=repair_wait_seconds())
        started_at = time.time()
        async with self.lock:
            result = await asyncio.to_thread(target.generate, request)
        duration_ms = int((time.time() - started_at) * 1000)
        metrics = {**result["metrics"], "ttftMs": duration_ms, "durationMs": duration_ms}
        return result["text"], target.model_id, duration_ms, metrics


ENGINE = RouterEngine()
app = FastAPI(title="Home Assistant Qwen Router Service")


@app.on_event("startup")
async def startup() -> None:
    global LAST_ERROR
    try:
        await asyncio.to_thread(ENGINE.load_fast_and_warmup)
        ENGINE.start_repair_prewarm()
        if ENGINE.warmup_last_error is None:
            LAST_ERROR = None
    except Exception as exc:
        LAST_ERROR = str(exc)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": ENGINE.fast.ready,
        "ready": ENGINE.fast.ready,
        "backend": "mlx-lm",
        "pid": os.getpid(),
        "startedAt": int(STARTED_AT * 1000),
        "uptimeSeconds": int(time.time() - STARTED_AT),
        "models": {
            "fast": {
                "model": str(fast_model_dir()),
                "modelId": fast_model_id(),
                "ready": ENGINE.fast.ready,
                "loadedAt": int(ENGINE.fast.loaded_at * 1000) if ENGINE.fast.loaded_at else None,
            },
            "repair": {
                "model": str(repair_model_dir()),
                "modelId": repair_model_id(),
                "ready": ENGINE.repair.ready,
                "loading": bool(ENGINE.repair_loading and not ENGINE.repair_loading.done()),
                "loadedAt": int(ENGINE.repair.loaded_at * 1000) if ENGINE.repair.loaded_at else None,
            },
        },
        "warmup": ENGINE.warmup_status(),
        "lastError": LAST_ERROR,
    }


@app.post("/generate")
async def generate(request: GenerateRequest) -> dict[str, Any]:
    global LAST_ERROR
    try:
        if request.role not in ("fast", "repair"):
            raise HTTPException(status_code=400, detail="role must be fast or repair")
        text, selected_model_id, duration_ms, metrics = await ENGINE.generate(request)
        LAST_ERROR = None
        return {
            "text": text,
            "modelId": selected_model_id,
            "role": request.role,
            "durationMs": duration_ms,
            "metadata": metrics,
        }
    except HTTPException:
        raise
    except Exception as exc:
        LAST_ERROR = str(exc)
        raise HTTPException(status_code=500, detail=LAST_ERROR) from exc


@app.post("/prewarm")
async def prewarm() -> dict[str, Any]:
    ENGINE.start_repair_prewarm()
    return await health()


@app.post("/start")
async def start() -> dict[str, Any]:
    global LAST_ERROR
    try:
        await asyncio.to_thread(ENGINE.load_fast_and_warmup)
        ENGINE.start_repair_prewarm()
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
