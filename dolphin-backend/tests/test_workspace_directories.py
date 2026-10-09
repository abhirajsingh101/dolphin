import asyncio

import pytest
from fastapi import HTTPException

from app.main import list_workspace_directories


def test_workspace_directories_list_expandable_children(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    (tmp_path / "alpha" / ".git").mkdir(parents=True)
    (tmp_path / "beta" / "child").mkdir(parents=True)
    (tmp_path / "beta" / "node_modules" / "ignored").mkdir(parents=True)
    (tmp_path / ".hidden").mkdir()

    response = asyncio.run(list_workspace_directories())

    assert response.root == str(tmp_path.resolve())
    assert [directory.name for directory in response.directories] == ["alpha", "beta"]
    alpha = response.directories[0]
    beta = response.directories[1]
    assert alpha.is_project is True
    assert alpha.has_children is False
    assert beta.has_children is True


def test_workspace_directories_can_browse_nested_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    nested = tmp_path / "project" / "src"
    nested.mkdir(parents=True)

    response = asyncio.run(list_workspace_directories(root=str(tmp_path / "project")))

    assert response.root == str((tmp_path / "project").resolve())
    assert [directory.name for directory in response.directories] == ["src"]


def test_workspace_directories_searches_descendants(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    (tmp_path / "project" / "frontend" / "components").mkdir(parents=True)
    (tmp_path / "project" / "node_modules" / "frontend-ignore").mkdir(parents=True)

    response = asyncio.run(list_workspace_directories(q="components"))

    assert [directory.name for directory in response.directories] == ["components"]
    assert response.directories[0].path.endswith("/project/frontend/components")


def test_workspace_directory_search_does_not_match_every_descendant_by_parent(
    tmp_path,
    monkeypatch,
):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    (tmp_path / "studio-app" / "frontend").mkdir(parents=True)
    (tmp_path / "studio-app" / "backend").mkdir(parents=True)

    response = asyncio.run(list_workspace_directories(q="studio-app"))

    assert [directory.name for directory in response.directories] == ["studio-app"]


def test_workspace_directories_rejects_outside_roots(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "allowed"))
    outside = tmp_path / "outside"
    outside.mkdir()

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(list_workspace_directories(root=str(outside)))

    assert exc_info.value.status_code == 403


import os

from app.main import list_workspace_roots


def test_workspace_roots_are_listed_in_configured_order(tmp_path, monkeypatch):
    first = tmp_path / "home"
    second = tmp_path / "data"
    first.mkdir()
    second.mkdir()
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS", os.pathsep.join([str(first), str(second)])
    )

    roots = asyncio.run(list_workspace_roots())

    assert [root.path for root in roots] == [str(first.resolve()), str(second.resolve())]
    assert [root.name for root in roots] == ["home", "data"]
    assert all(root.exists for root in roots)


def test_a_missing_root_is_reported_not_hidden(tmp_path, monkeypatch):
    """A mistyped or unmounted root must show as broken rather than vanish --
    a picker that silently drops a root sends the operator hunting for a
    folder the UI has decided not to mention."""
    present = tmp_path / "home"
    present.mkdir()
    absent = tmp_path / "not-mounted"
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS", os.pathsep.join([str(present), str(absent)])
    )

    roots = asyncio.run(list_workspace_roots())

    assert [root.exists for root in roots] == [True, False]
    assert roots[1].path == str(absent.resolve())


def test_search_spans_every_configured_root(tmp_path, monkeypatch):
    first = tmp_path / "home"
    second = tmp_path / "data"
    (first / "alpha-service").mkdir(parents=True)
    (second / "alpha-runner").mkdir(parents=True)
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS", os.pathsep.join([str(first), str(second)])
    )

    response = asyncio.run(list_workspace_directories(q="alpha"))

    found = {directory.path for directory in response.directories}
    assert str((first / "alpha-service").resolve()) in found
    assert str((second / "alpha-runner").resolve()) in found
    # No single root owns this result set.
    assert response.root is None


def test_search_within_one_root_still_names_that_root(tmp_path, monkeypatch):
    first = tmp_path / "home"
    second = tmp_path / "data"
    (first / "alpha-service").mkdir(parents=True)
    second.mkdir()
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS", os.pathsep.join([str(first), str(second)])
    )

    response = asyncio.run(list_workspace_directories(root=str(first), q="alpha"))

    assert response.root == str(first.resolve())
    assert [directory.name for directory in response.directories] == ["alpha-service"]


def test_hidden_directories_are_excluded_by_default(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    (tmp_path / "visible").mkdir()
    (tmp_path / ".ssh").mkdir()

    response = asyncio.run(list_workspace_directories())

    assert [directory.name for directory in response.directories] == ["visible"]


def test_hidden_directories_appear_only_when_asked_for(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    (tmp_path / "visible").mkdir()
    (tmp_path / ".ssh").mkdir()

    response = asyncio.run(list_workspace_directories(show_hidden=True))

    assert [directory.name for directory in response.directories] == [".ssh", "visible"]


def test_a_root_outside_the_configured_roots_is_refused(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    (tmp_path / "elsewhere").mkdir()

    with pytest.raises(HTTPException) as error:
        asyncio.run(list_workspace_directories(root=str(tmp_path / "elsewhere")))

    assert error.value.status_code == 403


def test_a_symlink_escaping_the_root_is_refused_as_a_browse_target(tmp_path, monkeypatch):
    """resolve() runs before the allowed-root check, so the link's target is
    what gets judged -- not the path the caller typed."""
    root = tmp_path / "home"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (root / "escape").symlink_to(outside, target_is_directory=True)
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))

    with pytest.raises(HTTPException) as error:
        asyncio.run(list_workspace_directories(root=str(root / "escape")))

    assert error.value.status_code == 403


def test_a_full_first_root_does_not_starve_matches_from_the_rest(tmp_path, monkeypatch):
    """Concatenating each root's results before truncating to max_results
    lets a broad query that already fills the budget from the first root
    silently drop every match the second root has -- defeating the point of
    a multi-root search. Round-robin across roots must survive this."""
    first = tmp_path / "home"
    second = tmp_path / "data"
    for index in range(6):
        (first / f"alpha-{index}").mkdir(parents=True)
    (second / "alpha-runner").mkdir(parents=True)
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS", os.pathsep.join([str(first), str(second)])
    )

    response = asyncio.run(list_workspace_directories(q="alpha", max_results=4))

    names = [directory.name for directory in response.directories]
    assert len(names) == 4
    assert "alpha-runner" in names


