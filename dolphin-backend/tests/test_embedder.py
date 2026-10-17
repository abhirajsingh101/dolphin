"""Search by meaning (app/embedder.py): a checked download, and a proxy that
keeps every input within what the embedding server can take."""

from __future__ import annotations

import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path

import pytest

from app import brain, embedder

FAKE_LLAMA = r'''
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[1])
seen = sys.argv[2]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        self.reply({"status": "ok"} if self.path == "/health" else {"data": [{"id": "granite"}]})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/tokenize":   # one token per character
            return self.reply({"tokens": list(range(len(body["content"])))})
        if self.path == "/detokenize":
            return self.reply({"content": "t" * len(body["tokens"])})
        texts = body["input"] if isinstance(body["input"], list) else [body["input"]]
        open(seen, "a").write(json.dumps([len(t) for t in texts]) + "\n")
        if any(len(t) > 2000 for t in texts):
            return self.reply({"error": {"message": "input is too large to process"}}, 500)
        self.reply({"data": [{"index": i, "embedding": [0.1, 0.2]} for i, _ in enumerate(texts)]})

HTTPServer(("127.0.0.1", port), H).serve_forever()
'''


@pytest.fixture
def running(tmp_path, monkeypatch):
    script, seen = tmp_path / "fake_llama.py", tmp_path / "seen"
    script.write_text(FAKE_LLAMA)
    instance = embedder.Embedder()
    instance.command = [sys.executable, str(script), "{port}", str(seen)]
    yield instance, seen
    instance.stop()


def _embed(url: str, texts) -> dict:
    request = urllib.request.Request(url + "/embeddings", data=json.dumps({"input": texts, "model": "granite"}).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def test_the_proxy_cuts_inputs_the_server_could_not_take(running, tmp_path, monkeypatch):
    instance, seen = running
    monkeypatch.setattr(embedder, "LONG_CHARS", 1000)
    url = instance.url(tmp_path)
    answer = _embed(url, ["short", "x" * 1500, "y" * 5000])
    assert len(answer["data"]) == 3
    assert json.loads(seen.read_text().splitlines()[-1]) == [5, 1500, embedder.MAX_TOKENS]
    assert _embed(url, "one string")["data"][0]["embedding"] == [0.1, 0.2]
    assert instance.url(tmp_path) == url  # still running: the same address


def test_an_idle_server_stops_and_the_next_use_starts_it_again(running, tmp_path, monkeypatch):
    instance, _ = running
    monkeypatch.setattr(embedder, "IDLE_SECONDS", 0.5)
    instance.url(tmp_path)
    process = instance.process
    process.wait(timeout=10)  # the idle watcher stops it
    assert instance.process is None and instance.proxy is None
    again = instance.url(tmp_path)
    assert instance.process is not process and _embed(again, ["a"])["data"]


def _llama_tarball() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in [("llama-server", b"#!/bin/sh\n"), ("libggml.so", b"lib"), ("llama-cli", b"not needed"),
                           ("LICENSE", b"MIT")]:
            info = tarfile.TarInfo(f"llama-{embedder.LLAMA_BUILD}/{name}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def test_install_checks_both_downloads_and_keeps_only_the_server(tmp_path, monkeypatch):
    tarball, model = _llama_tarball(), b"gguf model"
    monkeypatch.setattr(embedder, "LLAMA_SHA256", {"linux-x64": ("ubuntu-x64", hashlib.sha256(tarball).hexdigest())})
    monkeypatch.setattr(embedder, "MODEL_SHA256", hashlib.sha256(model).hexdigest())
    fetched = []

    def download(url, target):
        fetched.append(url)
        Path(target).write_bytes(model if url == embedder.MODEL_URL else tarball)

    embedder.install(tmp_path, "linux-x64", download)
    server = embedder._server(tmp_path)
    assert embedder.installed(tmp_path) and server.stat().st_mode & 0o111
    assert sorted(p.name for p in server.parent.iterdir()) == ["LICENSE", "libggml.so", "llama-server"]
    embedder.install(tmp_path, "linux-x64", download)
    assert len(fetched) == 2  # nothing downloaded twice

    monkeypatch.setattr(embedder, "MODEL_SHA256", "0" * 64)
    embedder._model(tmp_path).unlink()
    with pytest.raises(brain.BrainError, match="checksum"):
        embedder.install(tmp_path, "linux-x64", download)
    assert not embedder._model(tmp_path).exists()


def test_the_server_stops_when_the_process_that_started_it_dies(tmp_path):
    script, seen = tmp_path / "fake_llama.py", tmp_path / "seen"
    script.write_text(FAKE_LLAMA)
    starter = tmp_path / "starter.py"
    starter.write_text(f"""
import os, sys
sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})
from app import embedder
e = embedder.embedder
e.command = [{sys.executable!r}, {str(script)!r}, "{{port}}", {str(seen)!r}]
url = e.url(__import__("pathlib").Path({str(tmp_path)!r}))
print(url, flush=True)
os._exit(0)  # no cleanup at all, as if killed
""")
    import subprocess
    import time

    url = subprocess.run([sys.executable, str(starter)], capture_output=True, text=True, timeout=60).stdout.strip()
    assert url.startswith("http://127.0.0.1:")
    deadline = time.monotonic() + 10
    survivors = None
    while time.monotonic() < deadline:
        survivors = subprocess.run(["pgrep", "-f", str(script)], capture_output=True, text=True).stdout.split()
        if not survivors:
            break
        time.sleep(0.2)
    assert not survivors, "the embedding server outlived the helper"
