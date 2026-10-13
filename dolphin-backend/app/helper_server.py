"""The helper's uvicorn server, which says when it is ready.

Ready means after the app's startup: the database snapshot and the
migrations. Until then nothing may tell a client where to connect, so
helper.py writes `ready` into server.json from `on_ready`, never before.
"""

from __future__ import annotations

from typing import Callable

import uvicorn


class ReadyServer(uvicorn.Server):
    def __init__(self, config: uvicorn.Config, on_ready: Callable[[], None]) -> None:
        super().__init__(config)
        self._on_ready = on_ready

    async def startup(self, sockets=None) -> None:
        await super().startup(sockets=sockets)
        if self.started and not self.should_exit:
            self._on_ready()
