import pytest
import pytest_asyncio
from pydantic import ValidationError
from app.dolphin_agent_tools import TOOL_MODELS, tool_definitions


def test_tools_reject_unknown_fields_and_paths():
    with pytest.raises(ValidationError):
        TOOL_MODELS['read_session'](project_id='../etc', session_name='main')
    with pytest.raises(ValidationError):
        TOOL_MODELS['create_session'](project_id='abc', name='new', mode='shell', command='rm -rf /')
    assert 'delete_project' not in TOOL_MODELS
    assert 'kill_session' not in TOOL_MODELS


def test_all_tools_have_strict_schemas():
    definitions = tool_definitions()
    assert len(definitions) >= 9
    assert all(t['function']['parameters']['additionalProperties'] is False for t in definitions)


@pytest.mark.skipif('remember' not in TOOL_MODELS, reason='memory tools are a personal extension')
def test_memory_requires_evidence_and_target():
    with pytest.raises(ValidationError):
        TOOL_MODELS['remember'](fact='done')

from types import SimpleNamespace
import httpx
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import dolphin_agent, tmux_service
from app.models import DolphinToolRun
from app.database import Base
from app.dolphin_agent_tools import DolphinTools, ToolError


@pytest_asyncio.fixture
async def ledger(tmp_path, monkeypatch):
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/receipts.db')
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(dolphin_agent, 'async_session', async_sessionmaker(engine, expire_on_commit=False))
    yield
    await engine.dispose()


@pytest.mark.asyncio
async def test_mutation_is_reserved_once_and_reads_can_refresh(ledger):
    class FakeTools:
        turn_id = 'turn'
        calls = 0
        async def execute(self, name, arguments):
            self.calls += 1
            return {'value': self.calls}
    tools = FakeTools()
    args = {'project_id': 'p', 'name': 'new', 'mode': 'codex'}
    first = await dolphin_agent.execute_recorded(tools, 'create_session', args)
    assert await dolphin_agent.execute_recorded(tools, 'create_session', args) == first
    assert tools.calls == 1
    await dolphin_agent.execute_recorded(tools, 'list_projects', {})
    await dolphin_agent.execute_recorded(tools, 'list_projects', {})
    assert tools.calls == 3


@pytest.mark.asyncio
async def test_ambiguous_mutation_is_not_retried(ledger):
    class FakeTools:
        turn_id = 'unknown'
        calls = 0
        async def execute(self, name, arguments):
            self.calls += 1
            raise httpx.ReadTimeout('lost acknowledgement')
    tools = FakeTools()
    args = {'project_id': 'p', 'name': 'new', 'mode': 'codex'}
    await dolphin_agent.execute_recorded(tools, 'create_session', args)
    await dolphin_agent.execute_recorded(tools, 'create_session', args)
    assert tools.calls == 1
    assert (await dolphin_agent.receipts('unknown'))[0]['status'] == 'unknown'


@pytest.mark.asyncio
async def test_work_requires_reading_exact_target():
    async def dispatch(*args):
        pytest.fail('Must not dispatch without inspection')
    async with httpx.AsyncClient() as api:
        tools = DolphinTools(api, dispatch, 'turn')
        with pytest.raises(ToolError, match='Read this exact session'):
            await tools.execute('send_work', {'project_id': 'p', 'session_name': 's', 'instruction': 'Do work'})


@pytest.mark.asyncio
async def test_agent_dispatch_refuses_plain_shell_before_input(monkeypatch):
    async def session(*args):
        return SimpleNamespace(observation_degraded=False, is_codex_running=False, is_claude_code_running=False)
    monkeypatch.setattr(tmux_service, 'require_workspace_session', session)
    with pytest.raises(tmux_service.TmuxServiceError, match='No observable'):
        await tmux_service.send_input(None, 's', 'Do work', require_agent=True)


def test_agent_guard_accepts_claude_but_rejects_degraded():
    session = SimpleNamespace(observation_degraded=False, is_codex_running=False, is_claude_code_running=True)
    tmux_service._require_observable_agent_session(session)
    session.observation_degraded = True
    with pytest.raises(tmux_service.TmuxServiceError):
        tmux_service._require_observable_agent_session(session)


