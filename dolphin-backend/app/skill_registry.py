from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

from .quality_schemas import SkillCapability

MAX_SKILL_FILES = 512
MAX_METADATA_BYTES = 16_384
_FIELD = re.compile(r"^(name|description):\s*(.+?)\s*$")


@dataclass(frozen=True)
class SkillRoot:
    source: str
    path: Path


def configured_skill_roots(project_path: str | None = None) -> list[SkillRoot]:
    home = Path.home()
    roots = [
        SkillRoot("codex-user", home / ".codex" / "skills"),
        SkillRoot("agent-user", home / ".agents" / "skills"),
        SkillRoot("openclaw-user", home / ".openclaw" / "skills"),
    ]
    if project_path:
        project = Path(project_path).expanduser()
        roots.extend(
            [
                SkillRoot("codex-project", project / ".codex" / "skills"),
                SkillRoot("agent-project", project / ".agents" / "skills"),
                SkillRoot("openclaw-project", project / ".openclaw" / "skills"),
            ]
        )
    return roots


def _metadata(path: Path) -> tuple[str, str] | None:
    try:
        if path.is_symlink() or path.stat().st_size > MAX_METADATA_BYTES:
            return None
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end < 0:
        return None
    values: dict[str, str] = {}
    for line in text[4:end].splitlines():
        match = _FIELD.match(line)
        if match:
            values[match.group(1)] = match.group(2).strip(" '\"")
    name = values.get("name", "").strip()
    description = values.get("description", "").strip()
    if not name or len(name) > 120 or len(description) > 500:
        return None
    return name, description


def inventory_skills(roots: list[SkillRoot]) -> list[SkillCapability]:
    by_name: dict[str, SkillCapability] = {}
    seen = 0
    for root in roots:
        if not root.path.is_dir() or root.path.is_symlink():
            continue
        for current, directory_names, file_names in os.walk(
            root.path,
            followlinks=False,
        ):
            current_path = Path(current)
            directory_names[:] = sorted(
                name
                for name in directory_names
                if not (current_path / name).is_symlink()
            )
            if "SKILL.md" not in file_names:
                continue
            seen += 1
            if seen > MAX_SKILL_FILES:
                break
            metadata = _metadata(current_path / "SKILL.md")
            if metadata is None:
                continue
            name, description = metadata
            by_name.setdefault(
                name.casefold(),
                SkillCapability(
                    name=name,
                    description=description,
                    source=root.source,
                ),
            )
        if seen > MAX_SKILL_FILES:
            break
    return sorted(by_name.values(), key=lambda item: item.name.casefold())


def project_capabilities(project_path: str | None) -> list[SkillCapability]:
    return inventory_skills(configured_skill_roots(project_path))
