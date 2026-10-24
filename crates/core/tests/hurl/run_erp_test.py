#!/usr/bin/env python3
"""Run the ERP Hurl scenario against a fresh, isolated Trailbase instance."""

from __future__ import annotations

import os
import base64
import json
import re
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
HURL_FILE = Path(__file__).with_name("erp.hurl")
ADMIN_EMAIL = "admin@localhost"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run_checked(args: list[str]) -> None:
    subprocess.run(args, cwd=ROOT, check=True)


def main() -> int:
    trail = Path(os.environ.get("TRAIL_BINARY", ROOT / "target/debug/trail"))
    hurl = shutil.which("hurl")
    if not trail.is_file():
        raise SystemExit(f"Trailbase binary missing: {trail}. Build it with `cargo build -p trailbase-cli --bin trail`.")
    if hurl is None:
        raise SystemExit("Hurl is required to run this API integration scenario.")

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="trailbase-erp-hurl-") as tmp:
        depot = Path(tmp) / "depot"
        server_log_path = Path(tmp) / "trailbase.log"
        # Initialize the isolated depot (which creates its first admin), then mint a short-lived
        # token with the CLI. The Hurl file obtains the matching CSRF token from the HTTP status
        # endpoint before calling protected admin routes.
        run_checked([str(trail), "--depot", str(depot), "admin", "list"])
        tokens_text = subprocess.check_output(
            [str(trail), "--depot", str(depot), "user", "mint", ADMIN_EMAIL],
            cwd=ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
        tokens = json.loads(base64.b64decode(tokens_text))

        with server_log_path.open("w+") as server_log:
            server = subprocess.Popen(
                [str(trail), "--depot", str(depot), "run", "--address", f"127.0.0.1:{port}"],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=server_log,
                text=True,
                env={**os.environ, "RUST_LOG": "error"},
            )
            try:
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        server_log.flush()
                        raise RuntimeError(f"Trailbase exited before becoming healthy:\n{server_log_path.read_text()}")
                    try:
                        with urllib.request.urlopen(f"{base}/api/healthcheck", timeout=1) as response:
                            if response.status == 200:
                                break
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(0.25)
                else:
                    raise TimeoutError("Trailbase did not become healthy within 45 seconds")

                hurl_result = subprocess.run(
                    [
                        hurl,
                        "--test",
                        "--error-format",
                        "long",
                        "--max-time",
                        "120",
                        "--file-root",
                        str(ROOT),
                        "--variable",
                        f"base={base}",
                        "--variable",
                        f"auth_token={tokens['auth_token']}",
                        str(HURL_FILE),
                    ],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                )
                if hurl_result.returncode == 0:
                    print(hurl_result.stdout + hurl_result.stderr, end="")
                if hurl_result.returncode:
                    output = hurl_result.stdout + hurl_result.stderr
                    output = re.sub(r"Authorization: Bearer [^'\\s]+", "Authorization: Bearer <redacted>", output)
                    output = re.sub(r"CSRF-Token: [^'\\s]+", "CSRF-Token: <redacted>", output)
                    server_log.flush()
                    raise RuntimeError(
                        f"Hurl failed (exit {hurl_result.returncode}):\n{output[-8000:]}\n"
                        f"Server log:\n{server_log_path.read_text()[-4000:]}"
                    )
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
