"""Authenticated local CLIs for reasoning; Dolphin executes and records tool calls."""
import asyncio
import json
import os
import re
from pathlib import Path
import shutil
import signal
import tempfile
import tomllib
import uuid

SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        'content': {'type': 'string'},
        'calls': {'type': 'array', 'maxItems': 8, 'items': {
            'type': 'object', 'additionalProperties': False,
            'properties': {'name': {'type': 'string'}, 'arguments': {'type': 'string'}},
            'required': ['name', 'arguments'],
        }},
    }, 'required': ['content', 'calls'],
}

class EngineUnavailable(RuntimeError):
    pass

async def invoke(command, prompt, cwd, timeout=100, check_exit=True, on_line=None):
    env = dict(os.environ)
    # Use the user's first-party CLI login, never the old LiteLLM alias or a
    # terminal session's nested-agent markers / provider overrides.
    for key in ('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL'):
        env.pop(key, None)
    process = await asyncio.create_subprocess_exec(*command, cwd=cwd, env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    async def collect():
        process.stdin.write(prompt.encode())
        await process.stdin.drain()
        process.stdin.close()
        data = bytearray()
        lines = bytearray()
        while chunk := await process.stdout.read(16384):
            data.extend(chunk)
            if on_line:
                lines.extend(chunk)
                while b'\n' in lines:
                    line, _, remainder = lines.partition(b'\n')
                    lines[:] = remainder
                    if line.strip():
                        on_line(line.decode())
            if len(data) > 2_000_000:
                raise EngineUnavailable('Engine output exceeded limit.')
        await process.wait()
        if process.returncode and check_exit:
            raise EngineUnavailable('Engine exited unsuccessfully.')
        return data.decode()
    try:
        return await asyncio.wait_for(collect(), timeout)
    finally:
        if process.returncode is None:
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()

def partial_content(value):
    """Decode only the user-facing content string, never tool arguments/thinking."""
    match = re.match(r'^\s*\{\s*"content"\s*:\s*(")', value)
    if not match:
        return ''
    value = value[match.start(1):]
    for trim in range(min(12, len(value))):
        candidate = value[:-trim] if trim else value
        try:
            text, _ = json.JSONDecoder().raw_decode(candidate + '"')
            return text.encode('utf-8', errors='ignore').decode() if isinstance(text, str) else ''
        except ValueError:
            pass
    return ''

async def complete(messages, tools, preferred='claude', on_text=None):
    prompt = ('You are the reasoning engine for Dolphin. The conversation below contains its system instructions, '
              'background evidence, actual user request, and any tool results. Answer the latest user request. '
              'Use run_native_task for normal CLI abilities and any authorized action without a dedicated shortcut. '
              'The listed tools are entry points, not your capability limit. Dolphin executes and records them. '
              'Return the required JSON: content is the final Markdown answer when calls is empty; otherwise '
              'calls contains requested tool names and arguments encoded as JSON strings. Never claim a tool '
              'ran until its result appears in the conversation.\n' + json.dumps({'conversation': messages, 'tools': tools}))
    engines = ['claude', 'codex'] if preferred == 'claude' else ['codex']
    for engine in engines:
        executable = shutil.which(engine)
        if not executable:
            continue
        try:
            if on_text:
                on_text('')
            with tempfile.TemporaryDirectory(prefix='dolphin-model-') as directory:
                if engine == 'claude':
                    command = [executable, '-p', '--model', 'opus', '--tools', '',
                               '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                               '--setting-sources', '', '--no-session-persistence',
                               '--output-format', 'json', '--json-schema', json.dumps(SCHEMA)]
                    if on_text:
                        command[command.index('--output-format') + 1] = 'stream-json'
                        command += ['--verbose', '--include-partial-messages']
                        partial = ''
                        structured_index = None
                        def receive(line):
                            nonlocal partial, structured_index
                            event = json.loads(line).get('event', {})
                            block = event.get('content_block', {})
                            if event.get('type') == 'content_block_start' and block.get('name') == 'StructuredOutput':
                                structured_index = event.get('index')
                                partial = ''
                            delta = event.get('delta', {})
                            if structured_index is not None and event.get('index') == structured_index and delta.get('type') == 'input_json_delta':
                                partial += delta.get('partial_json', '')
                                on_text(partial_content(partial)[:12000])
                        raw = await invoke(command, prompt, directory, on_line=receive)
                        wire = next(json.loads(line) for line in reversed(raw.splitlines()) if line.strip() and json.loads(line).get('type') == 'result')
                    else:
                        wire = json.loads(await invoke(command, prompt, directory))
                    if wire.get('is_error'):
                        raise EngineUnavailable('Claude unavailable.')
                    decision = wire.get('structured_output')
                    model = next(iter(wire.get('modelUsage', {})), 'opus')
                else:
                    schema = Path(directory) / 'schema.json'
                    output = Path(directory) / 'answer.json'
                    schema.write_text(json.dumps(SCHEMA))
                    config_path = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'config.toml'
                    config = tomllib.loads(config_path.read_text()) if config_path.exists() else {}
                    model = config.get('model', 'gpt-6-astra')
                    command = [executable, 'exec', '--model', model, '--ignore-user-config', '--ephemeral',
                               '--skip-git-repo-check', '--sandbox', 'read-only',
                               '-c', 'features.shell_tool=false',
                               '--output-schema', str(schema), '--output-last-message', str(output), '-']
                    if on_text:
                        command.insert(2, '--json')
                        def receive_codex(line):
                            item = json.loads(line).get('item', {})
                            if item.get('type') == 'agent_message':
                                on_text(partial_content(item.get('text', ''))[:12000])
                        await invoke(command, prompt, directory, on_line=receive_codex)
                    else:
                        await invoke(command, prompt, directory)
                    decision = json.loads(output.read_text())

                if not isinstance(decision, dict) or not isinstance(decision.get('content'), str) or not isinstance(decision.get('calls'), list):
                    raise EngineUnavailable('Invalid structured response.')
                calls = []
                for call in decision['calls']:
                    if not isinstance(call.get('name'), str) or not isinstance(call.get('arguments'), str):
                        raise EngineUnavailable('Invalid tool request.')
                    calls.append({'id': uuid.uuid4().hex, 'type': 'function', 'function': call})
                return {'content': decision['content'], 'tool_calls': calls}, {'provider': engine, 'model': model, 'fallback': engine != 'claude'}
        except (OSError, ValueError, KeyError, TypeError, StopIteration, asyncio.TimeoutError, EngineUnavailable):
            continue
    if on_text:
        on_text('')
    raise EngineUnavailable('Claude Code and Codex are unavailable. No local-model substitution was made.')
