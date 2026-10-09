"""Token-free lifecycle observations for chat-created tmux agents.

Stop means the agent ended a turn, never independent acceptance of its work.
The tmux option survives web/backend restarts; receipts retain observed events.
"""
import json
import re
from uuid import uuid4

from .tmux_service import _run_tmux, _invalidate_sessions_cache

OPTION = '@dolphin-chat-work'


async def attach(session_name: str) -> dict:
    _, identity, _ = await _run_tmux('display-message', '-p', '-t', session_name + ':0.0', '#{session_id}\n#{pane_id}')
    session_id, pane_id = identity.strip().splitlines()
    work = {'id': uuid4().hex, 'session_id': session_id, 'pane_id': pane_id,
            'state': 'starting', 'finished_at': None}
    await _run_tmux('set-option', '-t', session_id, OPTION, json.dumps(work))
    return work


async def observe(work: dict) -> dict:
    if work['state'] == 'closed':
        return work
    code, raw, _ = await _run_tmux('show-options', '-qv', '-t', work['session_id'], OPTION, check=False)
    try:
        current = json.loads(raw) if not code else {}
        if current.get('id') == work['id'] and current.get('pane_id') == work['pane_id']:
            return current
    except (ValueError, AttributeError):
        pass
    return {**work, 'state': 'unavailable'}


async def close(work: dict) -> dict:
    current = await observe(work)
    if current['state'] != 'stopped':
        raise ValueError('Session is working or unavailable. Inspect it before closing.')
    # Compare the entire observed value inside tmux's command queue. A new
    # prompt or a replacement session invalidates this close, even after polling.
    if not re.fullmatch(r'\$\d+', current['session_id']):
        raise ValueError('Invalid session identity.')
    _, raw, _ = await _run_tmux('show-options', '-qv', '-t', current['session_id'], OPTION)
    if json.loads(raw) != current:
        raise ValueError('Session changed. Inspect it before closing.')
    condition = '#{==:#{@dolphin-chat-work},#{l:' + raw.strip().replace('}', '#}') + '}}'
    if current.get('close_token'):
        if not re.fullmatch(r'[0-9a-f]{32}', current['close_token']):
            raise ValueError('Invalid close token.')
        condition = '#{==:#{@dolphin-chat-work-close-token},' + current['close_token'] + '}'
    _, output, _ = await _run_tmux('if-shell', '-F', '-t', current['session_id'], condition,
        'kill-session -t ' + current['session_id'], 'display-message -p "Session changed"')
    if output.strip():
        raise ValueError('Session changed. Inspect it before closing.')
    _invalidate_sessions_cache()
    return {**current, 'state': 'closed'}
