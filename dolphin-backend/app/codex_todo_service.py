"""Prompt construction for dispatching Dolphin tasks to Codex."""

from dataclasses import dataclass
import hashlib
import json


@dataclass(frozen=True)
class TodoDispatchTask:
    id: str
    title: str
    description: str = ""
    execution_prompt: str = ""
    origin: str = "human"
    quality_governed: bool = False


def _task_payload(task: TodoDispatchTask) -> dict[str, str | bool]:
    execution_prompt = task.execution_prompt or task.description or task.title
    return {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "origin": task.origin,
        "execution_prompt": execution_prompt,
        "execution_prompt_sha256": hashlib.sha256(
            execution_prompt.encode("utf-8")
        ).hexdigest(),
        "quality_governed": task.quality_governed,
    }


def build_codex_todo_dispatch_prompt(
    *,
    project_name: str,
    workspace_path: str,
    tasks: list[TodoDispatchTask],
    api_base: str = "http://127.0.0.1:8400",
) -> str:
    task_payload = [_task_payload(task) for task in tasks]
    encoded_tasks = json.dumps(task_payload, ensure_ascii=True, separators=(",", ":"))
    prompt = (
        "Dolphin Tasks autopilot request. "
        f"Project: {project_name}. Workspace: {workspace_path}. "
        f"Active todos JSON: {encoded_tasks}. "
        "For each item, execution_prompt is its frozen exact work instruction; "
        "follow it verbatim in meaning and scope, and use title and description "
        "only as supporting metadata. "
        "The JSON array is already in Dolphin's canonical dependency-aware order. "
        "Preserve that order exactly; origin and priority are metadata, not permission "
        "to reshuffle the queue. "
        "Work on exactly one todo at a time. "
        "For each todo, proceed only if you are fully confident about the requested "
        "change, the implementation path, and the verification needed. "
        "If a todo is vague, risky, blocked, or needs human/product/design feedback, "
        "do not implement it; stop and reply with NEEDS HUMAN plus the specific "
        "questions. "
        "If this Codex session is already in the middle of another task, reply with "
        "BUSY and do not start a new todo. "
        "Preserve unrelated user changes. Run the relevant verification before "
        "marking any todo complete. "
        "For an item with quality_governed=true, GET its /api/tasks/<task_id>/quality "
        "contract, advance only its current stage through /api/tasks/<task_id>/quality/transition, and "
        "submit structured evidence for every acceptance check through /api/tasks/<task_id>/quality/evidence. "
        "Never review your own receipt or PUT that task Done; stop at Review until an "
        "independent human accepts it, which marks it Done. For quality_governed=false "
        "only, after genuine completion mark it done with: curl -sS -X PUT "
        "-H 'Content-Type: application/json' -d '{\"is_done\":true}' "
        f"{api_base}/api/tasks/<task_id>. "
        "Then continue to the next confident todo. "
        "When all confident todos are handled, summarize completed todos, skipped "
        "todos, verification, and any remaining human questions."
    )
    return prompt


def build_codex_todo_queue_prompt(
    *,
    project_name: str,
    workspace_path: str,
    task: TodoDispatchTask,
    mode: str,
    api_base: str = "http://127.0.0.1:8400",
) -> str:
    task_payload = _task_payload(task)
    encoded_task = json.dumps(task_payload, ensure_ascii=True, separators=(",", ":"))
    if mode == "queue":
        mode_instruction = (
            "Queue this todo after your current Dolphin todo and after any earlier "
            "queued Dolphin todos. Do not reorder it ahead of queued work. If you "
            "are currently working, do not interrupt that work; handle this todo "
            "only when it reaches the front of the queue."
        )
    else:
        mode_instruction = (
            "Start this todo now. If you are already in the middle of another task, "
            "reply with BUSY and do not start or mark this todo complete."
        )

    prompt = (
        "Dolphin Tasks single-todo request. "
        f"Project: {project_name}. Workspace: {workspace_path}. "
        f"Todo JSON: {encoded_task}. "
        "The execution_prompt field is the frozen exact work instruction; follow "
        "it verbatim in meaning and scope, and use title and description only as "
        "supporting metadata. "
        f"{mode_instruction} "
        "Work on exactly this todo; do not pull in other active todos unless they "
        "are strictly required for this todo. Proceed only if you are fully "
        "confident about the requested change, implementation path, and verification "
        "needed. If the todo is vague, risky, blocked, or needs human/product/design "
        "feedback, do not implement it; stop and reply with NEEDS HUMAN plus the "
        "specific questions. Preserve unrelated user changes. Run the relevant "
        "verification before marking the todo complete. "
        "If quality_governed=true, GET the task Quality Contract, advance only its "
        f"current stage through /api/tasks/{task.id}/quality/transition, then submit evidence "
        f"covering every acceptance check through /api/tasks/{task.id}/quality/evidence. Never "
        "review your own evidence or PUT the task Done; stop at Review for independent "
        "human acceptance. If quality_governed=false only, after genuine completion "
        "mark it done with: curl -sS -X PUT -H 'Content-Type: application/json' "
        f"-d '{{\"is_done\":true}}' {api_base}/api/tasks/{task.id}. "
        "Then continue with the next queued Dolphin todo, if one exists. "
        "Summarize the completed todo, verification, and any remaining human questions."
    )
    return prompt
