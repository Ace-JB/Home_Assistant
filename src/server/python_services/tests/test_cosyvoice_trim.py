import io
import os
import tempfile
import unittest
import wave
from array import array
from pathlib import Path

from src.server.python_services.src.cosyvoice_service import model_dir, validate_model_dir, trim_wav_silence


SAMPLE_RATE = 24000


def make_wav(samples: array, *, channels: int = 1, sample_width: int = 2) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples.tobytes())
    return output.getvalue()


def frame_count(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav:
        return wav.getnframes()


def tone(ms: int, amplitude: int = 6000) -> array:
    return array("h", [amplitude] * int(SAMPLE_RATE * ms / 1000))


def silence(ms: int) -> array:
    return array("h", [0] * int(SAMPLE_RATE * ms / 1000))


class CosyVoiceTrimTest(unittest.TestCase):
    def setUp(self) -> None:
        os.environ["COSYVOICE_TRIM_SILENCE"] = "1"

    def test_trims_head_and_tail_silence_with_padding(self) -> None:
        source = make_wav(silence(200) + tone(300) + silence(220))

        trimmed = trim_wav_silence(
            source,
            threshold_db=-42,
            frame_ms=10,
            head_pad_ms=50,
            tail_pad_ms=110,
        )

        self.assertLess(frame_count(trimmed), frame_count(source))
        self.assertAlmostEqual(frame_count(trimmed), int(SAMPLE_RATE * 460 / 1000), delta=int(SAMPLE_RATE * 0.03))

    def test_returns_original_for_pure_silence(self) -> None:
        source = make_wav(silence(300))

        self.assertEqual(trim_wav_silence(source), source)

    def test_preserves_middle_silence(self) -> None:
        source = make_wav(silence(160) + tone(120) + silence(180) + tone(120) + silence(160))

        trimmed = trim_wav_silence(
            source,
            threshold_db=-42,
            frame_ms=10,
            head_pad_ms=50,
            tail_pad_ms=110,
        )

        expected_ms = 50 + 120 + 180 + 120 + 110
        self.assertAlmostEqual(frame_count(trimmed), int(SAMPLE_RATE * expected_ms / 1000), delta=int(SAMPLE_RATE * 0.03))

    def test_returns_original_for_non_int16_wav(self) -> None:
        samples = array("B", [128] * int(SAMPLE_RATE * 0.2))
        source = make_wav(samples, sample_width=1)

        self.assertEqual(trim_wav_silence(source), source)

    def test_model_dir_uses_fixed_managed_cache_directory(self) -> None:
        previous_model_dir = os.environ.get("COSYVOICE_MODEL_DIR")
        try:
            os.environ.pop("COSYVOICE_MODEL_DIR", None)
            expected = Path("data/python_services/models_cache/cosyvoice/Fun-CosyVoice3-0.5B-2512-4bit").resolve()

            self.assertEqual(model_dir(), expected)
        finally:
            if previous_model_dir is None:
                os.environ.pop("COSYVOICE_MODEL_DIR", None)
            else:
                os.environ["COSYVOICE_MODEL_DIR"] = previous_model_dir

    def test_validate_model_dir_fails_fast_without_config(self) -> None:
        with tempfile.TemporaryDirectory() as temp_root:
            missing_config_dir = Path(temp_root) / "cosyvoice-model"
            missing_config_dir.mkdir()

            with self.assertRaisesRegex(RuntimeError, "CosyVoice model config not found"):
                validate_model_dir(missing_config_dir)


if __name__ == "__main__":
    unittest.main()
