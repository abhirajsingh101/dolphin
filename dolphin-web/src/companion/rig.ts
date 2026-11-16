/* The companion rig: one character's parts, springs and acting. The body
   squashes and stretches on its own springs, falls with gravity and lands with
   a bounce; accessories follow through on slower springs; the eyes blink at
   uneven intervals, glance around and follow the pointer; each mood is acted
   rather than swapped in. Every character shares one clock (`tick`), which
   stops when none is mounted or the page is hidden.

   Idle life is the one looping motion outside status (design-contract.md,
   "Project companions"): it rests while a terminal has focus, and reduced
   motion turns every loop and bounce off while the face still shows the mood. */
import type { CastMember } from './cast';

export type Mood = 'idle' | 'working' | 'done' | 'alert' | 'thinking' | 'talk' | 'sleep';
type FaceKey = Mood | 'held' | 'hover';

class Spring {
  v = 0;
  t: number;
  constructor(public x: number, public k = 200, public d = 18) { this.t = x; }
  step(dt: number) { const a = this.k * (this.t - this.x) - this.d * this.v; this.v += a * dt; this.x += this.v * dt; }
  snap(x: number) { this.x = this.t = x; this.v = 0; }
}

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// Face targets per mood: upper lid, lower (happy) lid, eye scale, brow y and tilt per side, mouth width, curve and opening, cheeks.
const FACE: Record<FaceKey, { lid: number | null; low: number; eye: number; by: [number, number]; bt: [number, number]; mw: number; mc: number; mo: number; ck: number }> = {
  idle:     { lid: null, low: 0,   eye: 1,    by: [0, 0],       bt: [0, 0],   mw: 5,   mc: 2.6, mo: 0,   ck: .45 },
  working:  { lid: .34,  low: 0,   eye: .97,  by: [1.6, 1.6],   bt: [7, 7],   mw: 3.6, mc: .4,  mo: 0,   ck: .3 },
  done:     { lid: 0,    low: .56, eye: 1,    by: [-2.6, -2.6], bt: [-4, -4], mw: 7.6, mc: 5,   mo: 3.4, ck: .95 },
  alert:    { lid: 0,    low: 0,   eye: 1.16, by: [-4, -4],     bt: [-9, -9], mw: 3,   mc: 1,   mo: 3.4, ck: .35 },
  thinking: { lid: .16,  low: .08, eye: 1,    by: [-3.8, .6],   bt: [-7, 5],  mw: 3.4, mc: -.6, mo: 0,   ck: .35 },
  talk:     { lid: .05,  low: .1,  eye: 1.02, by: [-1.6, -1.6], bt: [-2, -2], mw: 5,   mc: 3,   mo: 2.4, ck: .6 },
  sleep:    { lid: 1,    low: 0,   eye: 1,    by: [1.2, 1.2],   bt: [-3, -3], mw: 2.6, mc: 1,   mo: 1.5, ck: .55 },
  held:     { lid: 0,    low: 0,   eye: 1.18, by: [-4.6, -4.6], bt: [-9, -9], mw: 3,   mc: 1.2, mo: 4,   ck: .75 },
  hover:    { lid: 0,    low: .06, eye: 1.07, by: [-2, -2],     bt: [-3, -3], mw: 5.4, mc: 3.6, mo: .4,  ck: .6 },
};
const BULB: Record<FaceKey, string> = { idle: '#7ef0c9', working: '#ffc04d', done: '#7ef08a', alert: '#ff6b6b', thinking: '#9fb4ff', talk: '#7ef0c9', sleep: '#5b6f8f', held: '#7ef0c9', hover: '#7ef0c9' };

let uid = 0;
const pointer = { x: -1e4, y: -1e4, at: 0 };
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Typing in a terminal: the characters keep still. */
const typing = () => !!(document.activeElement as HTMLElement | null)?.classList?.contains('xterm-helper-textarea');

