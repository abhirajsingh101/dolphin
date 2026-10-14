"""The helper offers the folders a user owns outside their home, like
/work/<user>, without any setting: discover_workspace_roots."""

from __future__ import annotations

import os
import time
from pathlib import Path

from app.helper import configure_environment, discover_workspace_roots


def _tree(top: Path, *dirs: str) -> None:
    for name in dirs:
        (top / name).mkdir(parents=True)


def _owned_except(*others: str):
    """Pretend every path is ours except the named ones (tests cannot chown)."""
    def owns(path: Path) -> bool:
        return path.name not in others
    return owns


def test_home_comes_first_then_the_owned_folders_beside_it(tmp_path):
    top = tmp_path / "root"
    _tree(top, "home/me", "data/me", "data/me-old", "data/shared", "scratch", "usr/local", "proc/1", "tmp/x")

    roots = discover_workspace_roots(top / "home/me", user="me", top=top, owns=_owned_except("data", "home"))

    # Below the top, only the folder named after the user: data/shared is
    # ours too, but it is a dataset, not where projects live.
    assert roots == [top / "home/me", top / "data/me", top / "scratch"]


def test_an_owned_top_folder_is_offered_whole_rather_than_its_children(tmp_path):
    top = tmp_path / "root"
    _tree(top, "home/me", "work/a", "work/b")

    roots = discover_workspace_roots(top / "home/me", user="me", top=top, owns=_owned_except("home"))

    assert roots == [top / "home/me", top / "work"]


def test_hidden_and_system_folders_and_other_users_homes_are_never_offered(tmp_path):
    top = tmp_path / "root"
    _tree(top, "home/me", "home/you", ".snapshots/x", "opt/conda", "var/lib", "Volumes/Disk", "Library/x")

    roots = discover_workspace_roots(top / "home/me", user="me", top=top, owns=_owned_except("home", "you"))

    assert roots == [top / "home/me"]


def test_symlinks_are_never_followed(tmp_path):
    top = tmp_path / "root"
    _tree(top, "home/me", "data/me/deep/assets", "data/elsewhere")
    (top / "work").symlink_to(top / "data/me/deep")
    (top / "data/elsewhere/me").symlink_to(top / "data/me/deep/assets")

    roots = discover_workspace_roots(top / "home/me", user="me", top=top, owns=_owned_except("home", "data", "elsewhere"))

    assert roots == [top / "home/me", top / "data/me"]


def test_a_slow_disk_never_holds_up_startup(tmp_path):
    top = tmp_path / "root"
    _tree(top, "home/me", "nfs/me")

    def hangs(path: Path) -> bool:
        time.sleep(5)
        return True

    started = time.monotonic()
    roots = discover_workspace_roots(top / "home/me", user="me", top=top, owns=hangs, budget=0.2)

    assert roots == [top / "home/me"]
    assert time.monotonic() - started < 2


def test_the_helper_offers_the_discovered_folders_unless_roots_are_set(monkeypatch, tmp_path):
    environ = {key: value for key, value in os.environ.items() if key != "DOLPHIN_WORKSPACE_ROOTS"}
    monkeypatch.setattr(os, "environ", environ)
    monkeypatch.setattr("app.helper.discover_workspace_roots", lambda home: [home, Path("/work/me")])

    configure_environment(tmp_path, "t" * 40)
    assert environ["DOLPHIN_WORKSPACE_ROOTS"] == os.pathsep.join([str(Path.home()), "/work/me"])

    environ["DOLPHIN_WORKSPACE_ROOTS"] = "/only/this"
    configure_environment(tmp_path, "t" * 40)
    assert environ["DOLPHIN_WORKSPACE_ROOTS"] == "/only/this"
