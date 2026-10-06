"""Offline installer boundaries; native Linux execution is a separate check."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("near_runtime_installer", ROOT / "install-runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeLockTests(unittest.TestCase):
    def test_lock_contains_exact_direct_versions_and_full_closure(self):
        locked = runtime.reviewed_lock()
        self.assertEqual(len(locked), 10)
        self.assertEqual({name: locked[name] for name in ("dcap-qvl", "cryptography", "pyjwt", "requests")},
                         {"dcap-qvl": "0.6.3", "cryptography": "50.0.1", "pyjwt": "2.14.0", "requests": "2.34.2"})

    def test_missing_lock_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_LOCK_MISSING"):
                runtime.reviewed_lock(Path(tmp) / "missing.lock", ROOT / "requirements.txt")

    def test_modified_hash_is_rejected_before_package_operations(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "requirements.lock"
            original = (ROOT / "requirements-linux.lock").read_text()
            lock.write_text(original.replace("62f22742", "00000000", 1))
            with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_LOCK_CHANGED"):
                runtime.reviewed_lock(lock, ROOT / "requirements.txt")

    def test_crlf_checkout_preserves_the_reviewed_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / "requirements.lock"
            lock.write_bytes((ROOT / "requirements-linux.lock").read_text().replace("\n", "\r\n").encode())
            self.assertEqual(runtime.reviewed_lock(lock, ROOT / "requirements.txt"), runtime.reviewed_lock())

    def test_new_or_changed_direct_dependency_requires_lock_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            direct = Path(tmp) / "requirements.txt"
            direct.write_text("dcap-qvl==0.6.4\n")
            with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_DIRECT_PIN_MISMATCH"):
                runtime.reviewed_lock(ROOT / "requirements-linux.lock", direct)

    def test_unhashed_ranges_urls_options_and_duplicates_are_rejected(self):
        for text in ("requests==2.34.2", "requests>=2", "https://example.org/file.whl", "--extra-index-url https://example.org",
                     "requests==2.34.2 --hash=md5:" + "a" * 32,
                     "requests==2.34.2 --hash=sha256:" + "a" * 64 + "\nrequests==2.34.2 --hash=sha256:" + "b" * 64):
            with self.subTest(text=text[:50]), self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_LOCK_INVALID"):
                runtime.parse_requirements(text, True)

    def test_supported_debian_and_ci_runtimes(self):
        for version in ((3, 11), (3, 12)):
            runtime.supported_runtime("Linux", "x86_64", "CPython", version, ("glibc", "2.36"))

    def test_other_platforms_and_interpreters_fail_closed(self):
        for system, machine, implementation, version in (("Windows", "AMD64", "CPython", (3, 11)),
                ("Linux", "aarch64", "CPython", (3, 11)), ("Linux", "x86_64", "PyPy", (3, 11)),
                ("Linux", "x86_64", "CPython", (3, 10)), ("Linux", "x86_64", "CPython", (3, 13))):
            with self.subTest(system=system, machine=machine, version=version), self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_PLATFORM_UNSUPPORTED"):
                runtime.supported_runtime(system, machine, implementation, version, ("glibc", "2.36"))

    def test_musl_missing_or_old_glibc_fail_closed(self):
        for libc in (("musl", "1.2"), ("glibc", "2.17"), ("", ""), ("glibc", "unknown")):
            with self.subTest(libc=libc), self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_LIBC_UNSUPPORTED"):
                runtime.supported_runtime("Linux", "x86_64", "CPython", (3, 11), libc)

    def test_prerelease_python_is_not_an_accepted_runtime(self):
        with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_PLATFORM_UNSUPPORTED"):
            runtime.supported_runtime("Linux", "x86_64", "CPython", (3, 12), ("glibc", "2.36"), "candidate")

    def test_unsupported_runtime_does_not_create_or_run_anything(self):
        builder, runner = Mock(), Mock()
        with patch.object(runtime, "supported_runtime", side_effect=runtime.RuntimeInstallError("RUNTIME_PLATFORM_UNSUPPORTED")):
            with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_PLATFORM_UNSUPPORTED"):
                runtime.install("/unused/runtime", builder, runner)
        builder.create.assert_not_called()
        runner.assert_not_called()

    def test_existing_runtime_is_never_modified(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "supported_runtime"):
            builder, runner = Mock(), Mock()
            with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_VENV_ALREADY_EXISTS"):
                runtime.install(tmp, builder, runner)
            builder.create.assert_not_called()
            runner.assert_not_called()

    def test_competing_runtime_created_after_path_check_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "supported_runtime"):
            target = Path(tmp).resolve() / "new"
            checked, competed = threading.Event(), threading.Event()
            competitor_error, competitor_metadata = [], []
            original = runtime.new_venv_path

            def competing_creator():
                try:
                    if not checked.wait(5):
                        raise RuntimeError("Path-check synchronization timed out")
                    target.mkdir(mode=0o700)
                    (target / "rival-runtime").write_bytes(b"must remain untouched")
                    stat = target.stat()
                    competitor_metadata.append((stat.st_mtime_ns, stat.st_mode))
                except Exception as error:
                    competitor_error.append(error)
                finally:
                    competed.set()

            def checked_path(value):
                result = original(value)
                checked.set()
                if not competed.wait(5):
                    raise RuntimeError("Competing-creator synchronization timed out")
                return result

            competitor = threading.Thread(target=competing_creator)
            competitor.start()
            builder, runner = Mock(), Mock()
            try:
                with patch.object(runtime, "new_venv_path", side_effect=checked_path):
                    with self.assertRaisesRegex(runtime.RuntimeInstallError, "^RUNTIME_VENV_ALREADY_EXISTS$"):
                        runtime.install(target, builder, runner)
            finally:
                checked.set()
                competitor.join(timeout=5)
            self.assertFalse(competitor.is_alive())
            self.assertEqual(competitor_error, [])
            self.assertEqual([path.name for path in target.iterdir()], ["rival-runtime"])
            self.assertEqual((target / "rival-runtime").read_bytes(), b"must remain untouched")
            stat = target.stat()
            self.assertEqual((stat.st_mtime_ns, stat.st_mode), competitor_metadata[0])
            builder.create.assert_not_called()
            runner.assert_not_called()

    def test_reservation_error_is_fixed_and_stops_before_builder_or_package_operations(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "supported_runtime"):
            builder, runner = Mock(), Mock()
            target = Path(tmp).resolve() / "new"
            with patch.object(Path, "mkdir", side_effect=PermissionError("private path detail")):
                with self.assertRaisesRegex(runtime.RuntimeInstallError, "^RUNTIME_VENV_RESERVATION_FAILED$"):
                    runtime.install(target, builder, runner)
            builder.create.assert_not_called()
            runner.assert_not_called()
            self.assertFalse(target.exists())

    def test_absolute_fresh_canonical_target_is_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            (root / "parent").mkdir()
            for target, code in (("relative", "RUNTIME_VENV_ABSOLUTE_REQUIRED"),
                                 (root / "missing" / "new", "RUNTIME_VENV_PATH_UNSAFE"),
                                 (root / "parent" / ".." / "new", "RUNTIME_VENV_PATH_UNSAFE")):
                with self.subTest(target=str(target)), self.assertRaisesRegex(runtime.RuntimeInstallError, code):
                    runtime.new_venv_path(target)
            self.assertEqual(runtime.new_venv_path(root / "new"), root / "new")

    def test_download_and_offline_install_both_enforce_hashes_and_binary_only(self):
        download, install, check = runtime.pip_commands(Path("/new/bin/python"), Path("/new/wheels"), Path("/reviewed/lock"))
        for command in (download, install):
            self.assertIn("--require-hashes", command)
            self.assertIn("--only-binary=:all:", command)
            self.assertNotIn("--no-deps", command)
        self.assertEqual(download[download.index("--index-url") + 1], "https://pypi.org/simple")
        self.assertIn("--no-index", install)
        self.assertNotIn("--index-url", install)
        self.assertEqual(check[-1], "check")

    def test_inherited_indexes_and_python_injections_are_removed(self):
        with patch.dict(runtime.os.environ, {"PIP_EXTRA_INDEX_URL": "https://untrusted.invalid", "PIP_TRUSTED_HOST": "untrusted.invalid",
                "PIP_REQUIREMENT": "/unreviewed", "PYTHONPATH": "/injected", "PYTHONHOME": "/injected", "VIRTUAL_ENV": "/old"}):
            env = runtime.clean_environment()
        for key in ("PIP_EXTRA_INDEX_URL", "PIP_TRUSTED_HOST", "PIP_REQUIREMENT", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"):
            self.assertNotIn(key, env)
        self.assertEqual(env["PIP_CONFIG_FILE"], runtime.os.devnull)

    def test_package_errors_and_timeout_do_not_expose_process_output(self):
        failures = (Mock(return_value=subprocess.CompletedProcess([], 1, "private-token", "private-token")),
                    Mock(side_effect=subprocess.TimeoutExpired("pip", 600)))
        for runner in failures:
            with self.subTest(runner=runner), self.assertRaisesRegex(runtime.RuntimeInstallError, "^RUNTIME_HASH_INSTALL_FAILED$"):
                runtime.command(["pip"], "RUNTIME_HASH_INSTALL_FAILED", runner)

    def test_changed_or_extra_installed_packages_do_not_report_success(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "supported_runtime"):
            root = Path(tmp).resolve()
            for index, versions in enumerate(({**runtime.reviewed_lock(), "requests": "0.0.0"},
                                               {**runtime.reviewed_lock(), "unreviewed-package": "1.0"})):
                builder = Mock()
                runner = Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
                with patch.object(runtime, "installed_versions", return_value=versions):
                    with self.assertRaisesRegex(runtime.RuntimeInstallError, "RUNTIME_INSTALLED_VERSIONS_MISMATCH"):
                        runtime.install(root / str(index), builder, runner)

    def test_download_failure_stops_before_install_and_retains_only_new_staging_path(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "supported_runtime"):
            root, builder = Path(tmp).resolve(), Mock()
            untouched = root / "existing-config"
            untouched.write_text("unchanged")
            runner = Mock(return_value=subprocess.CompletedProcess([], 1, "", "private-diagnostic"))
            with self.assertRaisesRegex(runtime.RuntimeInstallError, "^RUNTIME_WHEEL_DOWNLOAD_FAILED$"):
                runtime.install(root / "new", builder, runner)
            self.assertEqual(runner.call_count, 1)
            self.assertEqual(untouched.read_text(), "unchanged")
            self.assertTrue((root / "new").is_dir())

    def test_success_requires_native_import_and_exact_installed_versions(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime, "supported_runtime"):
            target = Path(tmp).resolve() / "new"
            builder = Mock()
            runner = Mock(side_effect=lambda args, **kwargs: subprocess.CompletedProcess(args, 0,
                json.dumps(runtime.reviewed_lock()) if "-c" in args else "", ""))
            result = runtime.install(target, builder, runner)
            self.assertEqual(result["packages"], 10)
            self.assertTrue(result["nativeImportsVerified"])
            self.assertEqual(result["providerRequests"], 0)
            self.assertEqual(runner.call_count, 4)
            self.assertTrue(all(call.kwargs["timeout"] == 600 for call in runner.call_args_list))


if __name__ == "__main__":
    unittest.main()