@pytest.mark.asyncio
async def test_restart_marks_pending_agent_turn_and_unknown_write(ledger):
    import uuid
    from app.chief_conversation_repository import ChiefConversationRepository
    async with dolphin_agent.async_session() as db:
        repo = ChiefConversationRepository(db)
        thread = await repo.create_thread(title="Test")
        key = str(uuid.uuid4())
        turn = await repo.begin_turn(thread.id, idempotency_key=key, user_text="Create a session")
        db.add(DolphinToolRun(id="reserved", turn_id=turn.turn_request_id, tool="create_session",
                             arguments_json="{}", status="running"))
        await db.commit()
    await dolphin_agent.recover_agent_runs()
    async with dolphin_agent.async_session() as db:
        assert (await db.get(DolphinToolRun, "reserved")).status == "unknown"
        assert (await ChiefConversationRepository(db).get_turn(thread.id, key)).status == "failed"


def test_dashboard_observation_distinguishes_open_minimized_and_pinned():
    from app.dolphin_agent import DolphinUserTurnRequest, dashboard_observation
    request = DolphinUserTurnRequest.model_validate({'text': 'What is open here?', 'dashboard_context': {
        'open_windows': [{'project_id': 'p', 'session_name': 'visible'}, {'project_id': 'p', 'session_name': 'hidden', 'minimized': True}],
        'pinned_sessions': [{'project_id': 'p', 'session_name': 'not-open'}],
        'focused_session': None,
    }})
    observation = dashboard_observation(request.dashboard_context)
    assert observation['open_window_count'] == 2
    assert observation['visible_window_count'] == 1
    assert observation['focused_session'] is None
    assert observation['pinned_sessions'][0]['session_name'] == 'not-open'
    assert dashboard_observation(None)['available'] is False
    with pytest.raises(ValidationError):
        DolphinUserTurnRequest.model_validate({'text': 'hi', 'dashboard_context': {'open_windows': [{'project_id': '../bad', 'session_name': 'main'}]}})


def test_latest_question_is_last_and_dashboard_is_not_a_user_request():
    from app.dolphin_agent import build_agent_messages
    history = [SimpleNamespace(id='old', role='user', text='What windows are open?'), SimpleNamespace(id='new', role='user', text='How could Dolphin change the future of work?')]
    messages = build_agent_messages(history, 'new', history[-1].text, {'dashboard': {'open_windows': ['one', 'two']}})
    assert messages[-1] == {'role': 'user', 'content': history[-1].text}
    assert messages[-2]['role'] == 'assistant'
    assert 'BACKGROUND OBSERVATIONS' in messages[-2]['content']
    assert sum(m['content'] == history[-1].text for m in messages) == 1

@pytest.mark.asyncio
async def test_native_project_work_routes_to_persistent_session(monkeypatch, tmp_path):
    from app import dolphin_agent_tools, dolphin_work_tracker
    from unittest.mock import AsyncMock
    monkeypatch.setattr(dolphin_work_tracker, 'attach', AsyncMock(return_value={'id': 'test', 'state': 'starting'}))
    monkeypatch.setattr(dolphin_agent_tools.shutil, 'which', lambda name: '/bin/' + name)
    calls = []
    async def launch(path, name, initial_prompt=None):
        calls.append((path, name, initial_prompt))
    monkeypatch.setattr(tmux_service, 'start_claude', launch)
    allowed = True
    async def handle(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'path': str(tmp_path), 'is_allowed': allowed})
        return httpx.Response(200, json={'name': 'chat-turn-dolphin'})
    async with httpx.AsyncClient(base_url='http://test', transport=httpx.MockTransport(handle)) as api:
        tools = DolphinTools(api, None, 'turn', 'Please fix the project')
        result = await tools.execute('run_native_task', {'instruction': 'Inspect files', 'project_id': 'p'})
        assert result['status'] == 'submitted'
        assert result['session_name'] == 'chat-turn-dolphin'
        assert 'Please fix the project' in calls[0][2] and 'Inspect files' in calls[0][2]
        allowed = False
        with pytest.raises(ToolError, match='workspace is unavailable'):
            await tools.execute('run_native_task', {'instruction': 'Inspect', 'project_id': 'p'})
        assert len(calls) == 1

