import os
import tempfile
import unittest
from pathlib import Path

from src.server.python_services.src.funasr_service import resolve_model_name
from src.server.python_services.src.mdx_service import resolve_model_path


class OfflineModelRuntimeTest(unittest.TestCase):
    def test_funasr_resolves_cached_model_and_rejects_missing_remote_name_by_default(self) -> None:
        previous_root = os.environ.get("PYTHON_SERVICES_ROOT")
        previous_offline = os.environ.get("FUNASR_LOCAL_FILES_ONLY")
        try:
            with tempfile.TemporaryDirectory() as root:
                os.environ["PYTHON_SERVICES_ROOT"] = root
                os.environ.pop("FUNASR_LOCAL_FILES_ONLY", None)
                model_path = Path(root) / "models_cache" / "funasr" / "models" / "iic" / "local-model"
                model_path.mkdir(parents=True)

                self.assertEqual(Path(resolve_model_name("iic/local-model")).resolve(), model_path.resolve())
                with self.assertRaisesRegex(RuntimeError, "offline mode"):
                    resolve_model_name("iic/missing-model")

                os.environ["FUNASR_LOCAL_FILES_ONLY"] = "0"
                self.assertEqual(resolve_model_name("iic/missing-model"), "iic/missing-model")
        finally:
            if previous_root is None:
                os.environ.pop("PYTHON_SERVICES_ROOT", None)
            else:
                os.environ["PYTHON_SERVICES_ROOT"] = previous_root
            if previous_offline is None:
                os.environ.pop("FUNASR_LOCAL_FILES_ONLY", None)
            else:
                os.environ["FUNASR_LOCAL_FILES_ONLY"] = previous_offline

    def test_mdx_resolves_local_model_and_rejects_missing_model_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            model_dir = Path(root)
            model_path = model_dir / "UVR-MDX-NET-Inst_HQ_3.onnx"
            model_path.write_bytes(b"onnx")

            self.assertEqual(resolve_model_path("UVR-MDX-NET-Inst_HQ_3.onnx", model_dir), model_path.resolve())
            with self.assertRaisesRegex(RuntimeError, "offline mode"):
                resolve_model_path("missing.onnx", model_dir)


if __name__ == "__main__":
    unittest.main()
