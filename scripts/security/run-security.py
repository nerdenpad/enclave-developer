"""Offline source checks; only tool installation downloads pinned public binaries."""
import argparse
from collections import Counter
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / ".github/security"
OUTPUT = ROOT / ".local/security-results"
TOOLS = ROOT / ".local/security-tools"
TARGETS = ("_backend/apps", "_backend/packages", "_backend/infra", "frontend/src", "scripts")


class SecurityCheckError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise SecurityCheckError(code)


def digest(value):
    return hashlib.sha256(value).hexdigest()


def source_bytes(path):
    require(path.is_file() and not path.is_symlink(), "SOURCE_FILE_INVALID")
    return path.read_text(encoding="utf-8").encode("utf-8")


def json_file(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SecurityCheckError("REPORT_OR_CONFIG_INVALID") from None


def prepare_output():
    require(not OUTPUT.is_symlink() and not OUTPUT.parent.is_symlink(), "OUTPUT_PATH_INVALID")
    OUTPUT.mkdir(parents=True, exist_ok=True, mode=0o700)


def tool(name):
    suffix = ".exe" if sys.platform == "win32" else ""
    pinned = TOOLS / (name + suffix)
    sibling = Path(sys.executable).with_name(name + suffix)
    executable = next((str(path) for path in (pinned, sibling) if path.is_file() and not path.is_symlink()), None) or shutil.which(name)
    require(executable, "SCANNER_NOT_INSTALLED")
    return executable


def install(name):
    require(name in ("gitleaks", "solc"), "TOOL_NOT_ALLOWED")
    require(platform.machine().lower() in ("amd64", "x86_64"), "TOOL_PLATFORM_UNSUPPORTED")
    system = "windows" if sys.platform == "win32" else "linux"
    require(sys.platform == "win32" or sys.platform.startswith("linux"), "TOOL_PLATFORM_UNSUPPORTED")
    pin = json_file(CONFIG / "tool-pins.json")[name][system]
    require(pin["url"].startswith(("https://github.com/gitleaks/gitleaks/releases/download/", "https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/")), "DOWNLOAD_ORIGIN_INVALID")
    with urllib.request.urlopen(pin["url"], timeout=60) as response:
        data = response.read(100_000_001)
    require(len(data) <= 100_000_000 and digest(data) == pin["sha256"], "TOOL_DOWNLOAD_HASH_MISMATCH")
    suffix = ".exe" if system == "windows" else ""
    if name == "gitleaks":
        filename = name + suffix
        if system == "windows":
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                binary = archive.read(filename)
        else:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                member = archive.getmember(filename)
                require(member.isfile() and not member.islnk(), "TOOL_ARCHIVE_INVALID")
                binary = archive.extractfile(member).read()
    else:
        binary = data
    require(not TOOLS.is_symlink() and not TOOLS.parent.is_symlink(), "TOOL_PATH_INVALID")
    TOOLS.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = TOOLS / (name + suffix)
    require(not target.exists() and not target.is_symlink(), "TOOL_ALREADY_INSTALLED")
    with target.open("xb") as handle:
        handle.write(binary)
    target.chmod(0o700)
    print(json.dumps({"tool": name, "downloadHashVerified": True}))


def execute(command, report, label, timeout=360):
    prepare_output()
    require(not report.exists() and not report.is_symlink(), "REPORT_ALREADY_EXISTS")
    environment = {**os.environ, "SEMGREP_SEND_METRICS": "off", "SEMGREP_ENABLE_VERSION_CHECK": "0"}
    try:
        result = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True, timeout=timeout, shell=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SecurityCheckError("SCANNER_EXECUTION_FAILED") from None
    # Scanner diagnostics may contain source or credentials. Keep them private and
    # never echo them or upload them as CI artifacts.
    for stream in ("stdout", "stderr"):
        path = OUTPUT / (label + "." + stream + ".private.txt")
        require(not path.exists() and not path.is_symlink(), "DIAGNOSTIC_ALREADY_EXISTS")
        with path.open("xb") as handle:
            handle.write(getattr(result, stream))
        path.chmod(0o600)
    require(report.is_file() and not report.is_symlink(), "SCANNER_REPORT_MISSING")
    report.chmod(0o600)
    return result.returncode, json_file(report)


def write_summary(name, value):
    target = OUTPUT / (name + "-summary.json")
    require(not target.exists() and not target.is_symlink(), "SUMMARY_ALREADY_EXISTS")
    with target.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    print(json.dumps(value))


def secrets():
    report = OUTPUT / "gitleaks.redacted.private.json"
    code, findings = execute([tool("gitleaks"), "git", str(ROOT), "--log-opts=--all", "--redact=100",
        "--ignore-gitleaks-allow", "--config", str(CONFIG / "gitleaks.toml"),
        "--gitleaks-ignore-path", str(CONFIG / "gitleaksignore"), "--no-banner", "--no-color", "--log-level=error",
        "--timeout=300", "--report-format=json", "--report-path", str(report)], report, "gitleaks")
    require(isinstance(findings, list), "SECRET_REPORT_INVALID")
    summary = {"scanner": "gitleaks", "scope": "all fetched Git history", "findings": len(findings),
        "rules": dict(Counter(f.get("RuleID", "unknown") for f in findings)), "redacted": True,
        "passed": code == 0 and not findings}
    write_summary("secrets", summary)
    require(summary["passed"], "SECRET_SCAN_FAILED")


def semgrep():
    report = OUTPUT / "semgrep.private.json"
    command = [tool("semgrep"), "scan", "--config", ".github/security/semgrep.yml", "--metrics=off",
        "--disable-version-check", "--no-rewrite-rule-ids", "--json", "--output", report.relative_to(ROOT).as_posix(), "--error", "--strict", "--timeout=20",
        "--exclude=**/*.test.*", "--exclude=**/*.spec.*", "--exclude=**/test_*.py",
        "--exclude=**/node_modules/**", "--exclude=**/.venv/**", "--exclude=**/venv/**",
        "--exclude=**/fixtures/**", "--exclude=**/*.private.*", "--exclude=**/__pycache__/**", *TARGETS]
    code, value = execute(command, report, "semgrep")
    require(isinstance(value, dict) and isinstance(value.get("results"), list) and isinstance(value.get("errors"), list), "STATIC_REPORT_INVALID")
    scanned = value.get("paths", {}).get("scanned")
    require(isinstance(scanned, list) and scanned, "STATIC_SCAN_EMPTY")
    summary = {"scanner": "semgrep", "scope": list(TARGETS), "findings": len(value["results"]),
        "scannedFiles": len(scanned), "errors": len(value["errors"]), "rules": dict(Counter(f.get("check_id", "unknown") for f in value["results"])),
        "passed": code == 0 and not value["results"] and not value["errors"]}
    write_summary("semgrep", summary)
    require(summary["passed"], "STATIC_SCAN_FAILED")


def verify_rule_fixture(path, report):
    expected, negative = set(), set()
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for marker, destination in (("ruleid:", expected), ("ok:", negative)):
            if marker in line:
                destination.add((line.split(marker, 1)[1].strip(), number + 1))
    require(expected and negative, "RULE_FIXTURE_EMPTY")
    require(isinstance(report.get("results"), list) and report.get("errors") == [], "RULE_FIXTURE_SCAN_INVALID")
    observed = {(item["check_id"], item["start"]["line"]) for item in report["results"]}
    require(observed == expected and not (observed & negative), "RULE_FIXTURE_EXPECTATION_FAILED")
    return len(expected), len(negative)


def semgrep_rules():
    totals = [0, 0]
    for suffix in ("ts", "py"):
        path = CONFIG / "fixtures" / ("semgrep." + suffix)
        report = OUTPUT / ("semgrep-rules-" + suffix + ".private.json")
        code, value = execute([tool("semgrep"), "scan", "--config", ".github/security/semgrep.yml", "--metrics=off",
            "--disable-version-check", "--no-rewrite-rule-ids", "--strict", "--json", "--output", report.relative_to(ROOT).as_posix(),
            path.relative_to(ROOT).as_posix()], report, "semgrep-rules-" + suffix)
        require(code == 0 and isinstance(value, dict), "RULE_FIXTURE_SCAN_FAILED")
        positive, negative = verify_rule_fixture(path, value)
        totals[0] += positive
        totals[1] += negative
    write_summary("semgrep-rules", {"scanner": "semgrep", "positiveFixtures": totals[0], "negativeFixtures": totals[1], "passed": True})


def finding_key(finding):
    elements = []
    for element in finding["elements"]:
        mapping = element["source_mapping"]
        name = mapping["filename_relative"].replace("\\", "/")
        path = PurePosixPath(name)
        require(not path.is_absolute() and ".." not in path.parts and name.startswith("_backend/contracts/src/"), "FINDING_PATH_INVALID")
        elements.append({"type": element["type"], "name": element["name"], "file": name,
            "start": mapping["start"], "length": mapping["length"]})
    return digest(json.dumps({"check": finding["check"], "impact": finding["impact"], "confidence": finding["confidence"],
        "elements": elements}, sort_keys=True, separators=(",", ":")).encode())


def triage_findings(findings, source_hashes, policy):
    require(policy.get("schemaVersion") == 1 and isinstance(policy.get("accepted"), list), "TRIAGE_POLICY_INVALID")
    accepted = {}
    for entry in policy["accepted"]:
        require(entry["fingerprint"] not in accepted and entry.get("rationale") and entry.get("tests") and entry.get("sourceHashes"), "TRIAGE_ENTRY_INVALID")
        require(all(source_hashes.get(name) == expected for name, expected in entry["sourceHashes"].items()), "TRIAGE_SOURCE_CHANGED")
        accepted[entry["fingerprint"]] = entry
    blocking, reviewed, seen = [], [], set()
    for finding in findings:
        if finding["impact"] not in ("High", "Medium"):
            continue
        key = finding_key(finding)
        seen.add(key)
        entry = accepted.get(key)
        if entry and entry["check"] == finding["check"] and entry["impact"] == finding["impact"]:
            paths = {element["source_mapping"]["filename_relative"].replace("\\", "/") for element in finding["elements"]}
            require(paths <= set(entry["sourceHashes"]), "TRIAGE_SOURCE_SCOPE_INCOMPLETE")
            reviewed.append(key)
        else:
            blocking.append(key)
    require(set(accepted) <= seen, "TRIAGE_FINDING_CHANGED")
    return blocking, reviewed


def slither():
    prepare_output()
    sources = {path.relative_to(ROOT).as_posix(): {"content": source_bytes(path).decode()}
        for path in sorted((ROOT / "_backend/contracts/src").rglob("*.sol"))}
    require(sources and len(sources) <= 256, "SOLIDITY_SOURCE_SET_INVALID")
    input_path = OUTPUT / "slither-input.private.json"
    require(not input_path.exists() and not input_path.is_symlink(), "COMPILER_INPUT_ALREADY_EXISTS")
    with input_path.open("x", encoding="utf-8") as handle:
        json.dump({"language": "Solidity", "sources": sources, "settings": {"optimizer": {"enabled": True, "runs": 200},
            "viaIR": True, "outputSelection": {"*": {"*": ["abi", "evm.bytecode", "evm.deployedBytecode"], "": ["ast"]}}}}, handle)
    input_path.chmod(0o600)
    report = OUTPUT / "slither.private.json"
    code, value = execute([tool("slither"), str(input_path), "--compile-force-framework=solc-json", "--solc", tool("solc"),
        "--config-file", str(CONFIG / "slither.config.json"), "--json", str(report), "--disable-color"], report, "slither")
    require(value.get("success") is True and value.get("error") is None and code in (0, 255, 1, 4294967295), "SOLIDITY_ANALYSIS_FAILED")
    findings = value.get("results", {}).get("detectors")
    require(isinstance(findings, list), "SOLIDITY_REPORT_INVALID")
    source_hashes = {name: digest(value["content"].encode()) for name, value in sources.items()}
    require(all(digest(source_bytes(ROOT / name)) == pin for name, pin in source_hashes.items()), "SOURCE_CHANGED_DURING_SCAN")
    blocking, reviewed = triage_findings(findings, source_hashes, json_file(CONFIG / "slither-triage.json"))
    summary = {"scanner": "slither", "scope": "contract src; test/script/lib and mock-only findings excluded",
        "findings": len(findings), "byImpact": dict(Counter(f["impact"] for f in findings)),
        "reviewedHighMedium": len(reviewed), "unreviewedHighMedium": len(blocking), "passed": not blocking}
    write_summary("slither", summary)
    require(summary["passed"], "SOLIDITY_FINDINGS_REQUIRE_REVIEW")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("check", choices=("install-gitleaks", "install-solc", "secrets", "semgrep", "semgrep-rules", "slither"))
    args = parser.parse_args()
    try:
        if args.check.startswith("install-"):
            install(args.check.removeprefix("install-"))
        else:
            globals()[args.check.replace("-", "_")]()
    except SecurityCheckError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