@pytest.mark.asyncio
async def test_native_timeout_is_unknown_and_not_replayed(ledger):
    import asyncio
    class NativeTools:
        turn_id = 'native-timeout'
        calls = 0
        async def execute(self, name, arguments):
            self.calls += 1
            raise asyncio.TimeoutError()
    tools = NativeTools()
    args = {'instruction': 'Write a requested file', 'project_id': 'p'}
    await dolphin_agent.execute_recorded(tools, 'run_native_task', args)
    await dolphin_agent.execute_recorded(tools, 'run_native_task', args)
    assert tools.calls == 1
    assert (await dolphin_agent.receipts(tools.turn_id))[0]['status'] == 'unknown'

@pytest.mark.asyncio
async def test_native_work_cannot_bypass_tmux_by_omitting_project():
    async with httpx.AsyncClient() as api:
        tools = DolphinTools(api, None, 'turn', 'Search the internet')
        for args in ({'instruction': 'Search'}, {'instruction': 'Search', 'project_id': None}):
            with pytest.raises(ValidationError):
                await tools.execute('run_native_task', args)

@pytest.mark.asyncio
@pytest.mark.parametrize('available, fails, expected', [('claude', False, 'claude'), ('codex', False, 'codex'), ('claude', True, 'claude')])
async def test_project_work_starts_fresh_session_once_with_prompt(ledger, monkeypatch, tmp_path, available, fails, expected):
    from app import dolphin_agent_tools, dolphin_work_tracker
    from unittest.mock import AsyncMock
    monkeypatch.setattr(dolphin_work_tracker, 'attach', AsyncMock(return_value={'id': 'test', 'state': 'starting'}))
    monkeypatch.setattr(dolphin_agent_tools.shutil, 'which', lambda name: '/bin/' + name if name == available else None)
    calls = []
    async def handle(request):
        calls.append((request.method, request.url.path))
        if request.method == 'GET':
            return httpx.Response(200, json={'path': str(tmp_path), 'is_allowed': True})
        assert __import__('json').loads(request.content)['mode'] == 'shell'
        return httpx.Response(200, json={'name': 'actual-session-dolphin'})
    async def launch(path, session_name, initial_prompt=None):
        calls.append(('launch', session_name))
        assert path == tmp_path
        assert 'Fix the project tests' in initial_prompt
        assert 'Inspect the failing tests first' in initial_prompt
        if fails:
            raise tmux_service.TmuxServiceError('Readiness was not confirmed', 503)
    monkeypatch.setattr(tmux_service, 'start_claude', launch)
    monkeypatch.setattr(tmux_service, 'start_codex', launch)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle), base_url='http://test') as api:
        tools = DolphinTools(api, None, 'project-work', 'Fix the project tests')
        args = {'project_id': 'p', 'name': 'test-fix', 'instruction': 'Inspect the failing tests first'}
        result = await dolphin_agent.execute_recorded(tools, 'start_project_work', args)
        assert await dolphin_agent.execute_recorded(tools, 'start_project_work', args) == result
    result = result['result']
    assert result['session_name'] == 'actual-session-dolphin'
    assert result['engine'] == expected
    assert result['status'] == ('unknown' if fails else 'submitted')
    assert len([c for c in calls if c[0] == 'POST']) == 1
    assert len([c for c in calls if c[0] == 'launch']) == 1
    assert (await dolphin_agent.receipts('project-work'))[0]['status'] == result['status']