export function svgFor(def: CastMember, id: string, viewBox: string): string {
  const c = def.c, er = def.er, ry = er * 1.18, ids = (s?: string) => (s || '').replace(/ID-/g, `${id}-`);
  const eyeColor = def.eye || '#1c1a2b', lidFill = def.lid || `url(#${id}-b)`;
  const eye = (s: number) => `<g class="eye" transform="translate(${s * def.ex} 0)"><g class="eye-in">
      <clipPath id="${id}-e${s > 0 ? 1 : 0}"><ellipse rx="${er + 1.1}" ry="${ry + 1.1}"/></clipPath>
      <g class="ball"><ellipse rx="${er}" ry="${ry}" fill="${eyeColor}"/>
        ${def.robot ? `<ellipse rx="${er + 2.5}" ry="${ry + 2.5}" fill="${eyeColor}" opacity=".18" filter="url(#${id}-soft)"/>` : ''}
        <g class="catch"><circle cx="${-er * .34}" cy="${-ry * .4}" r="${er * .36}" fill="#fff"/><circle cx="${er * .32}" cy="${ry * .34}" r="${er * .15}" fill="#fff" opacity=".85"/></g></g>
      <g clip-path="url(#${id}-e${s > 0 ? 1 : 0})"><path class="lid" fill="${lidFill}"/><path class="lash" fill="none" stroke="${def.robot ? eyeColor : c.brow}" stroke-width="1.3" stroke-linecap="round"/><path class="low" fill="${lidFill}"/></g>
    </g></g>`;
  const brow = `<path class="brow" d="M${-er * .7} 0Q0 -2.2 ${er * .7} 0" fill="none" stroke="${c.brow}" stroke-width="2.4" stroke-linecap="round" opacity="${def.brows ?? .9}"/>`;
  const cheek = (x: number) => `<ellipse cx="${x}" cy="${er * 1.35}" rx="5.2" ry="3.2" fill="${c.cheek}" filter="url(#${id}-soft)"/>`;
  return `<svg class="dt-companion-svg" viewBox="${viewBox}" aria-hidden="true" focusable="false"><defs>
    <radialGradient id="${id}-b" gradientUnits="userSpaceOnUse" cx="44" cy="44" r="78"><stop offset="0" stop-color="${c.hi}"/><stop offset=".5" stop-color="${c.base}"/><stop offset="1" stop-color="${c.dark}"/></radialGradient>
    <linearGradient id="${id}-ao" gradientUnits="userSpaceOnUse" x1="0" y1="84" x2="0" y2="108"><stop offset="0" stop-color="${c.dark}" stop-opacity="0"/><stop offset="1" stop-color="${c.dark}" stop-opacity=".55"/></linearGradient>
    <linearGradient id="${id}-rim" gradientUnits="userSpaceOnUse" x1="30" y1="30" x2="100" y2="100"><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".6"/></linearGradient>
    <clipPath id="${id}-clip">${def.shape}</clipPath>
    <filter id="${id}-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.4"/></filter>
    <filter id="${id}-soft" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <ellipse class="shadow" cx="60" cy="106" rx="27" ry="4.2" fill="#0a1222" opacity=".28" filter="url(#${id}-blur)"/>
  <g class="jump"><g class="squash">
    <g class="behind">${ids(def.behind?.())}</g>
    <g fill="url(#${id}-b)">${def.shape}</g>
    <g clip-path="url(#${id}-clip)">
      ${ids(def.inner?.())}
      <rect x="-10" y="-10" width="140" height="130" fill="url(#${id}-ao)"/>
      <g class="spec"><ellipse cx="45" cy="${def.face[1] - 24}" rx="13" ry="7" transform="rotate(-28 45 ${def.face[1] - 24})" fill="#fff" opacity=".5" filter="url(#${id}-blur)"/></g>
      <g fill="none" stroke="url(#${id}-rim)" stroke-width="5">${def.shape}</g>
    </g>
    <g class="face">
      ${ids(def.faceBack?.())}
      <g class="eyes">${eye(-1)}${eye(1)}</g>
      <g class="cheeks">${cheek(-def.ex - er * .55)}${cheek(def.ex + er * .55)}</g>
      ${def.brows === 0 ? '' : `<g class="brows">${brow}${brow}</g>`}
      ${def.mouthOff ? '' : `<g transform="translate(0 ${def.my})"><path class="mouth" fill="${def.mouth || '#4a2230'}"/><ellipse class="tongue" fill="#ff7d8e"/></g>`}
      ${ids(def.faceFront?.())}
    </g>
    <g class="acc">${ids(def.acc?.())}</g>
  </g></g>
  <g class="fx">
    <g class="sparkles">${[0, 1, 2, 3, 4].map(() => '<path d="M0 -5L1.3 -1.3L5 0L1.3 1.3L0 5L-1.3 1.3L-5 0L-1.3 -1.3Z" fill="#ffd95e"/>').join('')}</g>
    <g class="badge"><circle r="7.5" fill="#ff5a5f"/><circle r="7.5" fill="none" stroke="#fff" stroke-width="1.6"/><path d="M0 -3.8V0.8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cy="3.6" r="1.25" fill="#fff"/></g>
    <g class="zz"><text font-weight="800" font-size="11" fill="#8fa2e0">z</text><text font-weight="800" font-size="8" fill="#8fa2e0">z</text></g>
    <g class="dots"><circle r="2.2" fill="#8fa2e0"/><circle r="2.2" fill="#8fa2e0"/><circle r="2.2" fill="#8fa2e0"/></g>
  </g></svg>`;
}

