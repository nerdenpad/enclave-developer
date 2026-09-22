"""Create a local inference key, then upload only that key to a new Modal Secret.

No token values are printed or put in subprocess arguments. Cloud upload is an
explicit second command and never replaces an existing named Secret.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import secrets
import sys

ROOT = Path(__file__).resolve().parents[1]
SECRET_NAME = "enclave-inference"
KEY_NAME = "INFERENCE_API_KEY"
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}\Z")


def init_config(target: Path, template: Path = ROOT / ".env.modal.example") -> None:
    """Preserve the complete development profile, including its health warmup path."""
    text = template.read_text(encoding="utf-8")
    if text.count(f"\n{KEY_NAME}=\n") != 1:
        raise ValueError("Expected exactly one empty inference key in the template")
    text = text.replace(f"\n{KEY_NAME}=\n", f"\n{KEY_NAME}={secrets.token_urlsafe(32)}\n")
    # Exclusive creation avoids silently changing the key on a repeated command.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        output.write(text)


def read_key(target: Path) -> str:
    values = [line.split("=", 1)[1] for line in target.read_text(encoding="utf-8-sig").splitlines()
              if line.startswith(f"{KEY_NAME}=")]
    if len(values) != 1 or not TOKEN_PATTERN.fullmatch(values[0]):
        raise ValueError("Expected one INFERENCE_API_KEY with 32-256 base64url/hex characters")
    return values[0]


def upload_config(target: Path, environment: str | None = None, manager=None) -> None:
    key = read_key(target)
    if manager is None:
        import modal
        manager = modal.Secret.objects
    manager.create(SECRET_NAME, {KEY_NAME: key}, allow_existing=False, environment_name=environment)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "upload"))
    parser.add_argument("--config", type=Path, default=ROOT / ".env.modal")
    parser.add_argument("--environment", help="Modal environment; use the same one when deploying")
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            init_config(args.config)
            print(f"Created {args.config.resolve()}. Key saved locally; no values printed.")
            print("Next: authenticate Modal, then run this script with upload. Set INFERENCE_BASE_URL after deployment.")
        else:
            upload_config(args.config, args.environment)
            print(f"Created Modal Secret {SECRET_NAME} with {KEY_NAME}. No values printed.")
        return 0
    except FileExistsError:
        print("Config already exists; preserved without changing its key. Use upload with the existing file.", file=sys.stderr)
    except (FileNotFoundError, ValueError):
        print("Missing or invalid config/template. Run init first and check the required key format; no values printed.", file=sys.stderr)
    except ImportError:
        print("Install infra/modal/requirements.txt into the local virtual environment, then retry with that Python.", file=sys.stderr)
    except Exception:
        # Provider errors can contain credentials. Do not print their message or traceback.
        print("Modal secret creation was not confirmed. Check login, workspace/environment and whether enclave-inference already exists. "
              "A timed-out request may have succeeded remotely; inspect Secrets before retrying. "
              "Existing secrets are never overwritten and the local key is preserved.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
