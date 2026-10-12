import { createContext, useContext } from 'react';

import { api, type Api } from './api';

/** The backend a part of the page works against. Dolphin Desktop shows several
    machines in one window; each machine's projects, dialogs and terminals sit
    inside a provider for that machine's client. Everything else uses this
    window's own backend. */
export const ApiContext = createContext<Api>(api);

export const useApi = (): Api => useContext(ApiContext);
