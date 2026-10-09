import json
from pathlib import Path
import pytest
from app import dolphin_model as model

@pytest.mark.asyncio
async def test_claude_first_with_no_native_tools(monkeypatch):
    monkeypatch.setattr(model.shutil, 'which', lambda name: '/bin/' + name)
    async def invoke(command, prompt, cwd):
        assert command[0] == '/bin/claude'
        assert command[command.index('--tools') + 1] == ''
        assert '--strict-mcp-config' in command
        return json.dumps({'structured_output': {'content': 'hello', 'calls': []}, 'modelUsage': {'claude-opus': {}}})
    monkeypatch.setattr(model, 'invoke', invoke)
    message, engine = await model.complete([], [])
    assert message['content'] == 'hello'
    assert engine == {'provider': 'claude', 'model': 'claude-opus', 'fallback': False}

@pytest.mark.asyncio
async def test_fallback_keeps_tool_results_and_uses_read_only_codex(monkeypatch):
    seen = []
    monkeypatch.setattr(model.shutil, 'which', lambda name: '/bin/' + name)
    async def invoke(command, prompt, cwd):
        seen.append(command[0])
        assert 'already submitted' in prompt
        if command[0].endswith('claude'):
            raise model.EngineUnavailable('unavailable')
        assert command[command.index('--sandbox') + 1] == 'read-only'
        Path(command[command.index('--output-last-message') + 1]).write_text(json.dumps({'content': 'Submitted, not verified.', 'calls': []}))
        return ''
    monkeypatch.setattr(model, 'invoke', invoke)
    message, engine = await model.complete([{'role': 'tool', 'content': 'already submitted'}], [])
    assert seen == ['/bin/claude', '/bin/codex']
    assert engine['fallback'] is True
    assert message['tool_calls'] == []

@pytest.mark.asyncio
async def test_unavailable_never_routes_to_local_model(monkeypatch):
    monkeypatch.setattr(model.shutil, 'which', lambda name: None)
    with pytest.raises(model.EngineUnavailable, match='No local-model'):
        await model.complete([], [])


def test_partial_content_decodes_only_answer_text():
    assert model.partial_content('{"content": "Hello') == 'Hello'
    assert model.partial_content('{"content": "line\\nnext\\u26') == 'line\nnext'
    assert model.partial_content('{"content": "a \\"quote\\"", "calls": []}') == 'a "quote"'
    assert model.partial_content('{"calls": [{"arguments": "secret') == ''
    assert model.partial_content('{"content": "Hello\\') == 'Hello'


@pytest.mark.asyncio
async def test_live_claude_text_arrives_before_final_result(monkeypatch):
    previews = []
    monkeypatch.setattr(model.shutil, 'which', lambda name: '/bin/' + name)
    async def invoke(command, prompt, cwd, on_line):
        assert '--include-partial-messages' in command
        on_line(json.dumps({'event': {'type': 'content_block_start', 'index': 0, 'content_block': {'name': 'StructuredOutput'}}}))
        on_line(json.dumps({'event': {'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '{"content": "Hello'}}}))
        assert previews[-1] == 'Hello'
        on_line(json.dumps({'event': {'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'private reasoning'}}}))
        assert previews[-1] == 'Hello'
        return json.dumps({'type': 'result', 'structured_output': {'content': 'Hello world', 'calls': []}})
    monkeypatch.setattr(model, 'invoke', invoke)
    result, _ = await model.complete([], [], on_text=previews.append)
    assert result['content'] == 'Hello world'
    assert 'private reasoning' not in ''.join(previews)
