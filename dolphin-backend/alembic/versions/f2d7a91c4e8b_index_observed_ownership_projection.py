"""index bounded observed ownership and authenticated checkpoint heads

Revision ID: f2d7a91c4e8b
Revises: c1a9d4e72f06
Create Date: 2026-09-08 12:00:00

"""

from __future__ import annotations

import hashlib
import json
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "f2d7a91c4e8b"
down_revision: Union[str, Sequence[str], None] = "c1a9d4e72f06"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


TEXT_COLUMNS = (
    "observed_task_id",
    "observed_automation_id",
    "observed_session_name",
    "observed_executor_binding_json",
    "observed_head_event_id",
    "observed_head_snapshot_hash",
    "observed_checkpoint_sha256",
    "observed_task_scope_sha256",
    "observed_release_authority_json",
    "observed_release_authority_sha256",
    "observed_projection_sha256",
)
INDEXES = {
    "ix_task_proposals_observed_automation": (
        "project_id",
        "observed_automation_id",
        "observed_released",
    ),
    "ix_task_proposals_observed_session": (
        "project_id",
        "observed_session_name",
        "observed_released",
    ),
    "ix_task_proposals_observed_task": ("observed_task_id",),
}


def _dump(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _checkpoint(
    prior: str | None,
    sequence: int,
    event_id: str,
    snapshot_hash: str,
) -> str:
    return hashlib.sha256(
        _dump(
            {
                "prior_checkpoint_sha256": prior,
                "sequence": sequence,
                "event_id": event_id,
                "snapshot_hash": snapshot_hash,
            }
        ).encode()
    ).hexdigest()


def _receipt_authority(bind, receipt_id: object, task_id: str) -> dict[str, object]:
    if not isinstance(receipt_id, str) or not receipt_id:
        raise RuntimeError("observed release authority is unsafe")
    row = bind.execute(
        sa.text(
            "SELECT id, task_id, project_id, contract_revision, status "
            "FROM task_evidence_receipts WHERE id = :receipt_id"
        ),
        {"receipt_id": receipt_id},
    ).mappings().one_or_none()
    if row is None or row["task_id"] != task_id or row["status"] != "accepted":
        raise RuntimeError("observed release authority is unsafe")
    return {
        "kind": "evidence_receipt",
        "id": row["id"],
        "task_id": row["task_id"],
        "project_id": row["project_id"],
        "contract_revision": row["contract_revision"],
        "status": row["status"],
    }


def _durable_authority(bind, authority: object, task_id: str) -> dict[str, object]:
    if not isinstance(authority, dict):
        raise RuntimeError("observed release authority is unsafe")
    durable = dict(authority)
    if authority.get("kind") == "evidence_receipt":
        return _receipt_authority(bind, authority.get("id"), task_id)
    if authority.get("kind") != "quality_event":
        raise RuntimeError("observed release authority is unsafe")
    durable["receipt"] = _receipt_authority(
        bind,
        authority.get("receipt_id"),
        task_id,
    )
    return durable


def _projection_digest(values: dict[str, object]) -> str:
    material = {
        "proposal_id": values["proposal_id"],
        "project_id": values["project_id"],
        "task_id": values["task_id"],
        "automation_id": values["automation_id"],
        "session_name": values["session_name"],
        "executor_binding_json": values["executor_binding_json"],
        "head_event_id": values["head_event_id"],
        "head_sequence": values["head_sequence"],
        "head_snapshot_hash": values["head_snapshot_hash"],
        "checkpoint_sha256": values["checkpoint_sha256"],
        "task_scope_sha256": values["task_scope_sha256"],
        "release_authority_json": values["release_authority_json"],
        "release_authority_sha256": values["release_authority_sha256"],
        "released": bool(values["released"]),
        "task_deleted": bool(values["task_deleted"]),
    }
    return hashlib.sha256(_dump(material).encode()).hexdigest()


def _backfill() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT e.id, e.project_id, e.proposal_id, e.provenance_sequence, "
            "e.snapshot_json, e.snapshot_hash "
            "FROM task_planning_events e "
            "WHERE e.proposal_id IS NOT NULL "
            "AND e.actor IN ('system:observed-work', 'system:observed-work:summary') "
            "ORDER BY e.proposal_id, e.provenance_sequence"
        )
    ).mappings().all()
    grouped: dict[str, list[object]] = {}
    for row in rows:
        grouped.setdefault(row["proposal_id"], []).append(row)
    for proposal_id, events in grouped.items():
        # A malformed row with no authenticated target is not ownership. This
        # preserves unrelated legacy planning data; once any row establishes a
        # target, every row in that proposal must validate or upgrade fails
        # closed for that claimed target.
        has_claimed_target = False
        for event in events:
            try:
                candidate = json.loads(event["snapshot_json"])
            except (json.JSONDecodeError, TypeError):
                continue
            claimed_binding = candidate.get("executor_binding") if isinstance(candidate, dict) else None
            if (
                isinstance(claimed_binding, dict)
                and isinstance(claimed_binding.get("automation_id"), str)
                and isinstance(claimed_binding.get("session_name"), str)
                and isinstance(candidate.get("task_id"), str)
            ):
                has_claimed_target = True
                break
        if not has_claimed_target:
            continue
        checkpoint = None
        binding = None
        task_id = None
        task_scope = None
        released = False
        task_deleted = False
        release_authority = None
        for expected, event in enumerate(events, start=1):
            if event["provenance_sequence"] != expected:
                raise RuntimeError("observed provenance projection is unsafe")
            raw = event["snapshot_json"]
            if (
                not isinstance(raw, str)
                or hashlib.sha256(raw.encode()).hexdigest() != event["snapshot_hash"]
            ):
                raise RuntimeError("observed provenance projection is unsafe")
            try:
                payload = json.loads(raw)
            except (json.JSONDecodeError, TypeError) as error:
                raise RuntimeError("observed provenance projection is unsafe") from error
            candidate_binding = payload.get("executor_binding")
            candidate_task = payload.get("task_id")
            candidate_scope = payload.get("task_scope_sha256")
            if (
                not isinstance(candidate_binding, dict)
                or not isinstance(candidate_task, str)
                or not isinstance(candidate_scope, str)
                or len(candidate_scope) != 64
            ):
                raise RuntimeError("observed provenance projection is unsafe")
            if binding is not None and binding != candidate_binding:
                raise RuntimeError("observed provenance projection is unsafe")
            if task_id is not None and task_id != candidate_task:
                raise RuntimeError("observed provenance projection is unsafe")
            binding = candidate_binding
            task_id = candidate_task
            task_scope = candidate_scope
            checkpoint = _checkpoint(
                checkpoint,
                expected,
                event["id"],
                event["snapshot_hash"],
            )
            if payload.get("result") == "lease_released":
                release_authority = _durable_authority(
                    bind,
                    payload.get("authority"),
                    task_id,
                )
                released = True
            if payload.get("record_type") == "release_tombstone":
                task_deleted = True
        proposal = bind.execute(
            sa.text(
                "SELECT project_id, approved_task_id, decided_by FROM task_proposals "
                "WHERE id = :proposal_id"
            ),
            {"proposal_id": proposal_id},
        ).mappings().one_or_none()
        if (
            proposal is None
            or proposal["project_id"] != events[-1]["project_id"]
            or proposal["approved_task_id"] != task_id
            or proposal["decided_by"] != "system:observed-work"
            or not isinstance(binding.get("automation_id"), str)
            or not isinstance(binding.get("session_name"), str)
        ):
            raise RuntimeError("observed provenance projection is unsafe")
        release_json = _dump(release_authority) if release_authority else None
        values = {
            "proposal_id": proposal_id,
            "project_id": proposal["project_id"],
            "task_id": task_id,
            "automation_id": binding["automation_id"],
            "session_name": binding["session_name"],
            "executor_binding_json": _dump(binding),
            "head_event_id": events[-1]["id"],
            "head_sequence": len(events),
            "head_snapshot_hash": events[-1]["snapshot_hash"],
            "checkpoint_sha256": checkpoint,
            "task_scope_sha256": task_scope,
            "release_authority_json": release_json,
            "release_authority_sha256": (
                hashlib.sha256(release_json.encode()).hexdigest()
                if release_json
                else None
            ),
            "released": released,
            "task_deleted": task_deleted,
        }
        values["projection_sha256"] = _projection_digest(values)
        bind.execute(
            sa.text(
                "UPDATE task_proposals SET "
                "observed_task_id=:task_id, observed_automation_id=:automation_id, "
                "observed_session_name=:session_name, "
                "observed_executor_binding_json=:executor_binding_json, "
                "observed_head_event_id=:head_event_id, "
                "observed_head_sequence=:head_sequence, "
                "observed_head_snapshot_hash=:head_snapshot_hash, "
                "observed_checkpoint_sha256=:checkpoint_sha256, "
                "observed_task_scope_sha256=:task_scope_sha256, "
                "observed_release_authority_json=:release_authority_json, "
                "observed_release_authority_sha256=:release_authority_sha256, "
                "observed_released=:released, observed_task_deleted=:task_deleted, "
                "observed_projection_sha256=:projection_sha256 "
                "WHERE id=:proposal_id"
            ),
            values,
        )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "task_proposals" not in inspector.get_table_names():
        return
    columns = {item["name"] for item in inspector.get_columns("task_proposals")}
    for name in TEXT_COLUMNS:
        if name not in columns:
            op.add_column("task_proposals", sa.Column(name, sa.Text(), nullable=True))
    if "observed_head_sequence" not in columns:
        op.add_column(
            "task_proposals",
            sa.Column("observed_head_sequence", sa.Integer(), nullable=True),
        )
    for name in ("observed_released", "observed_task_deleted"):
        if name not in columns:
            op.add_column(
                "task_proposals",
                sa.Column(
                    name,
                    sa.Boolean(),
                    server_default=sa.text("0"),
                    nullable=False,
                ),
            )
    _backfill()
    existing = {item["name"] for item in sa.inspect(bind).get_indexes("task_proposals")}
    for name, fields in INDEXES.items():
        if name not in existing:
            op.create_index(name, "task_proposals", list(fields), unique=False)


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "task_proposals" not in inspector.get_table_names():
        return
    indexes = {item["name"] for item in inspector.get_indexes("task_proposals")}
    for name in INDEXES:
        if name in indexes:
            op.drop_index(name, table_name="task_proposals")
    columns = {item["name"] for item in inspector.get_columns("task_proposals")}
    for name in (
        "observed_head_sequence",
        "observed_released",
        "observed_task_deleted",
        *reversed(TEXT_COLUMNS),
    ):
        if name in columns:
            op.drop_column("task_proposals", name)