type One = 'jump' | 'squash' | 'shadow' | 'face' | 'spec' | 'cheeks' | 'mouth' | 'tongue' | 'beak' | 'pivot' | 'flame' | 'spark' | 'cap' | 'bulb' | 'bulbGlow' | 'badge';
type Many = 'eyes' | 'balls' | 'catches' | 'lids' | 'lashes' | 'lows' | 'brows' | 'ears' | 'wings' | 'tufts' | 'bubs' | 'sparkles' | 'zz' | 'dots';
type Parts = Record<One, Element | null> & Record<Many, Element[]>;

export class Critter {
  readonly def: CastMember;
  private host: HTMLElement;
  private e: Parts;
  private s: Record<string, Spring>;
  private t = Math.random() * 10;
  private jumpY = 0;
  private jumpV = 0;
  private moodAt = 0;
  private nextBlink = 1 + Math.random() * 3;
  private blinkUntil = 0;
  private squeezeUntil = 0;
  private nextGlance = 1;
  private glanceAt: [number, number] = [0, 0];
  private nextTwitch = 3 + Math.random() * 5;
  private nextNudge = 0;
  private sparkAt = -9;
  private rect: DOMRect | null = null;
  private rectAt = 0;
  private hover = false;
  mood: Mood = 'idle';
  /** Picked up and carried; vx and vy are how fast, in px/s. */
  held = false;
  vx = 0;
  vy = 0;

  constructor(host: HTMLElement, def: CastMember, viewBox: string) {
    this.host = host; this.def = def;
    const id = `dtc${uid++}`;
    host.innerHTML = svgFor(def, id, viewBox);
    const q = (s: string) => host.querySelector(s), qa = (s: string) => [...host.querySelectorAll(s)];
    this.e = {
      jump: q('.jump'), squash: q('.squash'), shadow: q('.shadow'), face: q('.face'), spec: q('.spec'),
      cheeks: q('.cheeks'), mouth: q('.mouth'), tongue: q('.tongue'), beak: q('.beak'), pivot: q('.pivot'),
      flame: q('.flame'), spark: q('.spark'), cap: q('.cap'), bulb: q('.bulb'), bulbGlow: q('.bulb-glow'), badge: q('.badge'),
      eyes: qa('.eye-in'), balls: qa('.ball'), catches: qa('.catch'), lids: qa('.lid'), lashes: qa('.lash'), lows: qa('.low'),
      brows: qa('.brow'), ears: qa('.ear'), wings: qa('.wing'), tufts: qa('.tuft'), bubs: qa('.bub'),
      sparkles: qa('.sparkles path'), zz: qa('.zz text'), dots: qa('.dots circle'),
    };
    const S = (x: number, k: number, d: number) => new Spring(x, k, d);
    this.s = { sx: S(1, 260, 13), sy: S(1, 260, 13), tilt: S(0, 120, 12), lift: S(0, 160, 16),
      lx: S(0, 150, 17), ly: S(0, 150, 17), lid: S(def.rest, 520, 32), low: S(0, 260, 22), eye: S(1, 320, 15),
      by0: S(0, 220, 18), by1: S(0, 220, 18), bt0: S(0, 220, 18), bt1: S(0, 220, 18),
      mw: S(5, 260, 20), mc: S(2.6, 260, 20), mo: S(0, 300, 20), ck: S(.45, 120, 16),
      acc: S(0, 70, 5), ear0: S(0, 260, 12), ear1: S(0, 260, 12), wing: S(0, 200, 10), badge: S(0, 320, 13) };
    host.addEventListener('pointerenter', this.enter);
    host.addEventListener('pointerleave', this.leave);
  }
  private enter = () => { this.hover = true; };
  private leave = () => { this.hover = false; };
  destroy() { this.host.removeEventListener('pointerenter', this.enter); this.host.removeEventListener('pointerleave', this.leave); this.host.innerHTML = ''; }

