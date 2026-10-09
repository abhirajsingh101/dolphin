/* S.M.A.R.T. device status -> visual tone.

   The chip used to build its class straight from the backend string
   (`smart-${device.status}`), which silently assumed the producer's
   vocabulary matched the stylesheet's. It never did: the backend emits
   "detected" and "unavailable" (system_health_service.py::_smart_status),
   while the only rules that existed were .smart-passed/.smart-ok/
   .smart-failed/.smart-critical. Every chip therefore rendered untoned, and
   nothing failed — a class that matches no rule is not an error.

   Mapping through a closed set of tones fixes that and, more importantly,
   makes the next vocabulary change loud instead of silent: an unrecognised
   status lands on 'unknown' and is styled as such, rather than vanishing. */

export type SmartTone = 'ok' | 'warn' | 'danger' | 'unknown';

const SMART_TONES: Record<string, SmartTone> = {
  // Emitted by the backend today.
  detected: 'ok',
  unavailable: 'warn',
  // smartctl's own health vocabulary, in case the backend starts forwarding
  // it rather than only reporting whether the device could be opened.
  passed: 'ok',
  ok: 'ok',
  failed: 'danger',
  critical: 'danger',
  unknown: 'unknown',
};

export function smartTone(status: string | null | undefined): SmartTone {
  if (!status) return 'unknown';
  return SMART_TONES[status.trim().toLowerCase()] ?? 'unknown';
}

/** Every tone the mapper can return — the set the stylesheet must cover. */
export const SMART_TONE_VALUES: readonly SmartTone[] = [
  'ok',
  'warn',
  'danger',
  'unknown',
];
