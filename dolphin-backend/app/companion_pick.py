"""Which character a project's companion is, when the user has not chosen one.

The pick reads what is in the project folder: its manifests, its dependencies,
the kinds of files it holds and, last, its name. It is stable: the same folder
gives the same character, so a project keeps its face. A user's choice
(``Project.companion``) always wins over this.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

CAST = ("pip", "mochi", "bolt", "ember", "luna", "pebble", "fizz", "nori")
DEFAULT = "pip"

_SKIP = {".git", "node_modules", "venv", ".venv", "__pycache__", "dist", "build", ".next", "target", ".cache", "site-packages"}
_CACHE: dict[tuple[str, str], tuple[float, str]] = {}
_TTL = 6 * 3600

_NAME_HINTS = (
    ("fizz", r"(^|[-_ ])(test|tests|play|playground|sandbox|demo|experiment|experiments|scratch|poc|proto|prototype|tmp|try)([-_ ]|$)"),
    ("nori", r"(^|[-_ ])(ml|model|models|data|dataset|train|training|llm|vision|nlp|robot|robotics|ai)([-_ ]|$)"),
    ("mochi", r"(^|[-_ ])(paper|papers|thesis|notes|writing|research|book|docs|blog|course|slides|lecture|lectures)([-_ ]|$)"),
    ("luna", r"(^|[-_ ])(web|ui|design|site|website|landing|frontend|portfolio)([-_ ]|$)"),
    ("bolt", r"(^|[-_ ])(infra|ops|cli|tool|tools|scripts|deploy|dotfiles|config|setup|server)([-_ ]|$)"),
)
_ML = re.compile(r"\b(torch|tensorflow|jax|scikit-learn|sklearn|transformers|keras|lightning|xgboost)\b", re.I)
_BACKEND = re.compile(r"\b(fastapi|django|flask|starlette|sqlalchemy|celery|aiohttp)\b", re.I)
_FRONTEND = ("react", "vue", "svelte", "next", "vite", "@angular/core", "solid-js", "tailwindcss", "astro")


def _read(path: Path, limit: int = 200_000) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            return handle.read(limit)
    except OSError:
        return ""


def _scan(root: Path, depth: int = 2, budget: int = 3000) -> tuple[set[str], dict[str, int]]:
    """Top-level names, and file counts by extension a couple of levels down."""
    names: set[str] = set()
    counts: dict[str, int] = {}
    stack = [(root, 0)]
    seen = 0
    while stack and seen < budget:
        folder, level = stack.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            seen += 1
            if level == 0:
                names.add(entry.name.lower())
            try:
                if entry.is_dir(follow_symlinks=False):
                    if level < depth and entry.name not in _SKIP and not entry.name.startswith("."):
                        stack.append((Path(entry.path), level + 1))
                elif entry.is_file(follow_symlinks=False):
                    ext = os.path.splitext(entry.name)[1].lower()
                    counts[ext] = counts.get(ext, 0) + 1
            except OSError:
                continue
    return names, counts


def classify(path: str | None, name: str = "") -> str:
    """The character for a project folder, from what it holds."""
    root = Path(path) if path else None
    if root is None or not root.is_dir():
        return _by_name(name) or DEFAULT
    names, counts = _scan(root)
    hinted = _by_name(name) or _by_name(root.name)
    if hinted == "fizz":
        return "fizz"
    code = sum(counts.get(e, 0) for e in (".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".kt", ".swift", ".dart", ".c", ".cpp", ".rb"))
    prose = sum(counts.get(e, 0) for e in (".md", ".tex", ".docx", ".bib", ".rst", ".txt"))
    python_deps = " ".join(_read(root / f) for f in ("requirements.txt", "pyproject.toml", "environment.yml", "setup.py") if (root / f).is_file())
    package = {}
    if "package.json" in names:
        try:
            package = json.loads(_read(root / "package.json"))
        except ValueError:
            package = {}
    deps = {**(package.get("dependencies") or {}), **(package.get("devDependencies") or {})} if isinstance(package, dict) else {}

    # Data and models: notebooks, or a machine-learning stack.
    if counts.get(".ipynb", 0) >= 2 or _ML.search(python_deps) or counts.get(".pt", 0) or counts.get(".safetensors", 0):
        return "nori"
    # Writing and research: mostly prose, little code.
    if prose >= 5 and code <= max(3, prose // 4) or counts.get(".tex", 0) >= 2:
        return "mochi"
    # Apps and products: mobile, desktop and store builds.
    if {"pubspec.yaml", "ios", "android", "app.json"} & names or any(n.endswith(".xcodeproj") for n in names) \
            or "electron" in deps or "electron-builder" in deps or "react-native" in deps or "expo" in deps:
        return "ember"
    # Interfaces: a front-end framework and no server of its own.
    if any(d in deps for d in _FRONTEND) and not _BACKEND.search(python_deps):
        return "luna"
    # Tools and infrastructure: containers, provisioning, scripts.
    infra = {"dockerfile", "docker-compose.yml", "compose.yaml", "terraform", "ansible", "helm", "k8s", "kubernetes"} & names
    scripts = counts.get(".sh", 0) + counts.get(".tf", 0) + counts.get(".yml", 0) + counts.get(".yaml", 0)
    if infra and code < 40 or scripts > max(6, code):
        return "bolt"
    # Backends and services.
    if {"go.mod", "cargo.toml", "pom.xml", "build.gradle"} & names or _BACKEND.search(python_deps):
        return "pebble"
    return hinted or ("pip" if code + prose < 15 else "pebble" if counts.get(".py", 0) or counts.get(".go", 0) else "luna" if counts.get(".tsx", 0) or counts.get(".css", 0) else DEFAULT)


def _by_name(name: str) -> str | None:
    lowered = (name or "").lower()
    for key, pattern in _NAME_HINTS:
        if re.search(pattern, lowered):
            return key
    return None


def companion_for(project_id: str, path: str | None, name: str, chosen: str | None) -> tuple[str, bool]:
    """The project's character and whether the user chose it. Picks are cached."""
    if chosen in CAST:
        return chosen, True
    key = (project_id, path or "")
    hit = _CACHE.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _TTL:
        return hit[1], False
    picked = classify(path, name)
    _CACHE[key] = (now, picked)
    return picked, False
