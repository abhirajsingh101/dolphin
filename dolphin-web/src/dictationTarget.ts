export type DictationTargetKind = 'native' | 'terminal';

export interface PreparedDictationTarget {
  id: string;
  kind: DictationTargetKind;
  label: string;
  insert: (transcript: string) => boolean;
}

export interface DictationTarget {
  id: string;
  kind: DictationTargetKind;
  label: string;
  prepare: () => PreparedDictationTarget | null;
}

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function sanitizeNativeTranscript(text: string): string {
  return text
    .replace(UNSAFE_CONTROL_CHARACTERS, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

export function sanitizeTerminalTranscript(text: string): string {
  return text
    .replace(UNSAFE_CONTROL_CHARACTERS, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function formatTranscriptForInsertion(
  value: string,
  start: number,
  end: number,
  transcript: string,
): string {
  let insertion = sanitizeNativeTranscript(transcript);
  if (!insertion) return '';

  const before = start > 0 ? value[start - 1] : '';
  const after = end < value.length ? value[end] : '';
  const first = insertion[0] ?? '';
  const last = insertion[insertion.length - 1] ?? '';

  const needsLeadingSpace =
    !!before &&
    !/\s/.test(before) &&
    !/[([{\/'"“‘-]/u.test(before) &&
    !/[,.;:!?)}\]\/'"”’]/u.test(first);
  const needsTrailingSpace =
    !!after &&
    !/\s/.test(after) &&
    !/[([{\/'"“‘]/u.test(after) &&
    !/[([{\/'"“‘-]/u.test(last);

  if (needsLeadingSpace) insertion = ` ${insertion}`;
  if (needsTrailingSpace) insertion = `${insertion} `;
  return insertion;
}

function dispatchNativeInput(element: HTMLInputElement | HTMLTextAreaElement, data: string) {
  const event =
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          data,
          inputType: 'insertText',
        })
      : new Event('input', { bubbles: true });
  element.dispatchEvent(event);
}

export function prepareNativeDictationTarget(
  element: HTMLInputElement | HTMLTextAreaElement,
  id: string,
  label: string,
): PreparedDictationTarget | null {
  if (!element.isConnected || element.disabled || element.readOnly) return null;

  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? start;

  return {
    id,
    kind: 'native',
    label,
    insert(transcript: string) {
      if (!element.isConnected || element.disabled || element.readOnly) return false;
      const boundedStart = Math.min(start, element.value.length);
      const boundedEnd = Math.min(Math.max(end, boundedStart), element.value.length);
      const insertion = formatTranscriptForInsertion(
        element.value,
        boundedStart,
        boundedEnd,
        transcript,
      );
      if (!insertion) return false;

      element.focus({ preventScroll: true });
      element.setSelectionRange(boundedStart, boundedEnd);
      element.setRangeText(insertion, boundedStart, boundedEnd, 'end');
      dispatchNativeInput(element, insertion);
      const cursor = boundedStart + insertion.length;
      window.requestAnimationFrame(() => {
        if (!element.isConnected) return;
        element.focus({ preventScroll: true });
        element.setSelectionRange(cursor, cursor);
      });
      return true;
    },
  };
}
