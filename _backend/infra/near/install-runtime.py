"""Install the reviewed Linux verifier dependencies into a NEW explicit venv.

No provider request, environment-file loading, deployment switch or service restart.
The installer preserves a failed staging directory for review; it never deletes it.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import venv


ROOT = Path(__file__).resolve().parent
LOCK_SHA256 = "bdeeaa595eeffad3132113ff2116a8a197dab5ef038759578b5697faef45107d"
PACKAGE = re.compile(r"([a-z0-9][a-z0-9._-]*)==([0-9][a-z0-9.!+_-]*)", re.I)
HASH = re.compile(r"--hash=sha256:[0-9a-f]{64}")


class RuntimeInstallError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise RuntimeInstallError(code)


def canonical_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_requirements(text, hashed):
    result = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        words = line.split()
        pin = PACKAGE.fullmatch(words[0])
        require(pin is not None, "RUNTIME_LOCK_INVALID")
        name, version = canonical_name(pin[1]), pin[2]
        require(name not in result, "RUNTIME_LOCK_INVALID")
        require((len(words) >= 2 and all(HASH.fullmatch(word) for word in words[1:])) if hashed else len(words) == 1,
                "RUNTIME_LOCK_INVALID")
        require(len(set(words[1:])) == len(words[1:]), "RUNTIME_LOCK_INVALID")
        result[name] = version
    require(bool(result), "RUNTIME_LOCK_INVALID")
    return result


def reviewed_lock(lock_path=ROOT / "requirements-linux.lock", direct_path=ROOT / "requirements.txt"):
    # Normalize Git's CRLF checkout convention, never other content changes.
    try:
        raw = lock_path.read_bytes()
        text = raw.decode("utf-8").replace("\r\n", "\n")
        direct = direct_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise RuntimeInstallError("RUNTIME_LOCK_MISSING") from None
    require("\r" not in text and hashlib.sha256(text.encode("utf-8")).hexdigest() == LOCK_SHA256,
            "RUNTIME_LOCK_CHANGED")
    locked = parse_requirements(text, True)
    for name, version in parse_requirements(direct, False).items():
        require(locked.get(name) == version, "RUNTIME_DIRECT_PIN_MISMATCH")
    return locked


def supported_runtime(system=None, machine=None, implementation=None, version=None, libc=None, releaselevel=None):
    system = platform.system() if system is None else system
    machine = platform.machine() if machine is None else machine
    implementation = platform.python_implementation() if implementation is None else implementation
    version = sys.version_info[:2] if version is None else version
    libc = platform.libc_ver() if libc is None else libc
    releaselevel = sys.version_info.releaselevel if releaselevel is None else releaselevel
    require(system == "Linux" and machine.lower() in ("x86_64", "amd64") and implementation == "CPython"
            and tuple(version) in ((3, 11), (3, 12)) and releaselevel == "final", "RUNTIME_PLATFORM_UNSUPPORTED")
    require(libc[0] == "glibc" and re.fullmatch(r"\d+\.\d+(?:\.\d+)?", libc[1]) is not None
            and tuple(map(int, libc[1].split(".")[:2])) >= (2, 28), "RUNTIME_LIBC_UNSUPPORTED")


def new_venv_path(value):
    target = Path(value)
    require(target.is_absolute(), "RUNTIME_VENV_ABSOLUTE_REQUIRED")
    require(not target.exists() and not target.is_symlink(), "RUNTIME_VENV_ALREADY_EXISTS")
    require(target.parent.is_dir() and target == target.resolve(), "RUNTIME_VENV_PATH_UNSAFE")
    return target


def clean_environment():
    result = {key: value for key, value in os.environ.items()
              if not key.startswith("PIP_") and key not in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV")}
    # Disable every pip config source, including a system-wide extra index.
    result["PIP_CONFIG_FILE"] = os.devnull
    return result


def command(args, phase, runner=subprocess.run):
    try:
        result = runner(args, env=clean_environment(), stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8",
                        timeout=600, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeInstallError(phase) from None
    require(result.returncode == 0, phase)
    return result.stdout


def pip_commands(python, wheelhouse, lock_path):
    base = [str(python), "-I", "-m", "pip", "--disable-pip-version-check"]
    rules = ["--require-hashes", "--only-binary=:all:", "--no-input", "--no-cache-dir", "--progress-bar", "off"]
    return [
        base + ["download", "--index-url", "https://pypi.org/simple", "--dest", str(wheelhouse),
                "-r", str(lock_path)] + rules,
        base + ["install", "--no-index", "--find-links", str(wheelhouse), "-r", str(lock_path)] + rules,
        base + ["check"],
    ]


def installed_versions(python, runner=subprocess.run):
    source = ("import importlib.metadata as m,json,re; "
              "import dcap_qvl,cryptography,jwt,requests; "
              "print(json.dumps({re.sub(r'[-_.]+','-',d.metadata['Name']).lower(): d.version "
              "for d in m.distributions() if d.metadata['Name'].lower() not in ('pip','setuptools')}))")
    try:
        result = json.loads(command([str(python), "-I", "-c", source], "RUNTIME_NATIVE_IMPORT_FAILED", runner))
    except (json.JSONDecodeError, TypeError):
        raise RuntimeInstallError("RUNTIME_INSTALL_VERIFICATION_FAILED") from None
    require(isinstance(result, dict), "RUNTIME_INSTALL_VERIFICATION_FAILED")
    return result


def install(target, builder=None, runner=subprocess.run):
    supported_runtime()
    locked = reviewed_lock()
    target = new_venv_path(target)
    # Reserve the new directory atomically. EnvBuilder accepts an existing path,
    # so a check followed by create() could otherwise reuse a competing runtime.
    try:
        target.mkdir(mode=0o700, exist_ok=False)
    except FileExistsError:
        raise RuntimeInstallError("RUNTIME_VENV_ALREADY_EXISTS") from None
    except OSError:
        raise RuntimeInstallError("RUNTIME_VENV_RESERVATION_FAILED") from None
    (builder or venv.EnvBuilder(with_pip=True)).create(target)
    python = target / "bin" / "python"
    wheelhouse = target / "reviewed-wheels"
    wheelhouse.mkdir(mode=0o700)
    for args, phase in zip(pip_commands(python, wheelhouse, ROOT / "requirements-linux.lock"),
                           ("RUNTIME_WHEEL_DOWNLOAD_FAILED", "RUNTIME_HASH_INSTALL_FAILED", "RUNTIME_PIP_CHECK_FAILED")):
        # Recheck reviewed inputs before each operation, including after network download.
        require(reviewed_lock() == locked, "RUNTIME_LOCK_CHANGED")
        command(args, phase, runner)
    require(installed_versions(python, runner) == locked, "RUNTIME_INSTALLED_VERSIONS_MISMATCH")
    require(reviewed_lock() == locked, "RUNTIME_LOCK_CHANGED")
    return {"ok": True, "runtime": "linux-x86_64", "python": str(python),
            "lockSha256": LOCK_SHA256, "packages": len(locked), "hashInstallVerified": True,
            "nativeImportsVerified": True, "providerRequests": 0, "servicesChanged": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venv", required=True, help="Absolute NEW staging virtual environment; its parent must exist")
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.venv)))
        return 0
    except RuntimeInstallError as error:
        print(json.dumps({"ok": False, "error": str(error), "providerRequests": 0, "servicesChanged": 0}))
    except Exception:
        # Never publish pip output, local configuration, credentials or an arbitrary exception.
        print(json.dumps({"ok": False, "error": "RUNTIME_INSTALL_FAILED", "providerRequests": 0, "servicesChanged": 0}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
