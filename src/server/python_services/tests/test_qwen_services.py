import asyncio
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from src.server.python_services.src.qwen_router_service import (
    GenerateRequest,
    RouterEngine,
    TextMessage,
    build_generation_kwargs,
    import_mlx_lm_load,
    model_warmup_enabled as router_model_warmup_enabled,
    normalize_generation_result as normalize_router_generation_result,
    validate_model_dir as validate_router_model_dir,
)
from src.server.python_services.src.qwen_vlm_service import (
    ChatRequest,
    QwenVlmEngine,
    TextMessage as VlmTextMessage,
    import_mlx_vlm_load,
    model_warmup_enabled as vlm_model_warmup_enabled,
    normalize_generation_result as normalize_vlm_generation_result,
    validate_model_dir as validate_vlm_model_dir,
)


def write_minimal_mlx_model(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "config.json").write_text("{}", encoding="utf-8")
    (path / "tokenizer.json").write_text("{}", encoding="utf-8")
    (path / "model.safetensors").write_bytes(b"fake")


class QwenModelServiceValidationTest(unittest.TestCase):
    def test_vlm_model_dir_requires_config_tokenizer_and_weights(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            model_path = Path(root) / "qwen-vlm"
            model_path.mkdir()

            with self.assertRaisesRegex(RuntimeError, "missing"):
                validate_vlm_model_dir(model_path)

            write_minimal_mlx_model(model_path)
            validate_vlm_model_dir(model_path)

    def test_router_model_dir_requires_config_tokenizer_and_weights(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            model_path = Path(root) / "qwen-router-fast"
            model_path.mkdir()

            with self.assertRaisesRegex(RuntimeError, "qwen-router fast"):
                validate_router_model_dir(model_path, "qwen-router fast")

            write_minimal_mlx_model(model_path)
            validate_router_model_dir(model_path, "qwen-router fast")

    def test_vlm_generation_result_returns_text_and_separates_metrics(self) -> None:
        class FakeGenerationResult:
            text = "红烧牛肉做法"
            prompt_tokens = 1803
            generation_tokens = 65
            total_tokens = 1868
            generation_tps = 33.9
            prompt_tps = 141.5
            peak_memory = 7.2
            finish_reason = "stop"
            logprobs = [1, 2, 3]

            def __str__(self) -> str:
                return "GenerationResult(text='红烧牛肉做法', logprobs=[...])"

        result = normalize_vlm_generation_result(FakeGenerationResult(), 1234)

        self.assertEqual(result["text"], "红烧牛肉做法")
        self.assertEqual(result["metrics"]["durationMs"], 1234)
        self.assertEqual(result["metrics"]["generation_tps"], 33.9)
        self.assertNotIn("logprobs", result["metrics"])
        self.assertNotIn("GenerationResult", result["text"])

    def test_router_generation_result_keeps_plain_string_outputs(self) -> None:
        result = normalize_router_generation_result('{"intent":"qa"}', 12)

        self.assertEqual(result["text"], '{"intent":"qa"}')
        self.assertEqual(result["metrics"]["durationMs"], 12)

    def test_router_generation_kwargs_use_sampler_instead_of_temp_kwarg(self) -> None:
        calls: list[float] = []

        def fake_sampler_factory(temp: float):
            calls.append(temp)
            return "sampler"

        request = GenerateRequest(
            role="fast",
            messages=[TextMessage(role="user", content="hi")],
            maxTokens=32,
            temperature=0.3,
        )
        kwargs = build_generation_kwargs(request, fake_sampler_factory)

        self.assertEqual(kwargs, {"max_tokens": 32, "sampler": "sampler"})
        self.assertEqual(calls, [0.3])
        self.assertNotIn("temp", kwargs)

    def test_router_generate_metadata_includes_ttft_and_duration(self) -> None:
        engine = RouterEngine()
        engine.fast.model = object()
        engine.fast.tokenizer = object()

        def fake_generate(_request: GenerateRequest) -> dict[str, object]:
            return {"text": '{"intent":"qa"}', "metrics": {"prompt_tokens": 3}}

        engine.fast.generate = fake_generate  # type: ignore[method-assign]
        request = GenerateRequest(
            role="fast",
            messages=[TextMessage(role="user", content="hi")],
            maxTokens=2,
        )
        _text, _model_id, _duration_ms, metrics = asyncio.run(engine.generate(request))

        self.assertEqual(metrics["prompt_tokens"], 3)
        self.assertIn("ttftMs", metrics)
        self.assertIn("durationMs", metrics)

    def test_router_import_reports_missing_package_only_when_absent(self) -> None:
        with patch("src.server.python_services.src.qwen_router_service.importlib.util.find_spec", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "mlx-lm is not installed"):
                import_mlx_lm_load()

    def test_vlm_import_reports_missing_package_only_when_absent(self) -> None:
        with patch("src.server.python_services.src.qwen_vlm_service.importlib.util.find_spec", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "mlx-vlm is not installed"):
                import_mlx_vlm_load()

    def test_model_warmup_defaults_on_and_accepts_opt_out(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            self.assertTrue(vlm_model_warmup_enabled())
            self.assertTrue(router_model_warmup_enabled())

        with patch.dict("os.environ", {"QWEN_MODEL_WARMUP_ON_START": "0"}, clear=True):
            self.assertFalse(vlm_model_warmup_enabled())
            self.assertFalse(router_model_warmup_enabled())

    def test_vlm_stream_text_yields_incremental_chunks_and_final_metadata(self) -> None:
        class FakeGenerationResult:
            def __init__(self, text: str, generation_tokens: int) -> None:
                self.text = text
                self.prompt_tokens = 7
                self.generation_tokens = generation_tokens
                self.cached_tokens = 0
                self.prompt_tps = 120.0
                self.generation_tps = 31.5
                self.peak_memory = 6.2
                self.finish_reason = "stop"

        calls: list[dict[str, object]] = []

        def fake_stream_generate(*_args: object, **kwargs: object):
            calls.append(kwargs)
            yield FakeGenerationResult("你", 1)
            yield FakeGenerationResult("好", 2)

        engine = QwenVlmEngine()
        engine.model = object()
        engine.processor = object()
        request = ChatRequest(
            messages=[VlmTextMessage(role="user", content="hi")],
            maxTokens=8,
            temperature=0.15,
            topP=0.72,
        )

        with patch("src.server.python_services.src.qwen_vlm_service.import_mlx_vlm_stream_generate", return_value=fake_stream_generate):
            chunks = list(engine.stream_text(request))

        self.assertEqual([chunk["delta"] for chunk in chunks], ["你", "好", ""])
        self.assertEqual([chunk["done"] for chunk in chunks], [False, False, True])
        self.assertEqual(calls[0]["top_p"], 0.72)
        self.assertEqual(calls[0]["max_tokens"], 8)
        self.assertEqual(chunks[-1]["modelId"], "qwen3-vl-8b-mlx-4bit")
        self.assertEqual(chunks[-1]["metadata"]["prompt_tokens"], 7)
        self.assertEqual(chunks[-1]["metadata"]["generation_tokens"], 2)
        self.assertEqual(chunks[-1]["metadata"]["cached_tokens"], 0)
        self.assertIn("ttftMs", chunks[-1]["metadata"])
        self.assertIn("durationMs", chunks[-1]["metadata"])

    def test_vlm_warmup_runs_once_and_records_failure(self) -> None:
        request_max_tokens: list[int] = []
        engine = QwenVlmEngine()
        engine.model = object()
        engine.processor = object()

        def fake_generate(request: ChatRequest) -> dict[str, object]:
            request_max_tokens.append(request.maxTokens)
            return {"text": "", "metrics": {}}

        engine.generate_text = fake_generate  # type: ignore[method-assign]
        with patch.dict("os.environ", {"QWEN_MODEL_WARMUP_ON_START": "1"}, clear=True):
            engine.warmup()
            engine.warmup()

        self.assertEqual(request_max_tokens, [1])
        self.assertIsNotNone(engine.warmup_status()["completedAt"])
        self.assertIsNone(engine.warmup_status()["lastError"])

        failing = QwenVlmEngine()
        failing.model = object()
        failing.processor = object()

        def fail_generate(_request: ChatRequest) -> dict[str, object]:
            raise RuntimeError("warmup broke")

        failing.generate_text = fail_generate  # type: ignore[method-assign]
        with patch.dict("os.environ", {"QWEN_MODEL_WARMUP_ON_START": "1"}, clear=True):
            failing.warmup()

        self.assertIn("warmup broke", str(failing.warmup_status()["lastError"]))
        self.assertIsNone(failing.warmup_status()["completedAt"])

    def test_router_fast_warmup_runs_once_after_load(self) -> None:
        requests: list[GenerateRequest] = []
        engine = RouterEngine()

        engine.fast.model = object()
        engine.fast.tokenizer = object()

        def fake_generate(request: GenerateRequest) -> dict[str, object]:
            requests.append(request)
            return {"text": "", "metrics": {}}

        engine.fast.generate = fake_generate  # type: ignore[method-assign]
        with patch.dict("os.environ", {"QWEN_MODEL_WARMUP_ON_START": "1"}, clear=True):
            engine.warmup_fast()
            engine.warmup_fast()

        self.assertEqual([request.maxTokens for request in requests], [1])
        self.assertEqual(requests[0].role, "fast")
        self.assertIsNotNone(engine.warmup_status()["completedAt"])


if __name__ == "__main__":
    unittest.main()
