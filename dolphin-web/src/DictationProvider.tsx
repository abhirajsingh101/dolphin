import {
  CheckCircle2,
  LoaderCircle,
  Mic,
  Square,
  TriangleAlert,
} from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  fetchDictationStatus,
  transcribeDictation,
  type DictationStatus,
} from './api';
import {
  type DictationTarget,
  type PreparedDictationTarget,
  prepareNativeDictationTarget,
} from './dictationTarget';

type DictationPhase =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing'
  | 'inserted'
  | 'error';

interface DictationContextValue {
  activateTarget: (target: DictationTarget) => void;
  clearTarget: (targetId: string) => void;
}

interface DictationControlContextValue {
  controlDisabled: boolean;
  isRecording: boolean;
  liveTranscript: string;
  phase: DictationPhase;
  /** True when a text field or terminal is focused, so idle dictation has a
      destination worth naming. Without one the status line is a static
      instruction, and the band collapses. */
  hasTarget: boolean;
  /** True when the speech service is missing, erroring, or still warming up —
      the only idle condition worth spending a line of chrome on. */
  serviceDegraded: boolean;
  serviceText: string;
  shortcutHint: string;
  showLiveTranscript: boolean;
  startRecording: () => Promise<void>;
  statusText: string;
  stopRecording: () => void;
}

const DictationContext = createContext<DictationContextValue | null>(null);
const DictationControlContext =
  createContext<DictationControlContextValue | null>(null);
const MAX_RECORDING_MS = 60_000;
const LIVE_PREVIEW_CHUNK_MS = 900;
const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel']);
const nativeTargetIds = new WeakMap<Element, string>();
let nextNativeTargetId = 1;

function nativeTargetId(element: Element): string {
  const existing = nativeTargetIds.get(element);
  if (existing) return existing;
  const id = `native-dictation-${nextNativeTargetId}`;
  nextNativeTargetId += 1;
  nativeTargetIds.set(element, id);
  return id;
}

function isTextControl(
  target: EventTarget | null,
): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) {
    return !target.classList.contains('xterm-helper-textarea');
  }
  if (!(target instanceof HTMLInputElement)) return false;
  return TEXT_INPUT_TYPES.has(target.type.toLowerCase());
}

function textControlLabel(element: HTMLInputElement | HTMLTextAreaElement): string {
  return (
    element.getAttribute('aria-label') ||
    element.getAttribute('placeholder') ||
    element.labels?.[0]?.textContent?.trim() ||
    'text field'
  );
}

function preferredMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

function audioFilename(mimeType: string): string {
  if (mimeType.includes('ogg')) return 'dictation.ogg';
  if (mimeType.includes('mp4')) return 'dictation.m4a';
  if (mimeType.includes('mpeg')) return 'dictation.mp3';
  return 'dictation.webm';
}

function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone permission was denied. Allow it for this site and try again.';
    }
    if (error.name === 'NotFoundError') return 'No microphone was found.';
    if (error.name === 'NotReadableError') {
      return 'The microphone is busy in another application.';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function useDictation(): DictationContextValue {
  const value = useContext(DictationContext);
  if (!value) throw new Error('useDictation must be used inside DictationProvider.');
  return value;
}

export function DictationControl() {
  const value = useContext(DictationControlContext);
  if (!value) {
    throw new Error('DictationControl must be used inside DictationProvider.');
  }
  const {
    controlDisabled,
    hasTarget,
    isRecording,
    liveTranscript,
    phase,
    serviceDegraded,
    serviceText,
    shortcutHint,
    showLiveTranscript,
    startRecording,
    statusText,
    stopRecording,
  } = value;

  return (
    <div
      className={`dictation-control phase-${phase}${
        showLiveTranscript ? ' has-live-transcript' : ''
      }`}
      aria-label="Voice input"
      aria-live="polite"
      data-testid="dictation-control"
    >
      <button
        type="button"
        className="dictation-button"
        aria-label={isRecording ? 'Stop voice input' : 'Start voice input'}
        aria-pressed={isRecording}
        disabled={controlDisabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (isRecording) stopRecording();
          else void startRecording();
        }}
        title="Hold Ctrl/⌘ + Shift + Space to dictate. Escape cancels."
      >
        {phase === 'requesting' || phase === 'transcribing' ? (
          <LoaderCircle className="dictation-spinner" size={20} />
        ) : phase === 'recording' ? (
          <Square size={17} />
        ) : phase === 'inserted' ? (
          <CheckCircle2 size={20} />
        ) : phase === 'error' ? (
          <TriangleAlert size={20} />
        ) : (
          <Mic size={20} />
        )}
      </button>
      {/* At rest this block says only that nothing is happening, and it cost a
          51px band on every surface — above a cockpit whose terminal had 33
          rows. Drop it when idle, but never when the service is degraded: the
          meta line below is a real problem the operator must still see. */}
      {phase === 'idle' && !hasTarget && !showLiveTranscript && !serviceDegraded ? null : (
      <div className="dictation-copy">
        <strong>{statusText}</strong>
        {showLiveTranscript ? (
          <span
            className={`dictation-live-transcript${liveTranscript ? '' : ' pending'}`}
            data-testid="dictation-live-transcript"
          >
            {liveTranscript ||
              (phase === 'transcribing' ? 'Stabilizing the final words…' : 'Speak now…')}
          </span>
        ) : null}
        {/* The engine line ("large-v3 · cuda") is provenance, not status: at
            idle it spent a permanent second row on every page to report that
            nothing is happening, on the model that nobody needs to check.
            Keep it while dictation is actually running, and whenever it
            carries a real problem; otherwise the shortcut below takes the
            slot, because that is the thing the user can act on. */}
        {phase !== 'idle' || serviceDegraded ? (
          <span className="dictation-service-meta">{serviceText}</span>
        ) : null}
      </div>
      )}
      {phase === 'idle' && !serviceDegraded ? (
        <kbd className="dictation-shortcut" title={serviceText}>
          {shortcutHint}
        </kbd>
      ) : null}
    </div>
  );
}

