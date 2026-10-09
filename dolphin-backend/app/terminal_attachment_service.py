"""Bounded, private storage for files and images attached to Codex terminals."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import threading
import uuid
import warnings
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import Path
from typing import AsyncIterable, BinaryIO

from PIL import Image, ImageOps, UnidentifiedImageError


DEFAULT_MAX_ATTACHMENT_BYTES = 600 * 1024 * 1024
DEFAULT_MAX_IMAGE_PIXELS = 25_000_000
DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60
DEFAULT_MAX_STORAGE_BYTES = 4 * 1024 * 1024 * 1024
DEFAULT_CLEANUP_INTERVAL_SECONDS = 60 * 60
DEFAULT_TEMP_RETENTION_SECONDS = 60 * 60
STREAM_WRITE_BATCH_BYTES = 4 * 1024 * 1024
DEFAULT_STORAGE_ROOT = "~/.local/share/dolphin-tasks/terminal-images"
ALLOWED_IMAGE_TYPES = {
    "image/png": ("PNG", ".png"),
    "image/jpeg": ("JPEG", ".jpg"),
}
SIGNATURE_CONTENT_TYPES = {
    "PNG": "image/png",
    "JPEG": "image/jpeg",
}
IMAGE_SUFFIX_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}
MANAGED_FILENAME_RE = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{1,16}$")
MANAGED_TEMP_FILENAME_RE = re.compile(
    r"^\.[0-9a-f]{32}\.[0-9a-f]{32}\.tmp$"
)
SAFE_PROJECT_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
SAFE_EXTENSION_RE = re.compile(r"^[a-z0-9]{1,16}$")
CONTENT_TYPE_RE = re.compile(
    r"^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/"
    r"[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$"
)
_STORE_LOCK = threading.Lock()
_DECODE_SEMAPHORE = threading.BoundedSemaphore(2)
_UPLOAD_SEMAPHORE = asyncio.BoundedSemaphore(1)


class TerminalAttachmentError(Exception):
    """A bounded, user-facing terminal attachment failure."""

    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(frozen=True)
class TerminalAttachmentSettings:
    root: Path
    max_attachment_bytes: int
    max_image_pixels: int
    retention_seconds: int
    max_storage_bytes: int
    cleanup_interval_seconds: int

    @property
    def max_image_bytes(self) -> int:
        """Compatibility name used by the original image-only endpoint."""
        return self.max_attachment_bytes


@dataclass(frozen=True)
class StoredTerminalAttachment:
    attachment_id: str
    path: str
    content_type: str
    width: int | None
    height: int | None
    size_bytes: int
    created_at: datetime
    expires_at: datetime
    original_name: str = ""
    kind: str = "image"


@dataclass(frozen=True)
class AttachmentCleanupResult:
    deleted_files: int
    deleted_temp_files: int
    removed_directories: int
    retained_bytes: int


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _configured_value(
    generic_name: str,
    legacy_name: str | None,
    default: str,
) -> str:
    generic_value = os.getenv(generic_name)
    if generic_value is not None:
        return generic_value
    if legacy_name is not None:
        legacy_value = os.getenv(legacy_name)
        if legacy_value is not None:
            return legacy_value
    return default


def _positive_configured_int(
    generic_name: str,
    legacy_name: str | None,
    default: int,
) -> int:
    raw = _configured_value(generic_name, legacy_name, str(default))
    try:
        parsed = int(raw)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def terminal_attachment_settings() -> TerminalAttachmentSettings:
    raw_root = _configured_value(
        "DOLPHIN_TERMINAL_ATTACHMENT_ROOT",
        "DOLPHIN_TERMINAL_IMAGE_ROOT",
        DEFAULT_STORAGE_ROOT,
    )
    root = Path(raw_root).expanduser().absolute()
    return TerminalAttachmentSettings(
        root=root,
        max_attachment_bytes=_positive_configured_int(
            "DOLPHIN_TERMINAL_ATTACHMENT_MAX_BYTES",
            "DOLPHIN_TERMINAL_IMAGE_MAX_BYTES",
            DEFAULT_MAX_ATTACHMENT_BYTES,
        ),
        max_image_pixels=_positive_configured_int(
            "DOLPHIN_TERMINAL_ATTACHMENT_MAX_IMAGE_PIXELS",
            "DOLPHIN_TERMINAL_IMAGE_MAX_PIXELS",
            DEFAULT_MAX_IMAGE_PIXELS,
        ),
        retention_seconds=_positive_configured_int(
            "DOLPHIN_TERMINAL_ATTACHMENT_RETENTION_SECONDS",
            "DOLPHIN_TERMINAL_IMAGE_RETENTION_SECONDS",
            DEFAULT_RETENTION_SECONDS,
        ),
        max_storage_bytes=_positive_configured_int(
            "DOLPHIN_TERMINAL_ATTACHMENT_MAX_STORAGE_BYTES",
            "DOLPHIN_TERMINAL_IMAGE_MAX_STORAGE_BYTES",
            DEFAULT_MAX_STORAGE_BYTES,
        ),
        cleanup_interval_seconds=_positive_configured_int(
            "DOLPHIN_TERMINAL_ATTACHMENT_CLEANUP_INTERVAL_SECONDS",
            None,
            DEFAULT_CLEANUP_INTERVAL_SECONDS,
        ),
    )


def _normalize_content_type(content_type: str) -> str:
    normalized = content_type.partition(";")[0].strip().lower()
    if CONTENT_TYPE_RE.fullmatch(normalized):
        return normalized
    return "application/octet-stream"


def _detected_signature(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "PNG"
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    return None


def _validate_original_name(original_name: str) -> str:
    if not original_name or original_name in {".", ".."}:
        raise TerminalAttachmentError("The attachment filename is missing.", 400)
    if len(original_name) > 255 or len(original_name.encode("utf-8")) > 512:
        raise TerminalAttachmentError(
            "Attachment filenames must be at most 255 characters.",
            400,
        )
    if any(
        character in {"/", "\\"}
        or ord(character) < 32
        or ord(character) == 127
        for character in original_name
    ):
        raise TerminalAttachmentError(
            "The attachment filename contains unsafe characters.",
            400,
        )
    return original_name


def _safe_project_component(project_id: str) -> str:
    if (
        project_id not in {".", ".."}
        and SAFE_PROJECT_COMPONENT_RE.fullmatch(project_id)
    ):
        return project_id
    digest = hashlib.sha256(project_id.encode("utf-8")).hexdigest()[:32]
    return f"project-{digest}"


def _safe_file_extension(original_name: str) -> str:
    suffix = Path(original_name).suffix.lower().removeprefix(".")
    if SAFE_EXTENSION_RE.fullmatch(suffix):
        return f".{suffix}"
    return ".bin"


def _clean_pixels(image: Image.Image, expected_format: str) -> Image.Image:
    oriented = ImageOps.exif_transpose(image)
    try:
        if expected_format == "JPEG":
            mode = "RGB"
        else:
            has_alpha = "A" in oriented.getbands() or "transparency" in oriented.info
            mode = "RGBA" if has_alpha else "RGB"
        converted = oriented.convert(mode)
        clean = Image.new(mode, converted.size)
        clean.paste(converted)
        converted.close()
        clean.info.clear()
        return clean
    finally:
        if oriented is not image:
            oriented.close()


def _sanitize_image(
    data: bytes,
    *,
    content_type: str,
    settings: TerminalAttachmentSettings,
) -> tuple[bytes, str, str, int, int]:
    if not data:
        raise TerminalAttachmentError("The image file is empty.", 400)
    if len(data) > settings.max_attachment_bytes:
        raise TerminalAttachmentError(
            "Image files must be "
            f"{settings.max_attachment_bytes // (1024 * 1024)} MiB or smaller.",
            413,
        )

    normalized_type = _normalize_content_type(content_type)
    allowed = ALLOWED_IMAGE_TYPES.get(normalized_type)
    if allowed is None:
        raise TerminalAttachmentError(
            "Only PNG and JPEG images can use the image attachment endpoint.",
            415,
        )
    expected_format, extension = allowed
    signature_format = _detected_signature(data)
    if signature_format is not None and signature_format != expected_format:
        raise TerminalAttachmentError(
            "The image content does not match its declared type.",
            415,
        )
    if signature_format is None:
        raise TerminalAttachmentError(
            "The file is not a valid PNG or JPEG image.",
            422,
        )

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data), formats=[expected_format]) as image:
                width, height = image.size
                if width <= 0 or height <= 0:
                    raise TerminalAttachmentError(
                        "The image has invalid dimensions.",
                        422,
                    )
                if width * height > settings.max_image_pixels:
                    raise TerminalAttachmentError(
                        "Images must contain at most "
                        f"{settings.max_image_pixels:,} pixels.",
                        413,
                    )
                image.load()
                clean = _clean_pixels(image, expected_format)
    except TerminalAttachmentError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise TerminalAttachmentError(
            "The image dimensions are too large to process safely.",
            413,
        ) from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise TerminalAttachmentError(
            "The image could not be decoded safely.",
            422,
        ) from error

    output = BytesIO()
    try:
        if expected_format == "PNG":
            clean.save(output, format="PNG", compress_level=6)
        else:
            clean.save(
                output,
                format="JPEG",
                quality=92,
                optimize=False,
                progressive=False,
            )
    except (OSError, ValueError) as error:
        raise TerminalAttachmentError(
            "The image could not be sanitized safely.",
            422,
        ) from error
    finally:
        clean.close()

    sanitized = output.getvalue()
    if len(sanitized) > settings.max_attachment_bytes:
        raise TerminalAttachmentError(
            "The sanitized image exceeds the "
            f"{settings.max_attachment_bytes // (1024 * 1024)} MiB limit.",
            413,
        )
    return sanitized, normalized_type, extension, width, height


def _image_content_type(
    *,
    original_name: str,
    content_type: str,
    data: bytes,
) -> str | None:
    if content_type in ALLOWED_IMAGE_TYPES:
        return content_type
    signature = _detected_signature(data)
    if signature is not None:
        return SIGNATURE_CONTENT_TYPES[signature]
    return IMAGE_SUFFIX_CONTENT_TYPES.get(Path(original_name).suffix.lower())


def _iter_project_directories(root: Path):
    if root.is_symlink() or not root.is_dir():
        return
    try:
        entries = list(os.scandir(root))
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            yield Path(entry.path)
        except OSError:
            continue


def _prune_expired_and_measure_locked(
    settings: TerminalAttachmentSettings,
    *,
    now_timestamp: float,
) -> AttachmentCleanupResult:
    root = settings.root
    deleted_files = 0
    deleted_temp_files = 0
    removed_directories = 0
    retained_bytes = 0
    project_directories = list(_iter_project_directories(root) or [])

    for project_root in project_directories:
        try:
            entries = list(os.scandir(project_root))
        except OSError:
            continue
        for entry in entries:
            is_final = MANAGED_FILENAME_RE.fullmatch(entry.name) is not None
            is_temp = MANAGED_TEMP_FILENAME_RE.fullmatch(entry.name) is not None
            if not is_final and not is_temp:
                continue
            try:
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    continue
                stat = entry.stat(follow_symlinks=False)
            except OSError:
                continue

            retention_seconds = (
                min(settings.retention_seconds, DEFAULT_TEMP_RETENTION_SECONDS)
                if is_temp
                else settings.retention_seconds
            )
            if stat.st_mtime + retention_seconds > now_timestamp:
                retained_bytes += stat.st_size
                continue
            try:
                Path(entry.path).unlink()
            except OSError:
                retained_bytes += stat.st_size
            else:
                if is_temp:
                    deleted_temp_files += 1
                else:
                    deleted_files += 1

        try:
            project_root.rmdir()
        except OSError:
            pass
        else:
            removed_directories += 1

    try:
        root.rmdir()
    except OSError:
        pass
    else:
        removed_directories += 1

    return AttachmentCleanupResult(
        deleted_files=deleted_files,
        deleted_temp_files=deleted_temp_files,
        removed_directories=removed_directories,
        retained_bytes=retained_bytes,
    )


def _write_private_atomic(path: Path, data: bytes) -> None:
    temp_path = path.with_name(f".{path.stem}.{uuid.uuid4().hex}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(temp_path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp_path, path)
        path.chmod(0o600)
        directory_descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise


def _ensure_private_project_root_locked(
    settings: TerminalAttachmentSettings,
    project_id: str,
) -> Path:
    root = settings.root
    project_root = root / _safe_project_component(project_id)
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise TerminalAttachmentError(
            "Dolphin's terminal attachment storage directory is unsafe.",
            507,
        )
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root.chmod(0o700)
    except OSError as error:
        raise TerminalAttachmentError(
            "Dolphin could not create its terminal attachment storage directory.",
            507,
        ) from error
    if project_root.is_symlink():
        raise TerminalAttachmentError(
            "Dolphin's terminal attachment storage directory is unsafe.",
            507,
        )
    try:
        project_root.mkdir(exist_ok=True, mode=0o700)
        project_root.chmod(0o700)
    except OSError as error:
        raise TerminalAttachmentError(
            "Dolphin could not create its terminal attachment storage directory.",
            507,
        ) from error
    if project_root.is_symlink() or not project_root.is_dir():
        raise TerminalAttachmentError(
            "Dolphin's terminal attachment storage directory is unsafe.",
            507,
        )
    return project_root


def _open_private_stage(
    settings: TerminalAttachmentSettings,
    *,
    project_id: str,
    attachment_id: str,
    reserved_bytes: int,
) -> tuple[Path, BinaryIO]:
    with _STORE_LOCK:
        cleanup = _prune_expired_and_measure_locked(
            settings,
            now_timestamp=utc_now().timestamp(),
        )
        if cleanup.retained_bytes + reserved_bytes > settings.max_storage_bytes:
            raise TerminalAttachmentError(
                "Dolphin's terminal attachment storage quota is full. "
                "Wait for expired attachments to be pruned.",
                507,
            )
        project_root = _ensure_private_project_root_locked(settings, project_id)
        temp_path = project_root / f".{attachment_id}.{uuid.uuid4().hex}.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(temp_path, flags, 0o600)
        except OSError as error:
            raise TerminalAttachmentError(
                "Dolphin could not stage the terminal attachment.",
                507,
            ) from error
    return temp_path, os.fdopen(descriptor, "wb")


def _close_private_stage(output: BinaryIO) -> None:
    output.flush()
    os.fsync(output.fileno())
    output.close()


def _discard_private_stage(
    output: BinaryIO | None,
    temp_path: Path | None,
    root: Path,
) -> None:
    if output is not None:
        try:
            output.close()
        except OSError:
            pass
    if temp_path is not None:
        try:
            temp_path.unlink()
        except OSError:
            pass
        try:
            temp_path.parent.rmdir()
        except OSError:
            pass
    try:
        root.rmdir()
    except OSError:
        pass


def _sanitize_image_file(
    source_path: Path,
    *,
    content_type: str,
    attachment_id: str,
    settings: TerminalAttachmentSettings,
) -> tuple[Path, str, str, int, int, int]:
    normalized_type = _normalize_content_type(content_type)
    allowed = ALLOWED_IMAGE_TYPES.get(normalized_type)
    if allowed is None:
        raise TerminalAttachmentError(
            "Only PNG and JPEG images can use the image attachment endpoint.",
            415,
        )
    expected_format, extension = allowed
    with source_path.open("rb") as source:
        signature_format = _detected_signature(source.read(16))
    if signature_format is not None and signature_format != expected_format:
        raise TerminalAttachmentError(
            "The image content does not match its declared type.",
            415,
        )
    if signature_format is None:
        raise TerminalAttachmentError(
            "The file is not a valid PNG or JPEG image.",
            422,
        )

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source_path, formats=[expected_format]) as image:
                width, height = image.size
                if width <= 0 or height <= 0:
                    raise TerminalAttachmentError(
                        "The image has invalid dimensions.",
                        422,
                    )
                if width * height > settings.max_image_pixels:
                    raise TerminalAttachmentError(
                        "Images must contain at most "
                        f"{settings.max_image_pixels:,} pixels.",
                        413,
                    )
                image.load()
                clean = _clean_pixels(image, expected_format)
    except TerminalAttachmentError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise TerminalAttachmentError(
            "The image dimensions are too large to process safely.",
            413,
        ) from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise TerminalAttachmentError(
            "The image could not be decoded safely.",
            422,
        ) from error

    output_path = source_path.with_name(
        f".{attachment_id}.{uuid.uuid4().hex}.tmp"
    )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(output_path, flags, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            if expected_format == "PNG":
                clean.save(output, format="PNG", compress_level=6)
            else:
                clean.save(
                    output,
                    format="JPEG",
                    quality=92,
                    optimize=False,
                    progressive=False,
                )
            output.flush()
            os.fsync(output.fileno())
        output_path.chmod(0o600)
    except (OSError, ValueError) as error:
        try:
            output_path.unlink()
        except OSError:
            pass
        raise TerminalAttachmentError(
            "The image could not be sanitized safely.",
            422,
        ) from error
    finally:
        clean.close()

    size_bytes = output_path.stat().st_size
    if size_bytes > settings.max_attachment_bytes:
        try:
            output_path.unlink()
        except OSError:
            pass
        raise TerminalAttachmentError(
            "The sanitized image exceeds the "
            f"{settings.max_attachment_bytes // (1024 * 1024)} MiB limit.",
            413,
        )
    return (
        output_path,
        normalized_type,
        extension,
        width,
        height,
        size_bytes,
    )


def _publish_staged_attachment(
    source_path: Path,
    *,
    attachment_id: str,
    project_id: str,
    original_name: str,
    content_type: str,
    prefix: bytes,
    created_at: datetime,
    settings: TerminalAttachmentSettings,
) -> StoredTerminalAttachment:
    normalized_type = _normalize_content_type(content_type)
    image_type = _image_content_type(
        original_name=original_name,
        content_type=normalized_type,
        data=prefix,
    )
    publish_path = source_path

    try:
        if image_type is None:
            kind = "file"
            stored_type = normalized_type
            extension = _safe_file_extension(original_name)
            width = None
            height = None
            size_bytes = source_path.stat().st_size
        else:
            with _DECODE_SEMAPHORE:
                (
                    publish_path,
                    stored_type,
                    extension,
                    width,
                    height,
                    size_bytes,
                ) = _sanitize_image_file(
                    source_path,
                    content_type=image_type,
                    attachment_id=attachment_id,
                    settings=settings,
                )
            source_path.unlink()
            kind = "image"

        destination = publish_path.parent / f"{attachment_id}{extension}"
        with _STORE_LOCK:
            cleanup = _prune_expired_and_measure_locked(
                settings,
                now_timestamp=created_at.timestamp(),
            )
            if cleanup.retained_bytes > settings.max_storage_bytes:
                raise TerminalAttachmentError(
                    "Dolphin's terminal attachment storage quota is full. "
                    "Wait for expired attachments to be pruned.",
                    507,
                )
            os.replace(publish_path, destination)
            destination.chmod(0o600)
            directory_descriptor = os.open(destination.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    except TerminalAttachmentError:
        raise
    except OSError as error:
        raise TerminalAttachmentError(
            "Dolphin could not store the attachment.",
            507,
        ) from error
    finally:
        for path in {source_path, publish_path}:
            try:
                path.unlink()
            except OSError:
                pass

    return StoredTerminalAttachment(
        attachment_id=attachment_id,
        path=str(destination),
        original_name=original_name,
        kind=kind,
        content_type=stored_type,
        width=width,
        height=height,
        size_bytes=size_bytes,
        created_at=created_at,
        expires_at=created_at + timedelta(seconds=settings.retention_seconds),
    )


async def store_terminal_attachment_stream(
    *,
    project_id: str,
    original_name: str,
    content_type: str,
    chunks: AsyncIterable[bytes],
    content_length: int | None,
) -> StoredTerminalAttachment:
    """Stream one bounded upload to private storage and publish it atomically."""
    settings = terminal_attachment_settings()
    validated_name = _validate_original_name(original_name)
    normalized_type = _normalize_content_type(content_type)
    if content_length is not None:
        if content_length < 0:
            raise TerminalAttachmentError("Invalid attachment Content-Length header.", 400)
        if content_length > settings.max_attachment_bytes:
            raise TerminalAttachmentError(
                "Attachment files must be "
                f"{settings.max_attachment_bytes // (1024 * 1024)} MiB or smaller.",
                413,
            )

    attachment_id = uuid.uuid4().hex
    created_at = utc_now()
    output: BinaryIO | None = None
    temp_path: Path | None = None
    published = False
    reservation = content_length or settings.max_attachment_bytes

    async with _UPLOAD_SEMAPHORE:
        try:
            temp_path, output = await asyncio.to_thread(
                _open_private_stage,
                settings,
                project_id=project_id,
                attachment_id=attachment_id,
                reserved_bytes=reservation,
            )
            total_bytes = 0
            prefix = bytearray()
            write_batch = bytearray()
            async for chunk in chunks:
                if not isinstance(chunk, bytes):
                    raise TerminalAttachmentError(
                        "The attachment stream contained invalid data.",
                        400,
                    )
                if not chunk:
                    continue
                total_bytes += len(chunk)
                if total_bytes > settings.max_attachment_bytes:
                    raise TerminalAttachmentError(
                        "Attachment files must be "
                        f"{settings.max_attachment_bytes // (1024 * 1024)} MiB or smaller.",
                        413,
                    )
                if len(prefix) < 16:
                    prefix.extend(chunk[: 16 - len(prefix)])
                if (
                    write_batch
                    and len(write_batch) + len(chunk) >= STREAM_WRITE_BATCH_BYTES
                ):
                    payload = bytes(write_batch)
                    write_batch.clear()
                    await asyncio.to_thread(output.write, payload)
                if len(chunk) >= STREAM_WRITE_BATCH_BYTES:
                    await asyncio.to_thread(output.write, chunk)
                else:
                    write_batch.extend(chunk)

            if total_bytes == 0:
                raise TerminalAttachmentError("The attachment file is empty.", 400)
            if write_batch:
                await asyncio.to_thread(output.write, bytes(write_batch))
            await asyncio.to_thread(_close_private_stage, output)
            output = None
            stored = await asyncio.to_thread(
                _publish_staged_attachment,
                temp_path,
                attachment_id=attachment_id,
                project_id=project_id,
                original_name=validated_name,
                content_type=normalized_type,
                prefix=bytes(prefix),
                created_at=created_at,
                settings=settings,
            )
            published = True
            temp_path = None
            return stored
        finally:
            if not published:
                await asyncio.to_thread(
                    _discard_private_stage,
                    output,
                    temp_path,
                    settings.root,
                )


def _store_private_attachment(
    data: bytes,
    *,
    project_id: str,
    original_name: str,
    kind: str,
    content_type: str,
    extension: str,
    width: int | None,
    height: int | None,
    settings: TerminalAttachmentSettings,
) -> StoredTerminalAttachment:
    created_at = utc_now()
    attachment_id = uuid.uuid4().hex
    project_component = _safe_project_component(project_id)
    root = settings.root
    project_root = root / project_component
    destination = project_root / f"{attachment_id}{extension}"

    with _STORE_LOCK:
        cleanup = _prune_expired_and_measure_locked(
            settings,
            now_timestamp=created_at.timestamp(),
        )
        if cleanup.retained_bytes + len(data) > settings.max_storage_bytes:
            raise TerminalAttachmentError(
                "Dolphin's terminal attachment storage quota is full. "
                "Wait for expired attachments to be pruned.",
                507,
            )

        if root.is_symlink() or (root.exists() and not root.is_dir()):
            raise TerminalAttachmentError(
                "Dolphin's terminal attachment storage directory is unsafe.",
                507,
            )
        try:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            root.chmod(0o700)
        except OSError as error:
            raise TerminalAttachmentError(
                "Dolphin could not create its terminal attachment storage directory.",
                507,
            ) from error
        if project_root.is_symlink():
            raise TerminalAttachmentError(
                "Dolphin's terminal attachment storage directory is unsafe.",
                507,
            )
        try:
            project_root.mkdir(exist_ok=True, mode=0o700)
        except OSError as error:
            raise TerminalAttachmentError(
                "Dolphin could not create its terminal attachment storage directory.",
                507,
            ) from error
        if project_root.is_symlink() or not project_root.is_dir():
            raise TerminalAttachmentError(
                "Dolphin's terminal attachment storage directory is unsafe.",
                507,
            )
        project_root.chmod(0o700)
        try:
            _write_private_atomic(destination, data)
        except OSError as error:
            raise TerminalAttachmentError(
                "Dolphin could not store the attachment.",
                507,
            ) from error

    return StoredTerminalAttachment(
        attachment_id=attachment_id,
        path=str(destination),
        original_name=original_name,
        kind=kind,
        content_type=content_type,
        width=width,
        height=height,
        size_bytes=len(data),
        created_at=created_at,
        expires_at=created_at + timedelta(seconds=settings.retention_seconds),
    )


async def store_terminal_attachment(
    *,
    project_id: str,
    original_name: str,
    content_type: str,
    data: bytes,
) -> StoredTerminalAttachment:
    """Validate and privately store one opaque file or sanitized image."""
    settings = terminal_attachment_settings()
    validated_name = _validate_original_name(original_name)
    if not data:
        raise TerminalAttachmentError("The attachment file is empty.", 400)
    if len(data) > settings.max_attachment_bytes:
        raise TerminalAttachmentError(
            "Attachment files must be "
            f"{settings.max_attachment_bytes // (1024 * 1024)} MiB or smaller.",
            413,
        )

    normalized_type = _normalize_content_type(content_type)
    image_type = _image_content_type(
        original_name=validated_name,
        content_type=normalized_type,
        data=data,
    )
    if image_type is None:
        stored_data = data
        stored_type = normalized_type
        extension = _safe_file_extension(validated_name)
        width = None
        height = None
        kind = "file"
    else:
        def sanitize_with_bound():
            with _DECODE_SEMAPHORE:
                return _sanitize_image(
                    data,
                    content_type=image_type,
                    settings=settings,
                )

        (
            stored_data,
            stored_type,
            extension,
            width,
            height,
        ) = await asyncio.to_thread(sanitize_with_bound)
        kind = "image"

    return await asyncio.to_thread(
        _store_private_attachment,
        stored_data,
        project_id=project_id,
        original_name=validated_name,
        kind=kind,
        content_type=stored_type,
        extension=extension,
        width=width,
        height=height,
        settings=settings,
    )


async def store_image_attachment(
    *,
    project_id: str,
    content_type: str,
    data: bytes,
) -> StoredTerminalAttachment:
    """Compatibility path for callers that require a PNG or JPEG."""
    normalized_type = _normalize_content_type(content_type)
    if normalized_type not in ALLOWED_IMAGE_TYPES:
        raise TerminalAttachmentError(
            "Only PNG and JPEG images can be attached.",
            415,
        )
    extension = ALLOWED_IMAGE_TYPES[normalized_type][1]
    return await store_terminal_attachment(
        project_id=project_id,
        original_name=f"image{extension}",
        content_type=normalized_type,
        data=data,
    )


async def prune_terminal_attachments() -> AttachmentCleanupResult:
    """Remove expired managed attachments and stale temp files."""
    settings = terminal_attachment_settings()

    def prune_with_lock() -> AttachmentCleanupResult:
        with _STORE_LOCK:
            return _prune_expired_and_measure_locked(
                settings,
                now_timestamp=utc_now().timestamp(),
            )

    return await asyncio.to_thread(prune_with_lock)
