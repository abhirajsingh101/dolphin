"""Semantic search for Dolphin's brain, on this computer, with no API key.

GBrain (brain.py) embeds pages and queries through an OpenAI-compatible
endpoint. This runs one: llama.cpp's ``llama-server`` with IBM's
granite-embedding-97m-multilingual-r2 (384 dimensions; English, Korean and
the other major languages), both pinned and checked by sha256, downloaded
with the rest of memory (about 130 MB).

A small proxy in front of it (``/v1/embeddings``) cuts any input longer than
MAX_TOKENS with the server's own tokenizer. The server is sized for that
(a 2,048-token batch keeps it near 500 MB); GBrain's chunks are smaller, but
dense text (Korean) can pass it, and one oversized input would fail the batch.

Both start on first use, on free 127.0.0.1 ports, and stop after IDLE_SECONDS
without a request. The server never outlives the helper: it runs under a
small shell that holds a pipe from the helper and stops it when the pipe
closes, which happens however the helper ends, even when it is killed.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

LLAMA_BUILD = "b11327"  # 2026-10-01
LLAMA_SHA256 = {
    "darwin-aarch64": ("macos-arm64", "4f0c209f176536d720c5ceb9e475efba583de5e783fc0b28389e5dc554ddc8e7"),
    "darwin-x64": ("macos-x64", "70b54c69c06ab11f64e7f660cbdceb93453fdb75ea0a3df41b28f9e7e058b63c"),
    "linux-x64": ("ubuntu-x64", "0f8b6c3e9f3c55420d448ca1c844068577aa9074185226ac0f9d5dd2277cc91a"),
    "linux-aarch64": ("ubuntu-arm64", "3729caae8865df446628580437689d00c9bf635bbe6ad52020faa1d5f60c2616"),
}
MODEL_URL = ("https://huggingface.co/mykor/granite-embedding-97m-multilingual-r2-GGUF/resolve/"
             "45ce642d3fab2033d167ec09641a159010f7d9d9/granite-embedding-97M-multilingual-r2-Q8_0.gguf")
MODEL_SHA256 = "25155b89638e501ac33495fa278d551d7545e1e2f62722a499bba1f064c080f2"
MODEL = "llama-server:granite-97m-r2"  # what GBrain records; the server serves whatever it was given
DIMENSIONS = 384
VERSION = 1  # brain state "embeddings": bump to re-embed with a new model

BATCH_TOKENS = 2048
MAX_TOKENS = 2000
LONG_CHARS = 3000  # shorter inputs cannot reach MAX_TOKENS: they skip the tokenizer
IDLE_SECONDS = 180
START_TIMEOUT = 60


def folder(base: Path) -> Path:
    return base / "embedder"


def _server(base: Path) -> Path:
    return folder(base) / f"llama-{LLAMA_BUILD}" / "llama-server"


def _model(base: Path) -> Path:
    return folder(base) / "granite-97m-r2-q8_0.gguf"


def installed(base: Path) -> bool:
    return _server(base).exists() and _model(base).exists()


def supported(key: str | None) -> bool:
    return key in LLAMA_SHA256


def _sha256(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def install(base: Path, key: str, download: Callable[[str, Path], None]) -> None:
    """Download and check the server and the model. Safe to re-run."""
    from .brain import BrainError

    if key not in LLAMA_SHA256:
        raise BrainError("Semantic search is not available on this platform yet.")
    target = folder(base)
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target) as scratch:
        if not _server(base).exists():
            name, digest = LLAMA_SHA256[key]
            archive = Path(scratch) / "llama.tar.gz"
            download(f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/llama-{LLAMA_BUILD}-bin-{name}.tar.gz", archive)
            if _sha256(archive) != digest:
                raise BrainError("The llama.cpp download did not match its published checksum.")
            unpacked = Path(scratch) / "unpacked"
            with tarfile.open(archive) as bundle:
                prefix = f"llama-{LLAMA_BUILD}/"
                wanted = [member for member in bundle.getmembers()
                          if member.name.startswith(prefix)
                          and (member.name == prefix + "llama-server" or Path(member.name).name.startswith("lib")
                               or member.name == prefix + "LICENSE")]
                bundle.extractall(unpacked, members=wanted, filter="data")
            shutil.rmtree(target / f"llama-{LLAMA_BUILD}", ignore_errors=True)
            os.replace(unpacked / f"llama-{LLAMA_BUILD}", target / f"llama-{LLAMA_BUILD}")
            _server(base).chmod(0o755)
        if not _model(base).exists():
            model = Path(scratch) / "model.gguf"
            download(MODEL_URL, model)
            if _sha256(model) != MODEL_SHA256:
                raise BrainError("The embedding model download did not match its checksum.")
            os.replace(model, _model(base))


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _post(url: str, body: dict[str, Any], timeout: float = 120) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


class Embedder:
    """llama-server plus the trimming proxy, started on demand."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.process: subprocess.Popen | None = None
        self.proxy: ThreadingHTTPServer | None = None
        self.upstream = ""
        self.last_used = 0.0
        self.command: list[str] | None = None  # tests start a fake server instead

    def _trim(self, text: str) -> str:
        if len(text) < LONG_CHARS:
            return text
        status, body = _post(f"{self.upstream}/tokenize", {"content": text})
        tokens = json.loads(body).get("tokens", []) if status == 200 else []
        if len(tokens) <= MAX_TOKENS:
            return text
        status, body = _post(f"{self.upstream}/detokenize", {"tokens": tokens[:MAX_TOKENS]})
        return json.loads(body).get("content", text[:LONG_CHARS]) if status == 200 else text[:LONG_CHARS]

    def _handler(self):
        embedder = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # quiet
                pass

            def _send(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                embedder.last_used = time.monotonic()
                try:
                    with urllib.request.urlopen(embedder.upstream + self.path, timeout=30) as response:
                        self._send(response.status, response.read())
                except urllib.error.HTTPError as error:
                    self._send(error.code, error.read())
                except OSError:
                    self._send(502, b'{"error": "embedding server unavailable"}')

            def do_POST(self) -> None:
                embedder.last_used = time.monotonic()
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                    if self.path.rstrip("/").endswith("/embeddings") and isinstance(body, dict):
                        texts = body.get("input")
                        if isinstance(texts, str):
                            body["input"] = embedder._trim(texts)
                        elif isinstance(texts, list):
                            body["input"] = [embedder._trim(t) if isinstance(t, str) else t for t in texts]
                    status, answer = _post(embedder.upstream + self.path, body, timeout=300)
                    self._send(status, answer)
                except (OSError, ValueError) as error:
                    self._send(502, json.dumps({"error": f"embedding server unavailable: {error}"}).encode())

        return Handler

    def _start(self, base: Path) -> None:
        port = _free_port()
        command = self.command or [
            str(_server(base)), "-m", str(_model(base)), "--embeddings", "--pooling", "cls",
            "--host", "127.0.0.1", "--port", str(port), "--parallel", "1", "--threads", "2",
            "-c", str(BATCH_TOKENS), "-b", str(BATCH_TOKENS), "-ub", str(BATCH_TOKENS), "-fa", "on",
        ]
        command = [part.replace("{port}", str(port)) for part in command]
        # The shell reads the pipe until the helper closes it, then stops the server.
        guard = '"$@" </dev/null & child=$!; trap \'kill $child 2>/dev/null\' TERM; read _; kill $child 2>/dev/null; wait $child'
        self.process = subprocess.Popen(["/bin/sh", "-c", guard, "embedder", *command],
                                        cwd=str(_server(base).parent) if not self.command else None,
                                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                        start_new_session=True)
        self.upstream = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                break
            try:
                with urllib.request.urlopen(self.upstream + "/health", timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            time.sleep(0.25)
        else:
            self._stop()
            raise OSError("The embedding server did not start.")
        if self.process.poll() is not None:
            self._stop()
            raise OSError("The embedding server exited at start.")
        self.proxy = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.proxy.daemon_threads = True
        threading.Thread(target=self.proxy.serve_forever, name="embedder-proxy", daemon=True).start()
        threading.Thread(target=self._watch, name="embedder-idle", daemon=True).start()

    def _watch(self) -> None:
        proxy = self.proxy
        while True:
            time.sleep(min(30, IDLE_SECONDS))
            with self.lock:
                if self.proxy is not proxy:
                    return
                if time.monotonic() - self.last_used >= IDLE_SECONDS:
                    self._stop()
                    return

    def url(self, base: Path) -> str:
        """The proxy's base URL (``…/v1``), starting everything if needed."""
        with self.lock:
            if self.process is None or self.process.poll() is not None or self.proxy is None:
                self._stop()
                self._start(base)
            self.last_used = time.monotonic()
            return f"http://127.0.0.1:{self.proxy.server_address[1]}/v1"

    def _stop(self) -> None:
        proxy, self.proxy = self.proxy, None
        if proxy is not None:
            proxy.shutdown()
            proxy.server_close()
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            try:
                process.stdin.close()  # type: ignore[union-attr]  # the shell stops the server
            except OSError:
                pass
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()

    def stop(self) -> None:
        with self.lock:
            self._stop()


embedder = Embedder()
atexit.register(embedder.stop)