  setMood(m: Mood) {
    if (m === this.mood) return;
    const prev = this.mood;
    this.mood = m; this.moodAt = this.t;
    if (m === 'done') { this.hop(230); this.sparkAt = this.t + .09; }
    if (m === 'alert') { this.hop(140); this.nextNudge = this.t + 2.6; }
    if (prev === 'sleep') { this.s.lid.snap(.6); this.s.sy.v = 3; }
  }
  hop(power: number) {
    if (reduced()) return;
    this.s.sy.x = .84; this.s.sx.x = 1.13;
    window.setTimeout(() => { if (!this.held) { this.jumpV = power; this.s.sy.v = 3.5; this.s.sx.v = -2.5; } }, 95);
  }
  /** A press: a squash, a little hop and a happy squint. */
  boop() { this.hop(150); this.squeezeUntil = this.t + .5; this.s.ck.x = 1; }
  /** The squash of being picked up. */
  press() { if (!reduced()) { this.s.sy.x = .9; this.s.sx.x = 1.07; } }
  private land(speed: number) {
    if (reduced()) return;
    const k = Math.min(.2, speed / 1300);
    this.s.sy.x = 1 - k; this.s.sx.x = 1 + k * .8; this.s.acc.v += speed * .12;
    if (speed > 160) this.squeezeUntil = this.t + .22;
  }
  private look(): [number, number] {
    const now = performance.now();
    if (!this.rect || now - this.rectAt > 250) { this.rect = this.host.getBoundingClientRect(); this.rectAt = now; }
    const r = this.rect, cx = r.left + r.width / 2, cy = r.top + r.height * .58;
    const dx = pointer.x - cx, dy = pointer.y - cy;
    if (now - pointer.at < 4000 && Math.hypot(dx, dy) < Math.max(420, r.width * 3)) return [clamp(dx / 160, -1, 1), clamp(dy / 160, -1, 1)];
    if (this.t > this.nextGlance) {
      this.nextGlance = this.t + 1.4 + Math.random() * 2.8;
      this.glanceAt = Math.random() < .35 ? [0, 0] : [(Math.random() * 2 - 1) * .8, (Math.random() * 2 - 1) * .45];
    }
    return this.glanceAt;
  }

