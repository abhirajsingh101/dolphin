"""Proxy helpers for Dolphin's private local speech recognition service."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ASR_URL = os.getenv("DOLPHIN_ASR_URL", "http://127.0.0.1:8411").rstrip("/")
MAX_AUDIO_BYTES = int(os.getenv("DOLPHIN_ASR_MAX_AUDIO_BYTES", str(16 * 1024 * 1024)))


class DictationServiceError(Exception):
    def __init__(self, detail: str, status_code: int = 502):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


def _json_request(
    path: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float,
) -> dict[str, Any]:
    request = Request(
        f"{ASR_URL}{path}",
        data=data,
        headers=headers or {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = f"Speech recognition returned HTTP {exc.code}."
        try:
            error_payload = json.loads(exc.read().decode("utf-8"))
            detail = str(error_payload.get("detail") or detail)
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            pass
        status_code = exc.code if 400 <= exc.code < 500 else 502
        raise DictationServiceError(detail, status_code=status_code) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise DictationServiceError(
            "Local speech recognition is unavailable. Check dolphin-asr.service.",
            status_code=503,
        ) from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DictationServiceError("Speech recognition returned an invalid response.") from exc

    if not isinstance(payload, dict):
        raise DictationServiceError("Speech recognition returned an invalid response.")
    return payload


async def dictation_status() -> dict[str, Any]:
    try:
        payload = await asyncio.to_thread(
            _json_request,
            "/health",
            timeout=2.0,
        )
        return {"available": True, **payload}
    except DictationServiceError as exc:
        return {
            "available": False,
            "ready": False,
            "status": "unavailable",
            "detail": exc.detail,
        }


async def transcribe_audio(
    audio: bytes,
    *,
    content_type: str,
    filename: str,
    language: str | None,
    preview: bool = False,
) -> dict[str, Any]:
    if not audio:
        raise DictationServiceError("The audio recording is empty.", status_code=400)
    if len(audio) > MAX_AUDIO_BYTES:
        raise DictationServiceError("Audio recording is too large.", status_code=413)

    headers = {
        "Content-Type": content_type or "application/octet-stream",
        "Content-Length": str(len(audio)),
        "X-Audio-Filename": filename or "recording",
    }
    if language:
        headers["X-Dictation-Language"] = language
    if preview:
        headers["X-Dictation-Mode"] = "preview"

    return await asyncio.to_thread(
        _json_request,
        "/transcribe",
        data=audio,
        headers=headers,
        timeout=120.0,
    )