def test_search_survives_an_unmounted_first_root(tmp_path, monkeypatch):
    """Liveness used to be judged on roots[0] before the per-root loop ran, so
    an unmounted first root failed a cross-root search outright -- latent only
    because the first configured root on this machine always exists."""
    absent = tmp_path / "not-mounted"
    present = tmp_path / "data"
    (present / "alpha-runner").mkdir(parents=True)
    monkeypatch.setenv(
        "DOLPHIN_WORKSPACE_ROOTS", os.pathsep.join([str(absent), str(present)])
    )

    response = asyncio.run(list_workspace_directories(q="alpha"))

    assert [directory.name for directory in response.directories] == ["alpha-runner"]
    # The surviving root is the one named, not the dead one that sorts first.
    assert response.root == str(present.resolve())


def test_no_configured_root_is_a_refusal_not_a_crash(tmp_path, monkeypatch):
    """An empty DOLPHIN_WORKSPACE_ROOTS used to raise IndexError -> 500, which
    made the "no workspace root configured" 400 below it unreachable."""
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", "")

    with pytest.raises(HTTPException) as error:
        asyncio.run(list_workspace_directories())

    assert error.value.status_code == 400
    assert "DOLPHIN_WORKSPACE_ROOTS" in error.value.detail


def test_no_configured_root_is_a_refusal_on_the_search_path_too(monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", "")

    with pytest.raises(HTTPException) as error:
        asyncio.run(list_workspace_directories(q="alpha"))

    assert error.value.status_code == 400


from app.main import create_workspace_directory
from app.schemas import WorkspaceDirectoryCreateRequest


def test_creates_a_directory_inside_an_allowed_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))

    created = asyncio.run(
        create_workspace_directory(
            WorkspaceDirectoryCreateRequest(parent=str(tmp_path), name="new-project")
        )
    )

    assert created.name == "new-project"
    assert (tmp_path / "new-project").is_dir()


@pytest.mark.parametrize("name", ["..", ".", "a/b", "a\\b", "", "   ", "bad\x00name"])
def test_rejects_a_name_that_is_not_a_single_directory(tmp_path, monkeypatch, name):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            create_workspace_directory(
                WorkspaceDirectoryCreateRequest(parent=str(tmp_path), name=name)
            )
        )

    assert error.value.status_code == 400
    assert list(tmp_path.iterdir()) == []


def test_rejects_a_parent_outside_the_configured_roots(tmp_path, monkeypatch):
    root = tmp_path / "home"
    root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(root))

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            create_workspace_directory(
                WorkspaceDirectoryCreateRequest(parent=str(outside), name="sneaky")
            )
        )

    assert error.value.status_code == 403
    assert not (outside / "sneaky").exists()


def test_creating_an_existing_directory_is_a_conflict(tmp_path, monkeypatch):
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    existing = tmp_path / "already-here"
    existing.mkdir()
    (existing / "keep-me").mkdir()

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            create_workspace_directory(
                WorkspaceDirectoryCreateRequest(parent=str(tmp_path), name="already-here")
            )
        )

    assert error.value.status_code == 409
    # The existing directory and its contents are untouched.
    assert (existing / "keep-me").is_dir()


def test_rejects_a_nested_name_even_when_the_intermediate_exists(tmp_path, monkeypatch):
    """The parametrized "a/b" case above cannot tell guard 1 from the catch-all.

    With an empty parent, deleting the name guard makes `mkdir` raise
    FileNotFoundError, which the generic OSError branch also maps to 400, and
    the shared `iterdir() == []` assertion still holds -- so the case passes
    either way. Pre-creating the intermediate here removes that alibi: without
    the name guard, `Path(parent) / "a/b"` is a real path under an existing
    directory and `mkdir` succeeds, creating exactly the nested tree the guard
    exists to refuse.
    """
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))
    (tmp_path / "a").mkdir()

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            create_workspace_directory(
                WorkspaceDirectoryCreateRequest(parent=str(tmp_path), name="a/b")
            )
        )

    assert error.value.status_code == 400
    assert not (tmp_path / "a" / "b").exists()
    assert list((tmp_path / "a").iterdir()) == []


def test_does_not_create_intermediate_directories(tmp_path, monkeypatch):
    """mkdir is non-recursive on purpose: a typo'd parent must fail loudly
    rather than quietly materialise a tree the operator never asked for."""
    monkeypatch.setenv("DOLPHIN_WORKSPACE_ROOTS", str(tmp_path))

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            create_workspace_directory(
                WorkspaceDirectoryCreateRequest(
                    parent=str(tmp_path / "missing"), name="child"
                )
            )
        )

    assert error.value.status_code == 404
    assert not (tmp_path / "missing").exists()
