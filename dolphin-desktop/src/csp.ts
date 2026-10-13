/* The Content Security Policy for every page served from app://. The renderer
 * holds every machine's token, so nothing but the app's own scripts may run:
 * external scripts from the app's origin, and the static pages' inline
 * scripts by their exact hash. Helpers are reached on loopback only. No
 * Electron here (test/csp.test.mjs). */

import { createHash } from 'node:crypto';

const LOOPBACK = 'http://127.0.0.1:*';

/** 'sha256-…' for each inline <script> (same match as test/static.test.mjs). */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([, body]) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

export function contentSecurityPolicy(html: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    ["script-src 'self'", ...inlineScriptHashes(html)].join(' '),
    // Inline styles: React sets style attributes and the libraries inject
    // <style> tags at run time, neither of which a hash or nonce can cover.
    // Styles cannot run script, so this stays inline while script-src does not.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${LOOPBACK}`,
    `media-src 'self' blob: ${LOOPBACK}`,
    "font-src 'self' data:",
    `connect-src 'self' ${LOOPBACK} ws://127.0.0.1:*`,
    // Frames: a page may embed a dev server that a helper forwards, and those
    // are always on loopback ports; nothing else may be framed.
    `frame-src 'self' ${LOOPBACK}`,
    "worker-src 'self' blob:",
  ].join('; ');
}