  update(dt: number, rm: boolean, still: boolean) {
    this.t += dt;
    const t = this.t, s = this.s, def = this.def, calm = rm || still;
    const key: FaceKey = this.held ? 'held' : this.hover && this.mood === 'idle' ? 'hover' : this.mood;
    const f = FACE[key];
    let sy = 1, sx = 1, tilt = 0;
    if (!calm) {
      if (this.mood === 'sleep') { const b = Math.sin(TAU * t / 5); sy = .965 + .02 * b; sx = 1.03 - .012 * b; }
      else if (this.mood === 'working') { const b = Math.sin(TAU * t * 1.6); sy = 1 + .02 * b * b; sx = 1 - .012 * b * b; tilt = 2 * Math.sin(TAU * t * .4); }
      else if (this.mood === 'done') { tilt = 4 * Math.sin(TAU * (t - this.moodAt) * .7) * Math.min(1, (t - this.moodAt) / .6); sy = 1 + .012 * Math.sin(TAU * t / 2.4); }
      else if (this.mood === 'alert') {
        sy = 1.035; sx = .98; tilt = 2.5 * Math.sin(TAU * t * 2.2) * Math.max(0, 1 - ((t - this.nextNudge + 2.6) % 2.6) / .7);
        if (t > this.nextNudge) { this.nextNudge = t + 2.6; this.hop(95); s.badge.x = .7; }
      }
      else if (this.mood === 'thinking') { tilt = -5 + 1.5 * Math.sin(TAU * t / 3); sy = 1 + .01 * Math.sin(TAU * t / 3.2); }
      else if (this.mood === 'talk') { const m = Math.abs(Math.sin(TAU * t * 2.3)); sy = 1 + .02 * m; sx = 1 - .012 * m; tilt = 2 * Math.sin(TAU * t * .9); }
      else { const b = Math.sin(TAU * t / 3.4); sy = 1 + .014 * b; sx = 1 - .01 * b; }
    } else if (this.mood === 'sleep') { sy = .965; sx = 1.03; }
    if (this.held && !rm) { const v = Math.hypot(this.vx, this.vy); sy = 1 + Math.min(.13, v * .00016); sx = 1 / sy; tilt = clamp(this.vx * .022, -18, 18); }
    s.sy.t = sy; s.sx.t = sx; s.tilt.t = tilt;
    // Gravity when free; a spring lift while carried.
    if (this.held || rm) { s.lift.t = this.held && !rm ? 12 : 0; s.lift.step(dt); this.jumpY = s.lift.x; this.jumpV = s.lift.v; }
    else {
      this.jumpV -= 1500 * dt; this.jumpY += this.jumpV * dt;
      if (this.jumpY <= 0) { const v = -this.jumpV; this.jumpY = 0; if (v > 80) { this.land(v); this.jumpV = v * .22; } else this.jumpV = 0; }
      s.lift.snap(this.jumpY);
    }
    let [lx, ly]: [number, number] = this.held ? [clamp(this.vx * .01, -1, 1), clamp(this.vy * .01, -1, 1)]
      : this.mood === 'working' ? [calm ? 0 : .5 * Math.sin(TAU * t * .55), .45]
      : this.mood === 'thinking' ? [.55, -.8] : this.mood === 'sleep' ? [0, .2] : this.look();
    if (calm && !this.held && this.mood === 'idle') [lx, ly] = [0, 0];
    s.lx.t = lx; s.ly.t = ly;
    let lid = f.lid ?? def.rest, low = f.low;
    if (!calm && this.mood !== 'sleep') {
      if (t > this.nextBlink) { this.blinkUntil = t + .085; this.nextBlink = t + (Math.random() < .14 ? .22 : 2.2 + Math.random() * 4); }
      if (t < this.blinkUntil) lid = 1;
    }
    if (t < this.squeezeUntil) { lid = .55; low = .55; }
    s.lid.t = lid; s.low.t = low; s.eye.t = f.eye;
    s.by0.t = f.by[0]; s.by1.t = f.by[1]; s.bt0.t = f.bt[0]; s.bt1.t = f.bt[1];
    s.mw.t = f.mw; s.mc.t = f.mc;
    s.mo.t = this.mood === 'talk' && !calm ? 1 + 3.2 * Math.abs(Math.sin(TAU * t * 2.3)) * (Math.sin(TAU * t * .45) > -.55 ? 1 : 0) : f.mo;
    s.ck.t = f.ck; s.badge.t = this.mood === 'alert' ? 1 : 0;
    s.acc.t = -s.tilt.x * .9 - this.jumpV * .045 + (calm ? 0 : 3 * Math.sin(TAU * t / 2.7));
    s.wing.t = (this.held || this.mood === 'done') && !calm ? 1 : this.mood === 'alert' ? .35 : 0;
    if (!calm && t > this.nextTwitch) { this.nextTwitch = t + 3 + Math.random() * 6; (Math.random() < .5 ? s.ear0 : s.ear1).v += 260; }
    const h = dt / 2;
    for (let i = 0; i < 2; i++) for (const k in s) if (k !== 'lift') s[k].step(h);
    if (rm) for (const k in s) if (k !== 'lift') s[k].snap(s[k].t);
    this.render(t, calm);
  }

