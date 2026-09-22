import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("modal_secret", Path(__file__).with_name("modal-secret.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SecretSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / ".env.modal"

    def test_generates_key_and_preserves_template_settings(self):
        module.init_config(self.target)
        key = module.read_key(self.target)
        self.assertEqual(len(key), 43)
        self.assertIn("INFERENCE_BASE_URL=\n", self.target.read_text())
        self.assertIn("INFERENCE_ALLOW_REMOTE=true", self.target.read_text())
        self.assertIn("INFERENCE_HEALTH_PATH=/health", self.target.read_text())
        self.assertIn("INFERENCE_TIMEOUT_MS=300000", self.target.read_text())

    def test_repeated_init_cannot_overwrite_existing_key(self):
        module.init_config(self.target)
        before = self.target.read_bytes()
        with self.assertRaises(FileExistsError):
            module.init_config(self.target)
        self.assertEqual(self.target.read_bytes(), before)

    def test_uploads_only_inference_key_without_replacing_existing_secret(self):
        module.init_config(self.target)
        with self.target.open("a") as output:
            output.write("DEPLOYER_PRIVATE_KEY=never-upload-this\nDATABASE_URL=private\n")
        manager = Mock()
        module.upload_config(self.target, "dev", manager)
        manager.create.assert_called_once_with("enclave-inference", {"INFERENCE_API_KEY": module.read_key(self.target)},
                                               allow_existing=False, environment_name="dev")

    def test_rejects_missing_duplicate_or_malformed_key_before_upload(self):
        manager = Mock()
        for text in ("", "INFERENCE_API_KEY=short\n", "INFERENCE_API_KEY=" + "x" * 32 + "\nINFERENCE_API_KEY=" + "y" * 32,
                     "INFERENCE_API_KEY=" + "x" * 32 + " ", "INFERENCE_API_KEY=" + "x" * 257):
            with self.subTest(text_length=len(text)):
                self.target.write_text(text)
                with self.assertRaises(ValueError):
                    module.upload_config(self.target, manager=manager)
        manager.create.assert_not_called()

    def test_remote_error_never_prints_secret_or_replaces_local_file(self):
        module.init_config(self.target)
        key = module.read_key(self.target)
        before = self.target.read_bytes()
        stderr = io.StringIO()
        with patch.object(module, "upload_config", side_effect=RuntimeError(key)), contextlib.redirect_stderr(stderr):
            self.assertEqual(module.main(["upload", "--config", str(self.target)]), 1)
        self.assertNotIn(key, stderr.getvalue())
        self.assertEqual(self.target.read_bytes(), before)

    def test_cli_init_prints_path_without_the_value(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.assertEqual(module.main(["init", "--config", str(self.target)]), 0)
        self.assertNotIn(module.read_key(self.target), stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