@pytest.mark.asyncio
async def test_independent_chat_threads_can_reason_concurrently(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock
    entered = []
    both_entered = asyncio.Event()
    async def complete(messages, tools, preferred, on_text=None):
        text = messages[-1]['content']
        entered.append(text)
        if len(entered) == 2:
            both_entered.set()
        await asyncio.wait_for(both_entered.wait(), 2)
        return {'content': 'Reply to ' + text, 'tool_calls': []}, {'provider': 'claude'}
    monkeypatch.setattr(dolphin_agent, 'complete', complete)
    monkeypatch.setattr(dolphin_agent, 'execute_recorded', AsyncMock(return_value={'result': []}))
    monkeypatch.setattr(dolphin_agent, 'receipts', AsyncMock(return_value=[]))
    def repository(thread):
        return SimpleNamespace(
            begin_turn=AsyncMock(return_value=SimpleNamespace(response_bytes=None, should_generate=True, turn_request_id=thread, user_message_id=thread)),
            list_recent_messages=AsyncMock(return_value=[]), complete_turn=AsyncMock(),
        )
    first, second = await asyncio.gather(
        dolphin_agent.run_agent(repository('first'), 'first', 'First tab', 'key-first', None),
        dolphin_agent.run_agent(repository('second'), 'second', 'Second tab', 'key-second', None),
    )
    assert first['display_text'] == 'Reply to First tab'
    assert second['display_text'] == 'Reply to Second tab'
    assert first['thread_id'] != second['thread_id']


def test_dashboard_distinguishes_project_windows_from_hidden_terminal_tabs():
    from app.dolphin_agent import DashboardContext, dashboard_observation
    result = dashboard_observation(DashboardContext.model_validate({'open_windows': [
        {'project_id': 'one', 'session_name': 'main'},
        {'project_id': 'one', 'session_name': 'tests', 'tab_hidden': True},
        {'project_id': 'two', 'session_name': 'work', 'minimized': True},
    ]}))
    assert result['project_window_count'] == 2
    assert result['visible_window_count'] == 1
    assert len(result['open_windows']) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize('tool, extra, taken, expected', [
    ('run_native_task', {}, set(), ['minimum-width-chat-window']),
    ('run_native_task', {'name': 'chat-panel-width'}, set(), ['chat-panel-width']),
    ('start_project_work', {'name': 'Investigate-the-minimum-width-of-the-dolphin-chat-window-panel'}, set(), ['investigate-the-minimum-width']),
    ('start_project_work', {'name': 'chat-f393fa8c8f87'}, set(), ['minimum-width-chat-window']),
    ('start_project_work', {'name': 'chat-panel-width'}, {'chat-panel-width', 'chat-panel-width-2'},
     ['chat-panel-width', 'chat-panel-width-2', 'chat-panel-width-3']),
])
async def test_delegated_sessions_are_named_after_the_task(monkeypatch, tmp_path, tool, extra, taken, expected):
    from app import dolphin_agent_tools, dolphin_work_tracker
    from unittest.mock import AsyncMock
    monkeypatch.setattr(dolphin_work_tracker, 'attach', AsyncMock(return_value={'id': 'test', 'state': 'starting'}))
    monkeypatch.setattr(dolphin_agent_tools.shutil, 'which', lambda name: '/bin/' + name)
    monkeypatch.setattr(tmux_service, 'start_claude', AsyncMock())
    requested = []
    async def handle(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'path': str(tmp_path), 'is_allowed': True})
        name = __import__('json').loads(request.content)['name']
        requested.append(name)
        if name in taken:
            return httpx.Response(400, json={'detail': 'A tmux session with that name already exists.'})
        return httpx.Response(200, json={'name': f'{name}-dolphin'})
    async with httpx.AsyncClient(base_url='http://test', transport=httpx.MockTransport(handle)) as api:
        tools = DolphinTools(api, None, 'turn', 'what is the minimum width of this chat window of dolphin on dolphin tasks?')
        result = await tools.execute(tool, {'project_id': 'p', 'instruction': 'Investigate the chat width', **extra})
    assert requested == expected
    assert result['session_name'] == f'{expected[-1]}-dolphin'


def test_task_label_keeps_the_meaningful_words():
    from app.dolphin_agent_tools import task_label
    assert task_label('Fix the flaky login redirect test in Atlas') == 'fix-flaky-login-redirect'
    assert task_label("let's make sure it works") == 'works'
    assert task_label('???') == 'task'
    assert task_label('internationalisation localisation configuration documentation') == 'internationalisation'
    assert task_label('a' * 50) == 'a' * 32
    long_request = 'please could you look into why the dolphin chat panel collapses when the window narrows and fix it'
    assert task_label(long_request) == 'dolphin-chat-panel-collapses'
    assert len(task_label(long_request)) <= 32