  private render(t: number, calm: boolean) {
    const s = this.s, e = this.e, def = this.def, [fx, fy] = def.face;
    const at = (el: Element | null, name: string, value: string | number) => el?.setAttribute(name, String(value));
    at(e.jump, 'transform', `translate(0 ${(-this.jumpY).toFixed(2)})`);
    at(e.squash, 'transform', `translate(60 104) rotate(${s.tilt.x.toFixed(2)}) scale(${s.sx.x.toFixed(4)} ${s.sy.x.toFixed(4)}) translate(-60 -104)`);
    const air = Math.min(1, this.jumpY / 60);
    at(e.shadow, 'rx', (27 * (1 - air * .45) * s.sx.x).toFixed(2));
    at(e.shadow, 'opacity', (.28 * (1 - air * .6)).toFixed(3));
    const lx = s.lx.x, ly = s.ly.x;
    at(e.face, 'transform', `translate(${(fx + lx * 2.4).toFixed(2)} ${(fy + ly * 1.7).toFixed(2)})`);
    at(e.spec, 'transform', `translate(${(-lx * 1.6).toFixed(2)} ${(-ly * 1.1).toFixed(2)})`);
    const er = def.er, ry = er * 1.18, top = -ry - 1.1, H = 2 * (ry + 1.1), bot = ry + 1.1;
    const lid = clamp(s.lid.x, 0, 1.05), low = clamp(s.low.x, 0, .8);
    const yb = top + lid * H, cv = er * .55 * (1 - lid * .6);
    const lidD = `M${-er - 2} ${top - 2}H${er + 2}V${yb.toFixed(2)}Q0 ${(yb + cv).toFixed(2)} ${-er - 2} ${yb.toFixed(2)}Z`;
    const lashD = `M${-er - 1} ${yb.toFixed(2)}Q0 ${(yb + cv).toFixed(2)} ${er + 1} ${yb.toFixed(2)}`;
    const yt = bot - low * H * .9, lowD = `M${-er - 2} ${bot + 2}V${yt.toFixed(2)}Q0 ${(yt - er * 1.1 * low).toFixed(2)} ${er + 2} ${yt.toFixed(2)}V${bot + 2}Z`;
    for (let i = 0; i < e.eyes.length; i++) {
      at(e.eyes[i], 'transform', `scale(${s.eye.x.toFixed(3)})`);
      at(e.balls[i], 'transform', `translate(${(lx * 1.5).toFixed(2)} ${(ly * 1.3).toFixed(2)})`);
      at(e.catches[i], 'transform', `translate(${(-lx * .6).toFixed(2)} ${(-ly * .5).toFixed(2)})`);
      at(e.lids[i], 'd', lidD); at(e.lashes[i], 'd', lashD); at(e.lows[i], 'd', lowD);
      at(e.lashes[i], 'opacity', Math.min(1, lid * 5).toFixed(2));
    }
    e.brows.forEach((b, i) => {
      const side = i ? 1 : -1, by = i ? s.by1.x : s.by0.x, bt = i ? s.bt1.x : s.bt0.x;
      at(b, 'transform', `translate(${(side * def.ex + side * .6).toFixed(2)} ${(-ry - 5.2 + by).toFixed(2)}) rotate(${(-side * bt).toFixed(2)})`);
    });
    if (e.mouth) {
      const w = s.mw.x, c = s.mc.x, o = Math.max(0, s.mo.x), yL = c + 3 + o * 2;
      at(e.mouth, 'd', `M${(-w).toFixed(2)} 0Q0 ${c.toFixed(2)} ${w.toFixed(2)} 0Q0 ${yL.toFixed(2)} ${(-w).toFixed(2)} 0Z`);
      at(e.tongue, 'cx', 0); at(e.tongue, 'cy', (yL / 2 - o * .45).toFixed(2));
      at(e.tongue, 'rx', (w * .42).toFixed(2)); at(e.tongue, 'ry', Math.max(0, o * .42).toFixed(2));
      at(e.tongue, 'opacity', o > 1.4 && !def.robot ? 1 : 0);
    }
    at(e.beak, 'd', `M-4 10L4 10L0 ${(15.5 + Math.max(0, s.mo.x) * .5).toFixed(2)}Z`);
    at(e.cheeks, 'opacity', clamp(s.ck.x, 0, 1).toFixed(2));
    const turn = (el: Element | null, a: number) => { const d = (el as HTMLElement | null)?.dataset; if (d) at(el, 'transform', `rotate(${a.toFixed(2)} ${d.px} ${d.py})`); };
    turn(e.pivot, s.acc.x);
    e.tufts.forEach((el, i) => turn(el, s.acc.x * (i ? 1 : 1.2) + (i ? 4 : -4) * s.badge.x));
    e.ears.forEach((el, i) => turn(el, (i ? 1 : -1) * ((i ? s.ear1.x : s.ear0.x) * .05) + s.acc.x * .5 + (i ? 1 : -1) * (this.mood === 'alert' ? -6 : this.mood === 'sleep' ? 10 : 0)));
    const flap = calm ? 0 : s.wing.x * 22 * (.5 + .5 * Math.sin(TAU * t * 5));
    e.wings.forEach((el, i) => turn(el, (i ? -1 : 1) * flap));
    if (e.flame && !calm) at(e.flame, 'transform', `translate(60 100) scale(${(1 + .03 * Math.sin(t * 11)).toFixed(3)} ${(1 + .06 * Math.sin(t * 7.3) + .03 * Math.sin(t * 17)).toFixed(3)}) translate(-60 -100)`);
    if (e.spark) { const p = calm ? .3 : (t * .55) % 1; at(e.spark, 'cy', (18 - p * 14).toFixed(2)); at(e.spark, 'cx', (60 + Math.sin(p * 9) * 3).toFixed(2)); at(e.spark, 'opacity', (calm ? .6 : (1 - p) * .9).toFixed(2)); }
    e.bubs.forEach((b, i) => { const p = calm ? .4 : ((t * (.18 + i * .05)) + i * .37) % 1; at(b, 'transform', `translate(${(Math.sin(p * 6 + i) * 1.5).toFixed(2)} ${(-p * 46).toFixed(2)})`); at(b, 'opacity', (Math.sin(p * Math.PI) * .55).toFixed(2)); });
    if (e.cap && !calm) at(e.cap, 'cy', (24 - Math.sin(t * 2.1) * 1.2).toFixed(2));
    if (e.bulb) {
      const col = BULB[this.held ? 'held' : this.mood];
      at(e.bulb, 'fill', col); at(e.bulbGlow, 'fill', col);
      const pulse = !calm && (this.mood === 'working' || this.mood === 'alert') ? .55 + .45 * Math.sin(t * (this.mood === 'alert' ? 7 : 4)) : 1;
      at(e.bulbGlow, 'opacity', (.3 * pulse + .05).toFixed(2));
    }
    const headY = def.top - this.jumpY, sp = t - this.sparkAt;
    e.sparkles.forEach((p, i) => {
      if (sp < 0 || sp > 1 || calm) { at(p, 'opacity', 0); return; }
      const a = -Math.PI / 2 + (i - 2) * .62, d = 22 + sp * 26, k = Math.sin(Math.min(1, sp / .9) * Math.PI);
      at(p, 'transform', `translate(${(60 + Math.cos(a) * d * 1.3).toFixed(2)} ${(headY + 30 + Math.sin(a) * d).toFixed(2)}) rotate(${(sp * 120).toFixed(1)}) scale(${(k * (i % 2 ? .7 : 1.1)).toFixed(3)})`);
      at(p, 'opacity', k.toFixed(2));
    });
    at(e.badge, 'transform', `translate(86 ${(headY + 8).toFixed(2)}) scale(${Math.max(0, s.badge.x).toFixed(3)})`);
    e.zz.forEach((z, i) => {
      if (this.mood !== 'sleep') { at(z, 'opacity', 0); return; }
      const p = calm ? .5 : ((t * .35) + i * .5) % 1;
      at(z, 'x', (78 + p * 10 + i * 2).toFixed(2)); at(z, 'y', (headY + 22 - p * 22).toFixed(2));
      at(z, 'opacity', (Math.sin(p * Math.PI) * .95).toFixed(2));
    });
    e.dots.forEach((d, i) => {
      if (this.mood !== 'thinking') { at(d, 'opacity', 0); return; }
      const k = calm ? 1 : .35 + .65 * Math.max(0, Math.sin(TAU * (t * .9 - i * .18)));
      at(d, 'cx', 80 + i * 7); at(d, 'cy', (headY + 12 - i * 3).toFixed(2)); at(d, 'opacity', k.toFixed(2));
    });
  }
}

/* One clock for every mounted character. */
const live = new Set<Critter>();
let frame = 0, last = 0;
function tick(now: number) {
  const dt = Math.min(1 / 30, (now - last) / 1000 || 1 / 60);
  last = now;
  if (!document.hidden) { const rm = reduced(), still = typing(); for (const c of live) c.update(dt, rm, still); }
  frame = live.size ? requestAnimationFrame(tick) : 0;
}
const track = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.at = performance.now(); };

export function animate(c: Critter) {
  if (!live.size) window.addEventListener('pointermove', track, { passive: true });
  live.add(c);
  if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
}

export function stopAnimating(c: Critter) {
  live.delete(c);
  if (!live.size) { window.removeEventListener('pointermove', track); if (frame) cancelAnimationFrame(frame); frame = 0; }
}
