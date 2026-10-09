/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SMART_TONE_VALUES, smartTone } from './smartStatus';

describe('smartTone', () => {
  // These two are the only values the backend actually produces —
  // system_health_service.py::_smart_status sets "unavailable" when the
  // device reports an open_error and "detected" otherwise.
  it('maps the statuses the backend emits today', () => {
    expect(smartTone('detected')).toBe('ok');
    expect(smartTone('unavailable')).toBe('warn');
  });

  it('maps smartctl health vocabulary', () => {
    expect(smartTone('passed')).toBe('ok');
    expect(smartTone('failed')).toBe('danger');
    expect(smartTone('critical')).toBe('danger');
  });

  it('is case and whitespace insensitive', () => {
    expect(smartTone('  DETECTED ')).toBe('ok');
    expect(smartTone('Failed')).toBe('danger');
  });

  it('falls back to unknown rather than emitting an unstyled class', () => {
    expect(smartTone('something-new')).toBe('unknown');
    expect(smartTone('')).toBe('unknown');
    expect(smartTone(null)).toBe('unknown');
    expect(smartTone(undefined)).toBe('unknown');
  });
});

describe('smart chip styling contract', () => {
  const rawStyles = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');
  // Comments are stripped so the dead-selector check below reads declarations
  // only. Without this it matches the comment that explains why those
  // selectors were removed, and fails on its own documentation.
  const styles = rawStyles.replace(/\/\*[\s\S]*?\*\//g, '');

  it('styles.css was actually read', () => {
    expect(rawStyles.length).toBeGreaterThan(500);
    expect(styles.length).toBeGreaterThan(500);
  });

  // The original bug was a class name with no matching rule, which is invisible
  // to every other check in this suite. Assert the stylesheet covers the whole
  // closed set the mapper can produce.
  it.each(SMART_TONE_VALUES)('declares a rule for the %s tone', (tone) => {
    expect(styles).toContain(`.smart-status.is-${tone}`);
  });

  // The dead vocabulary the chip used to target. Its presence would mean the
  // old status-string-as-class-name coupling had come back.
  it('no longer carries rules keyed to raw backend status strings', () => {
    for (const dead of ['.smart-passed', '.smart-ok', '.smart-failed', '.smart-critical']) {
      expect(styles).not.toContain(dead);
    }
  });
});
