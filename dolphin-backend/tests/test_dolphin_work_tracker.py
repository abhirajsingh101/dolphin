"""Content-free hook lifecycle; uses only disposable tmux sessions, never a model."""
import json
from uuid import uuid4

import pytest

from app import agent_hook
from app import dolphin_work_tracker as tracker
from app.tmux_service import _run_tmux


@pytest.mark.asyncio
@pytest.mark.parametrize('provider', ['claude', 'codex'])
async def test_tracking_stop_new_work_and_exact_close(provider):
    name = 'dolphin-tracker-test-' + uuid4().hex[:10]
    await _run_tmux('new-session', '-d', '-s', name)
    try:
        work = await tracker.attach(name)
        hook = vars(agent_hook)
        event = {'tmux_pane': work['pane_id'], 'event_name': 'user_prompt_submit', 'provider': provider}
        hook['track_chat_work'](event)
        assert (await tracker.observe(work))['state'] == 'working'
        event['event_name'] = 'stop'
        hook['track_chat_work'](event, 'Final result: report.md written; tests not run.')
        finished = await tracker.observe(work)
        assert finished['state'] == 'stopped' and finished['finished_at']
        assert finished['output'] == 'Final result: report.md written; tests not run.'
        assert finished['output_source'] == 'agent_final_reply'
        event['event_name'] = 'user_prompt_submit'
        hook['track_chat_work'](event)
        current = await tracker.observe(finished)
        assert current['state'] == 'working' and current['finished_at'] == finished['finished_at']
        with pytest.raises(ValueError, match='working'):
            await tracker.close(current)
        event['event_name'] = 'stop'
        hook['track_chat_work'](event)
        assert (await tracker.close(await tracker.observe(current)))['state'] == 'closed'
        # Reusing the name must never let an old receipt terminate another session.
        await _run_tmux('new-session', '-d', '-s', name)
        assert (await tracker.observe(work))['state'] == 'unavailable'
        with pytest.raises(ValueError):
            await tracker.close(work)
    finally:
        await _run_tmux('kill-session', '-t', name, check=False)


@pytest.mark.asyncio
async def test_receipt_poll_is_durable_and_close_is_thread_scoped(tmp_path):
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.database import Base
    from app.models import ChiefThread, ChiefMessage, ChiefTurnRequest, DolphinToolRun
    from app.main import dolphin_tracked_work, dolphin_close_tracked_work
    from fastapi import HTTPException
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/tracker.db')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    name = 'dolphin-tracker-api-' + uuid4().hex[:8]
    await _run_tmux('new-session', '-d', '-s', name)
    try:
        work = await tracker.attach(name)
        async with factory() as db:
            db.add_all([ChiefThread(id='thread', title='Test'), ChiefThread(id='other', title='Other')])
            await db.flush()
            db.add(ChiefMessage(id='message', thread_id='thread', role='user', kind='text', text='Test', payload_json='{}'))
            await db.flush()
            db.add(ChiefTurnRequest(id='turn', thread_id='thread', user_message_id='message', idempotency_key=str(uuid4()), status='completed'))
            db.add(DolphinToolRun(id='receipt', turn_id='turn', tool='start_project_work', arguments_json='{}', status='submitted', result_json=json.dumps({'result': {'project_id':'p', 'session_name':name, 'tracking':work}})))
            await db.commit()
            assert (await dolphin_tracked_work('thread', db))[0]['state'] == 'starting'
            with pytest.raises(HTTPException) as error:
                await dolphin_close_tracked_work('other', 'receipt', db)
            assert error.value.status_code == 404
            with pytest.raises(HTTPException) as error:
                await dolphin_close_tracked_work('thread', 'receipt', db)
            assert error.value.status_code == 409
        hook = vars(agent_hook)
        hook['track_chat_work']({'tmux_pane':work['pane_id'], 'event_name':'stop'})
        async with factory() as db:
            assert (await dolphin_tracked_work('thread', db))[0]['finished_at']
        # A fresh DB session simulates a browser/backend restart.
        async with factory() as db:
            assert (await dolphin_tracked_work('thread', db))[0]['state'] == 'stopped'
            assert (await dolphin_close_tracked_work('thread', 'receipt', db))['status'] == 'closed'
        async with factory() as db:
            assert (await dolphin_tracked_work('thread', db))[0]['state'] == 'closed'
            assert (await dolphin_close_tracked_work('thread', 'receipt', db))['status'] == 'closed'
    finally:
        await _run_tmux('kill-session', '-t', name, check=False)
        await engine.dispose()


@pytest.mark.asyncio
async def test_summary_is_once_only_saved_in_chat_and_uses_captured_evidence(tmp_path, monkeypatch):
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from app.database import Base
    from app.models import ChiefThread, ChiefMessage, ChiefTurnRequest, DolphinToolRun
    from app import dolphin_work_summary as summary
    from sqlalchemy import select
    engine = create_async_engine(f'sqlite+aiosqlite:///{tmp_path}/summary.db')
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(summary, 'async_session', factory)
    calls = []
    async def complete(messages, tools):
        calls.append(messages)
        assert tools == []
        assert 'report.md' in messages[-1]['content']
        return {'content': 'The agent wrote report.md. Tests were not run.', 'tool_calls': []}, {'provider': 'claude', 'model': 'test', 'fallback': False}
    monkeypatch.setattr(summary, 'complete', complete)
    async with factory() as db:
        db.add(ChiefThread(id='thread', title='Test'))
        await db.flush()
        db.add(ChiefMessage(id='user', thread_id='thread', role='user', kind='text', text='Study the code', payload_json='{}'))
        await db.flush()
        db.add(ChiefTurnRequest(id='turn', thread_id='thread', user_message_id='user', idempotency_key=str(uuid4()), status='completed'))
        receipt = DolphinToolRun(id='receipt', turn_id='turn', tool='start_project_work', arguments_json='{}', status='submitted')
        db.add(receipt)
        await db.commit()
        tracking = {'state':'stopped', 'finished_at':'now', 'output':'Wrote report.md; tests not run.'}
        assert await summary.prepare(db, receipt, tracking) == ('running', True)
        await db.commit()
        assert await summary.prepare(db, receipt, tracking) == ('running', False)
    await summary.summarize('receipt')
    await summary.summarize('receipt')
    async with factory() as db:
        assert (await summary.prepare(db, await db.get(DolphinToolRun, 'receipt'), tracking)) == ('completed', False)
        messages = (await db.execute(select(ChiefMessage).where(ChiefMessage.role == 'assistant'))).scalars().all()
        assert len(messages) == 1 and 'report.md' in messages[0].text
        assert len(calls) == 1
    await engine.dispose()