export default function DictationProvider({ children }: { children: ReactNode }) {
  const [activeTarget, setActiveTarget] = useState<DictationTarget | null>(null);
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [serviceStatus, setServiceStatus] = useState<DictationStatus | null>(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const activeTargetRef = useRef<DictationTarget | null>(null);
  const phaseRef = useRef<DictationPhase>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const preparedTargetRef = useRef<PreparedDictationTarget | null>(null);
  const maxRecordingTimerRef = useRef<number | null>(null);
  const statusResetTimerRef = useRef<number | null>(null);
  const shortcutHeldRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const finalizingRef = useRef(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewInFlightRef = useRef(false);
  const previewQueuedRef = useRef(false);
  const recordingEpochRef = useRef(0);
  const mountedRef = useRef(true);

  const setCurrentPhase = useCallback((nextPhase: DictationPhase) => {
    phaseRef.current = nextPhase;
    if (mountedRef.current) setPhase(nextPhase);
  }, []);

  const clearStatusReset = useCallback(() => {
    if (statusResetTimerRef.current !== null) {
      window.clearTimeout(statusResetTimerRef.current);
      statusResetTimerRef.current = null;
    }
  }, []);

  const stopLivePreview = useCallback((clearTranscript: boolean) => {
    recordingEpochRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    previewInFlightRef.current = false;
    previewQueuedRef.current = false;
    if (clearTranscript && mountedRef.current) setLiveTranscript('');
  }, []);

  const releaseMicrophone = useCallback(() => {
    if (maxRecordingTimerRef.current !== null) {
      window.clearTimeout(maxRecordingTimerRef.current);
      maxRecordingTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const showError = useCallback(
    (message: string) => {
      clearStatusReset();
      setLiveTranscript('');
      setErrorMessage(message);
      setCurrentPhase('error');
    },
    [clearStatusReset, setCurrentPhase],
  );

  const activateTarget = useCallback((target: DictationTarget) => {
    activeTargetRef.current = target;
    setActiveTarget(target);
  }, []);

  const clearTarget = useCallback((targetId: string) => {
    if (activeTargetRef.current?.id !== targetId) return;
    activeTargetRef.current = null;
    setActiveTarget(null);
  }, []);

  useEffect(() => {
    function handleFocusIn(event: FocusEvent) {
      if (!isTextControl(event.target)) return;
      const element = event.target;
      const id = nativeTargetId(element);
      const label = textControlLabel(element);
      activateTarget({
        id,
        kind: 'native',
        label,
        prepare: () => prepareNativeDictationTarget(element, id, label),
      });
    }

    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, [activateTarget]);

  useEffect(() => {
    let cancelled = false;
    fetchDictationStatus()
      .then((status) => {
        if (!cancelled) setServiceStatus(status);
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setServiceStatus({
            available: false,
            ready: false,
            status: 'unavailable',
            detail: error.message,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestLivePreview = useCallback(async function runLivePreview() {
    if (
      phaseRef.current !== 'recording' ||
      stopRequestedRef.current ||
      cancelRequestedRef.current
    ) {
      return;
    }
    if (previewInFlightRef.current) {
      previewQueuedRef.current = true;
      return;
    }

    const recorder = recorderRef.current;
    const chunks = chunksRef.current.slice();
    if (!recorder || chunks.length === 0) return;
    const mimeType = recorder.mimeType || chunks[0]?.type || 'audio/webm';
    const audio = new Blob(chunks, { type: mimeType });
    if (audio.size < 100) return;

    const epoch = recordingEpochRef.current;
    const controller = new AbortController();
    previewInFlightRef.current = true;
    previewQueuedRef.current = false;
    previewAbortRef.current = controller;

    try {
      const result = await transcribeDictation(audio, audioFilename(mimeType), {
        preview: true,
        signal: controller.signal,
      });
      if (
        epoch === recordingEpochRef.current &&
        phaseRef.current === 'recording' &&
        !stopRequestedRef.current &&
        !cancelRequestedRef.current &&
        result.text.trim()
      ) {
        setLiveTranscript(result.text.trim());
      }
    } catch (error) {
      // Preview is best-effort. The complete recording still gets a final pass.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        console.warn('Live dictation preview failed:', error);
      }
    } finally {
      if (epoch !== recordingEpochRef.current) return;
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
      previewInFlightRef.current = false;
      if (
        previewQueuedRef.current &&
        phaseRef.current === 'recording' &&
        !stopRequestedRef.current &&
        !cancelRequestedRef.current
      ) {
        previewQueuedRef.current = false;
        void runLivePreview();
      }
    }
  }, []);

  const finalizeRecording = useCallback(
    async (recorder: MediaRecorder) => {
      if (finalizingRef.current) return;
      finalizingRef.current = true;
      stopLivePreview(false);
      const cancelled = cancelRequestedRef.current;
      const target = preparedTargetRef.current;
      const mimeType = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
      const audio = new Blob(chunksRef.current, { type: mimeType });
      releaseMicrophone();

      if (cancelled || !mountedRef.current) {
        preparedTargetRef.current = null;
        if (mountedRef.current) setLiveTranscript('');
        if (phaseRef.current !== 'error') setCurrentPhase('idle');
        return;
      }
      if (!target) {
        showError('The dictation target is no longer available.');
        return;
      }
      if (audio.size < 100) {
        showError('No microphone audio was captured.');
        return;
      }

      setCurrentPhase('transcribing');
      try {
        const result = await transcribeDictation(audio, audioFilename(mimeType));
        if (!result.text.trim()) {
          showError('No speech was detected.');
          return;
        }
        if (!target.insert(result.text)) {
          showError('The original text cursor is no longer available.');
          return;
        }
        setServiceStatus((current) => ({
          ...(current ?? {}),
          available: true,
          ready: true,
          status: 'ok',
          engine: result.engine,
          model: result.model,
          device: result.device,
        }));
        setLiveTranscript(result.text.trim());
        setCurrentPhase('inserted');
        clearStatusReset();
        statusResetTimerRef.current = window.setTimeout(() => {
          setLiveTranscript('');
          setCurrentPhase('idle');
          statusResetTimerRef.current = null;
        }, 1800);
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        preparedTargetRef.current = null;
      }
    },
    [
      clearStatusReset,
      releaseMicrophone,
      setCurrentPhase,
      showError,
      stopLivePreview,
    ],
  );

  const stopRecording = useCallback(() => {
    stopRequestedRef.current = true;
    stopLivePreview(false);
    if (phaseRef.current === 'requesting') {
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, [stopLivePreview]);

  const cancelRecording = useCallback(() => {
    if (phaseRef.current !== 'requesting' && phaseRef.current !== 'recording') return;
    cancelRequestedRef.current = true;
    stopRequestedRef.current = true;
    stopLivePreview(true);
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, [stopLivePreview]);

  const startRecording = useCallback(async () => {
    if (
      phaseRef.current === 'requesting' ||
      phaseRef.current === 'recording' ||
      phaseRef.current === 'transcribing'
    ) {
      return;
    }
    clearStatusReset();
    setErrorMessage('');
    stopLivePreview(true);

    const target = activeTargetRef.current;
    const preparedTarget = target?.prepare() ?? null;
    if (!preparedTarget) {
      showError('Focus a text field or the terminal first.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showError('Voice input is not supported in this browser or connection.');
      return;
    }

    preparedTargetRef.current = preparedTarget;
    chunksRef.current = [];
    stopRequestedRef.current = false;
    cancelRequestedRef.current = false;
    finalizingRef.current = false;
    setCurrentPhase('requesting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size <= 0) return;
        chunksRef.current.push(event.data);
        if (!stopRequestedRef.current && !cancelRequestedRef.current) {
          void requestLivePreview();
        }
      });
      recorder.addEventListener(
        'stop',
        () => {
          void finalizeRecording(recorder);
        },
        { once: true },
      );
      recorder.addEventListener(
        'error',
        () => {
          cancelRequestedRef.current = true;
          releaseMicrophone();
          showError('The browser could not record microphone audio.');
        },
        { once: true },
      );
      recorder.start(LIVE_PREVIEW_CHUNK_MS);
      setCurrentPhase('recording');
      maxRecordingTimerRef.current = window.setTimeout(stopRecording, MAX_RECORDING_MS);
      if (stopRequestedRef.current) stopRecording();
    } catch (error) {
      releaseMicrophone();
      preparedTargetRef.current = null;
      showError(microphoneErrorMessage(error));
    }
  }, [
    clearStatusReset,
    finalizeRecording,
    releaseMicrophone,
    requestLivePreview,
    setCurrentPhase,
    showError,
    stopLivePreview,
    stopRecording,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key === 'Escape' &&
        (phaseRef.current === 'requesting' || phaseRef.current === 'recording')
      ) {
        event.preventDefault();
        event.stopPropagation();
        cancelRecording();
        return;
      }
      const isShortcut =
        event.code === 'Space' && event.shiftKey && (event.ctrlKey || event.metaKey);
      if (!isShortcut || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutHeldRef.current = true;
      void startRecording();
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code !== 'Space' || !shortcutHeldRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      shortcutHeldRef.current = false;
      stopRecording();
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
    };
  }, [cancelRecording, startRecording, stopRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRequestedRef.current = true;
      stopLivePreview(false);
      clearStatusReset();
      if (maxRecordingTimerRef.current !== null) {
        window.clearTimeout(maxRecordingTimerRef.current);
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [clearStatusReset, stopLivePreview]);

  const contextValue = useMemo(
    () => ({ activateTarget, clearTarget }),
    [activateTarget, clearTarget],
  );

  const isRecording = phase === 'recording' || phase === 'requesting';
  const controlDisabled = phase === 'transcribing' || (!activeTarget && phase === 'idle');
  const showLiveTranscript =
    Boolean(liveTranscript) || phase === 'recording' || phase === 'transcribing';
  const statusText = (() => {
    if (phase === 'requesting') return 'Opening microphone…';
    if (phase === 'recording') return `Listening to ${preparedTargetRef.current?.label ?? 'cursor'}…`;
    if (phase === 'transcribing') return 'Transcribing locally…';
    if (phase === 'inserted') return 'Voice text inserted';
    if (phase === 'error') return errorMessage;
    if (activeTarget) return `Voice → ${activeTarget.label}`;
    return 'Focus a text field or terminal';
  })();
  const serviceText = serviceStatus?.last_error
    ? `Speech model error: ${serviceStatus.last_error}`
    : serviceStatus?.available
    ? serviceStatus.ready
      ? `${serviceStatus.model ?? 'local ASR'}${serviceStatus.device ? ` · ${serviceStatus.device}` : ''}`
      : 'Local speech model is warming up'
    : serviceStatus?.detail || 'Local speech service is starting';
  // Anything other than "available and ready" is worth a line of chrome at
  // idle; a healthy model reporting its own name is not.
  const serviceDegraded = Boolean(
    serviceStatus?.last_error || !serviceStatus?.available || !serviceStatus.ready,
  );
  const shortcutHint = navigator.platform.toLowerCase().includes('mac')
    ? '⌘⇧Space'
    : 'Ctrl+Shift+Space';
  const controlContextValue = useMemo<DictationControlContextValue>(
    () => ({
      controlDisabled,
      hasTarget: activeTarget !== null,
      isRecording,
      liveTranscript,
      phase,
      serviceDegraded,
      serviceText,
      shortcutHint,
      showLiveTranscript,
      startRecording,
      statusText,
      stopRecording,
    }),
    [
      activeTarget,
      controlDisabled,
      isRecording,
      liveTranscript,
      phase,
      serviceDegraded,
      serviceText,
      shortcutHint,
      showLiveTranscript,
      startRecording,
      statusText,
      stopRecording,
    ],
  );

  return (
    <DictationContext.Provider value={contextValue}>
      <DictationControlContext.Provider value={controlContextValue}>
        {children}
      </DictationControlContext.Provider>
    </DictationContext.Provider>
  );
}
