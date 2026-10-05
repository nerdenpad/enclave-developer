import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("enclave_security", Path(__file__).with_name("run-security.py"))
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)


def finding():
    return {"check": "arbitrary-send-erc20", "impact": "High", "confidence": "High", "elements": [
        {"type": "function", "name": "_pay", "source_mapping": {"filename_relative": "_backend/contracts/src/UsageMeter.sol",
            "filename_absolute": "/host/one/UsageMeter.sol", "start": 100, "length": 40}}]}


class SecurityGuardTests(unittest.TestCase):
    def setUp(self):
        self.item = finding()
        self.hashes = {"_backend/contracts/src/UsageMeter.sol": "a" * 64}
        self.entry = {"fingerprint": scanner.finding_key(self.item), "check": self.item["check"], "impact": "High",
            "sourceHashes": dict(self.hashes), "rationale": "Authorized-payer transfer guard reviewed.",
            "tests": ["UsageMeter authorization regression"]}
        self.policy = {"schemaVersion": 1, "accepted": [self.entry]}

    def test_exact_reviewed_finding_is_accepted(self):
        blocking, reviewed = scanner.triage_findings([self.item], self.hashes, self.policy)
        self.assertEqual(blocking, [])
        self.assertEqual(reviewed, [self.entry["fingerprint"]])

    def test_exception_must_bind_every_reported_source_file(self):
        unrelated = "_backend/contracts/src/FeeVault.sol"
        self.hashes[unrelated] = "b" * 64
        self.entry["sourceHashes"] = {unrelated: "b" * 64}
        with self.assertRaisesRegex(scanner.SecurityCheckError, "TRIAGE_SOURCE_SCOPE_INCOMPLETE"):
            scanner.triage_findings([self.item], self.hashes, self.policy)

    def test_different_host_paths_do_not_change_source_identity(self):
        other = copy.deepcopy(self.item)
        other["elements"][0]["source_mapping"]["filename_absolute"] = "C:/other/host/UsageMeter.sol"
        self.assertEqual(scanner.finding_key(other), scanner.finding_key(self.item))

    def test_new_high_medium_finding_stays_blocking(self):
        other = copy.deepcopy(self.item)
        other["elements"][0]["name"] = "unsafe_new_function"
        blocking, _ = scanner.triage_findings([self.item, other], self.hashes, self.policy)
        self.assertEqual(blocking, [scanner.finding_key(other)])

    def test_source_change_invalidates_exception(self):
        with self.assertRaisesRegex(scanner.SecurityCheckError, "TRIAGE_SOURCE_CHANGED"):
            scanner.triage_findings([self.item], {next(iter(self.hashes)): "b" * 64}, self.policy)

    def test_changed_detector_elements_invalidate_exception(self):
        changed = copy.deepcopy(self.item)
        changed["elements"][0]["source_mapping"]["start"] += 1
        with self.assertRaisesRegex(scanner.SecurityCheckError, "TRIAGE_FINDING_CHANGED"):
            scanner.triage_findings([changed], self.hashes, self.policy)

    def test_wrong_detector_cannot_be_accepted_by_matching_fingerprint(self):
        self.entry["check"] = "different-check"
        blocking, reviewed = scanner.triage_findings([self.item], self.hashes, self.policy)
        self.assertEqual(reviewed, [])
        self.assertEqual(blocking, [scanner.finding_key(self.item)])

    def test_duplicate_exception_and_missing_rationale_or_test_are_rejected(self):
        self.policy["accepted"].append(copy.deepcopy(self.entry))
        with self.assertRaisesRegex(scanner.SecurityCheckError, "TRIAGE_ENTRY_INVALID"):
            scanner.triage_findings([self.item], self.hashes, self.policy)
        for key in ("rationale", "tests", "sourceHashes"):
            policy = copy.deepcopy({"schemaVersion": 1, "accepted": [self.entry]})
            policy["accepted"][0][key] = None
            with self.subTest(key=key), self.assertRaisesRegex(scanner.SecurityCheckError, "TRIAGE_ENTRY_INVALID"):
                scanner.triage_findings([self.item], self.hashes, policy)

    def test_findings_cannot_escape_contract_source(self):
        for name in ("../secret.sol", "/etc/secret.sol", "_backend/contracts/src/../private.sol", "frontend/src/a.sol"):
            item = copy.deepcopy(self.item)
            item["elements"][0]["source_mapping"]["filename_relative"] = name
            with self.subTest(name=name), self.assertRaisesRegex(scanner.SecurityCheckError, "FINDING_PATH_INVALID"):
                scanner.finding_key(item)

    def test_scanner_timeout_is_sanitized(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scanner, "OUTPUT", Path(directory) / "results"), \
                patch.object(scanner.subprocess, "run", side_effect=subprocess.TimeoutExpired(["secret-sentinel"], 1)):
            with self.assertRaisesRegex(scanner.SecurityCheckError, "SCANNER_EXECUTION_FAILED") as raised:
                scanner.execute(["fixture"], scanner.OUTPUT / "report.json", "fixture")
            self.assertNotIn("sentinel", str(raised.exception))

    def test_missing_or_malformed_report_fails_closed(self):
        for content in (None, b"invalid-json"):
            with tempfile.TemporaryDirectory() as directory, patch.object(scanner, "OUTPUT", Path(directory) / "results"):
                report = scanner.OUTPUT / "report.json"
                def process(*args, **kwargs):
                    if content is not None:
                        report.write_bytes(content)
                    return subprocess.CompletedProcess([], 0, b"", b"")
                with patch.object(scanner.subprocess, "run", side_effect=process):
                    with self.subTest(content=content), self.assertRaises(scanner.SecurityCheckError):
                        scanner.execute(["fixture"], report, "fixture")

    def test_no_shell_and_scanner_output_remains_private(self):
        sentinel = b"do-not-print" + b"-private-sentinel"
        with tempfile.TemporaryDirectory() as directory, patch.object(scanner, "OUTPUT", Path(directory) / "results"):
            report = scanner.OUTPUT / "report.json"
            def process(*args, **kwargs):
                self.assertFalse(kwargs["shell"])
                self.assertTrue(kwargs["capture_output"])
                self.assertEqual(kwargs["env"]["SEMGREP_SEND_METRICS"], "off")
                report.write_text("[]")
                return subprocess.CompletedProcess([], 1, sentinel, sentinel)
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(scanner.subprocess, "run", side_effect=process), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code, value = scanner.execute(["fixture"], report, "fixture")
            self.assertEqual((code, value), (1, []))
            self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
            self.assertEqual((scanner.OUTPUT / "fixture.stderr.private.txt").read_bytes(), sentinel)

    def test_existing_report_is_not_overwritten_or_scanned(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scanner, "OUTPUT", Path(directory) / "results"), \
                patch.object(scanner.subprocess, "run") as process:
            scanner.prepare_output()
            report = scanner.OUTPUT / "report.json"
            report.write_text("existing")
            with self.assertRaisesRegex(scanner.SecurityCheckError, "REPORT_ALREADY_EXISTS"):
                scanner.execute(["fixture"], report, "fixture")
            process.assert_not_called()
            self.assertEqual(report.read_text(), "existing")

    def test_low_findings_are_reported_without_medium_high_exception(self):
        self.item["impact"] = "Low"
        blocking, reviewed = scanner.triage_findings([self.item], self.hashes, {"schemaVersion": 1, "accepted": []})
        self.assertEqual((blocking, reviewed), ([], []))

    def fixture_report(self, path):
        expected = [(line.split("ruleid:", 1)[1].strip(), number + 1) for number, line in
            enumerate(path.read_text().splitlines(), 1) if "ruleid:" in line]
        return {"results": [{"check_id": name, "start": {"line": number}} for name, number in expected], "errors": []}

    def test_all_positive_and_negative_fixture_annotations_are_checked(self):
        for path in sorted((scanner.CONFIG / "fixtures").glob("semgrep.*")):
            positive, negative = scanner.verify_rule_fixture(path, self.fixture_report(path))
            self.assertGreater(positive, 0)
            self.assertGreater(negative, 0)

    def test_empty_successful_scanner_output_is_not_a_fixture_pass(self):
        path = scanner.CONFIG / "fixtures/semgrep.ts"
        with self.assertRaisesRegex(scanner.SecurityCheckError, "RULE_FIXTURE_EXPECTATION_FAILED"):
            scanner.verify_rule_fixture(path, {"results": [], "errors": []})

    def test_false_positive_and_scanner_errors_fail_fixture_check(self):
        path = scanner.CONFIG / "fixtures/semgrep.ts"
        report = self.fixture_report(path)
        report["results"].append({"check_id": "enclave-node-tls-verification-disabled", "start": {"line": 4}})
        with self.assertRaisesRegex(scanner.SecurityCheckError, "RULE_FIXTURE_EXPECTATION_FAILED"):
            scanner.verify_rule_fixture(path, report)
        report = self.fixture_report(path)
        report["errors"].append({"type": "parse error"})
        with self.assertRaisesRegex(scanner.SecurityCheckError, "RULE_FIXTURE_SCAN_INVALID"):
            scanner.verify_rule_fixture(path, report)

    def test_secret_findings_and_failed_process_never_produce_pass(self):
        sentinel = "do-not-print" + "-fixture-secret"
        for code, findings in [(1, [{"RuleID": "generic-api-key", "Secret": sentinel, "Match": sentinel}]), (2, [])]:
            output = io.StringIO()
            with patch.object(scanner, "tool", return_value="fixture"), patch.object(scanner, "execute", return_value=(code, findings)), \
                    patch.object(scanner, "write_summary") as summary, contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(scanner.SecurityCheckError, "SECRET_SCAN_FAILED"):
                    scanner.secrets()
            value = summary.call_args.args[1]
            self.assertFalse(value["passed"])
            self.assertNotIn(sentinel, json.dumps(value) + output.getvalue())

    def test_static_empty_scan_does_not_pass_as_no_findings(self):
        report = {"results": [], "errors": [], "paths": {"scanned": []}}
        with patch.object(scanner, "tool", return_value="fixture"), patch.object(scanner, "execute", return_value=(0, report)):
            with self.assertRaisesRegex(scanner.SecurityCheckError, "STATIC_SCAN_EMPTY"):
                scanner.semgrep()


if __name__ == "__main__":
    unittest.main()
