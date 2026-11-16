/* The companion cast: eight characters, each drawn by hand as layered vector
   art. These colours are illustration, the same in both themes, which is why
   they live here and not in tokens.css (design-contract.md, "Project
   companions"). Dolphin picks a character from the project's folder
   (dolphin-backend/app/companion_pick.py); the user can choose another. */

export type CastKey = 'pip' | 'mochi' | 'bolt' | 'ember' | 'luna' | 'pebble' | 'fizz' | 'nori';

export type CastMember = {
  key: CastKey;
  name: string;
  line: string;
  kind: string;
  c: { hi: string; base: string; dark: string; cheek: string; brow: string };
  /** The body silhouette, as SVG markup with no fill of its own. */
  shape: string;
  /** Face centre, eye spacing, eye radius, mouth offset, top of the head, resting upper lid. */
  face: [number, number];
  ex: number;
  er: number;
  my: number;
  top: number;
  rest: number;
  eye?: string;
  mouth?: string;
  lid?: string;
  brows?: number;
  robot?: boolean;
  mouthOff?: boolean;
  behind?: () => string;
  inner?: () => string;
  faceBack?: () => string;
  faceFront?: () => string;
  acc?: () => string;
};

/** Mirror a path across the character's centre line (x = 60). */
const mirror = (d: string) => d.replace(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g, (_m, x: string, y: string) => `${+(120 - Number(x)).toFixed(2)} ${y}`);

export const CAST: CastMember[] = [
  { key: 'pip', name: 'Pip', line: 'Curious and quick.', kind: 'New projects',
    c: { hi: '#b4f2bf', base: '#4cbf72', dark: '#237f49', cheek: '#ff8fa3', brow: '#1f5f39' },
    shape: '<path d="M60 30C83 30 97 47 97 69C97 91 81 104 60 104C39 104 23 91 23 69C23 47 37 30 60 30Z"/>',
    face: [60, 72], ex: 13, er: 6.2, my: 13, top: 12, rest: .06,
    acc: () => `<g class="pivot" data-px="60" data-py="31"><path d="M60 31C59 25 60 20 63 15" fill="none" stroke="#2c8a50" stroke-width="2.8" stroke-linecap="round"/>
      <path d="M62.5 16.5C55 7 45 8.5 43.5 13.5C49.5 19.5 57 19.5 62.5 16.5Z" fill="#7fdc93"/><path d="M62.5 16.5C55 12 50 12.5 46 13.5" fill="none" stroke="#4fb56c" stroke-width="1" stroke-linecap="round"/>
      <path d="M63 15.5C67 5.5 78 5 80.5 9.5C76 16.5 69 17.5 63 15.5Z" fill="#62cc7d"/></g>` },
  { key: 'mochi', name: 'Mochi', line: 'Soft, unhurried, content.', kind: 'Writing and research',
    c: { hi: '#fff6ee', base: '#ffd3ba', dark: '#e39b82', cheek: '#ff7f95', brow: '#b9705a' },
    shape: '<path d="M17 94C17 62 36 44 60 44C84 44 103 62 103 94C103 101 99 104 92 104L28 104C21 104 17 101 17 94Z"/>',
    face: [60, 80], ex: 15, er: 5.6, my: 11, top: 34, rest: .3,
    acc: () => `<g class="pivot" data-px="60" data-py="45"><path d="M59 45C56.5 37 62 32.5 66.5 36C69 38.5 66 41.5 63.5 39.5" fill="none" stroke="#e39b82" stroke-width="2.6" stroke-linecap="round"/></g>` },
  { key: 'bolt', name: 'Bolt', line: 'Precise. Its antenna light shows status.', kind: 'Tools and infrastructure',
    c: { hi: '#d9e8ff', base: '#7ea7e8', dark: '#3f62a8', cheek: '#ff8fb8', brow: '#3f62a8' },
    shape: '<rect x="24" y="40" width="72" height="64" rx="24"/>',
    face: [60, 74], ex: 13, er: 5.6, my: 10, top: 12, rest: .04, eye: '#8ff4ff', mouth: '#8ff4ff', lid: '#1a2944', brows: 0, robot: true,
    behind: () => `<circle cx="23.5" cy="72" r="5" fill="#3f62a8"/><circle cx="96.5" cy="72" r="5" fill="#3f62a8"/>`,
    faceBack: () => `<rect x="-26" y="-17" width="52" height="34" rx="13" fill="#1a2944"/><rect x="-26" y="-17" width="52" height="34" rx="13" fill="none" stroke="#ffffff" stroke-opacity=".12"/>`,
    acc: () => `<g class="pivot" data-px="60" data-py="41"><path d="M60 41V25" stroke="#3f62a8" stroke-width="3.2" stroke-linecap="round"/>
      <circle class="bulb-glow" cx="60" cy="20" r="10" fill="#7ef0c9" opacity=".3" filter="url(#ID-soft)"/><circle class="bulb" cx="60" cy="20" r="5.6" fill="#7ef0c9"/><circle cx="58.2" cy="18.2" r="1.7" fill="#fff" opacity=".8"/></g>` },
  { key: 'ember', name: 'Ember', line: 'Restless energy.', kind: 'Apps and products',
    c: { hi: '#ffe08f', base: '#ff8a3d', dark: '#d2402a', cheek: '#ff4f5e', brow: '#9c2a1c' },
    shape: '<path d="M60 20C66 37 93 47 93 75C93 93 79 104 60 104C41 104 27 93 27 75C27 59 39 52 44 39C48 49 51 52 54 52C54 40 56 30 60 20Z"/>',
    face: [60, 80], ex: 12.5, er: 5.8, my: 11, top: 6, rest: .02,
    inner: () => `<path class="flame" d="M60 48C64 59 79 66 79 83C79 95 71 101 60 101C49 101 41 95 41 83C41 72 49 66 53 57C55 63 57 63 58.5 61C58.5 55 58.5 52 60 48Z" fill="#ffd36e" opacity=".85"/>`,
    acc: () => `<circle class="spark" cx="60" cy="16" r="2" fill="#ffd36e"/>` },
  { key: 'luna', name: 'Luna', line: 'Thoughtful. Ears twitch when something changes.', kind: 'Design and interfaces',
    c: { hi: '#ece4ff', base: '#a68cf0', dark: '#6a50c0', cheek: '#ff93c6', brow: '#4f3a99' },
    shape: '<path d="M60 36C82 36 98 52 98 72C98 92 82 104 60 104C38 104 22 92 22 72C22 52 38 36 60 36Z"/>',
    face: [60, 75], ex: 13, er: 6.2, my: 12, top: 18, rest: .12,
    behind: () => {
      const L = 'M30 54C27 41 29 29 34.5 22C42 27 48.5 35 51 43Z', I = 'M34 47C33 40 34 33 37 28.5C41.5 32 44.5 37 45.5 41.5Z';
      return `<g class="ear" data-px="41" data-py="46"><path d="${L}" fill="url(#ID-b)"/><path d="${I}" fill="#ffc6e1"/></g>
              <g class="ear" data-px="79" data-py="46"><path d="${mirror(L)}" fill="url(#ID-b)"/><path d="${mirror(I)}" fill="#ffc6e1"/></g>`;
    } },
  { key: 'pebble', name: 'Pebble', line: 'Steady and calm.', kind: 'Backends and services',
    c: { hi: '#e6eef2', base: '#97b0b9', dark: '#5a7480', cheek: '#ff9c9c', brow: '#3e5560' },
    shape: '<path d="M21 79C21 56 40 44 62 44C86 44 101 58 101 77C101 95 85 104 60 104C37 104 21 96 21 79Z"/>',
    face: [61, 79], ex: 13, er: 5.2, my: 10, top: 30, rest: .24,
    inner: () => `<circle cx="34" cy="86" r="1.6" fill="#5a7480" opacity=".35"/><circle cx="88" cy="70" r="1.3" fill="#5a7480" opacity=".3"/><circle cx="80" cy="94" r="1.8" fill="#5a7480" opacity=".28"/>`,
    acc: () => `<g class="pivot" data-px="58" data-py="46"><circle cx="49.5" cy="46" r="5" fill="#5f9e52"/><circle cx="58" cy="42.5" r="6.2" fill="#78bd67"/><circle cx="66.5" cy="45.5" r="4.6" fill="#6aaf5a"/><circle cx="56" cy="40.5" r="1.6" fill="#a8e29a" opacity=".8"/></g>` },
  { key: 'fizz', name: 'Fizz', line: 'Bubbly and quick to react.', kind: 'Experiments',
    c: { hi: '#c9fff6', base: '#3fd3c4', dark: '#178f8d', cheek: '#ff8fbf', brow: '#0f6b69' },
    shape: '<path d="M24 70C24 46 40 32 60 32C80 32 96 46 96 70V95C96 100 92 102 89 99C86 96 82 96 80 100C77 105 71 105 68 100C65 96 59 96 56 100C53 105 47 105 44 100C41 96 36 96 33 99C30 102 24 100 24 95Z"/>',
    face: [60, 64], ex: 13, er: 6.4, my: 12, top: 14, rest: .04,
    inner: () => `<circle class="bub" cx="38" cy="92" r="2.4" fill="#fff" opacity=".45"/><circle class="bub" cx="82" cy="88" r="1.7" fill="#fff" opacity=".45"/><circle class="bub" cx="70" cy="96" r="1.3" fill="#fff" opacity=".4"/>`,
    acc: () => `<g class="pivot" data-px="60" data-py="32"><circle class="cap" cx="60" cy="24" r="4.6" fill="#ffffff" fill-opacity=".18" stroke="#ffffff" stroke-opacity=".75" stroke-width="1.3"/><circle cx="58.4" cy="22.4" r="1.2" fill="#fff" opacity=".9"/></g>` },
  { key: 'nori', name: 'Nori', line: 'Wise and watchful.', kind: 'Data and models',
    c: { hi: '#b7c3f7', base: '#5a68c6', dark: '#2f3884', cheek: '#ff9fb8', brow: '#1f2560' },
    shape: '<path d="M60 26C80 26 94 48 94 72C94 92 80 104 60 104C40 104 26 92 26 72C26 48 40 26 60 26Z"/>',
    face: [60, 62], ex: 12, er: 6.4, my: 12, top: 10, rest: .1, mouthOff: true, lid: '#e4e8fb',
    inner: () => `<ellipse cx="60" cy="86" rx="20" ry="15" fill="#e3e8ff" opacity=".92"/><path d="M50 82q2.5 2.5 5 0M58 87q2.5 2.5 5 0M66 82q2.5 2.5 5 0" fill="none" stroke="#9aa6dc" stroke-width="1.3" stroke-linecap="round"/>`,
    behind: () => {
      const W = 'M29 66C19 70 16 84 22 92C29 89 33 80 33 70Z';
      return `<g class="wing" data-px="31" data-py="68"><path d="${W}" fill="#3e489c"/></g><g class="wing" data-px="89" data-py="68"><path d="${mirror(W)}" fill="#3e489c"/></g>`;
    },
    faceBack: () => `<circle cx="-12" cy="0" r="10.5" fill="#eef1ff"/><circle cx="12" cy="0" r="10.5" fill="#eef1ff"/>`,
    faceFront: () => `<path class="beak" d="M-4 10L4 10L0 16Z" fill="#ffc24b" stroke="#e59a1c" stroke-width=".8" stroke-linejoin="round"/>`,
    acc: () => {
      const T = 'M41 36C36 26 36 19 38.5 14C45 20 49 27 51 32Z';
      return `<g class="tuft" data-px="46" data-py="33"><path d="${T}" fill="url(#ID-b)"/></g><g class="tuft" data-px="74" data-py="33"><path d="${mirror(T)}" fill="url(#ID-b)"/></g>`;
    } },
];

export const castOf = (key: string | null | undefined): CastMember => CAST.find((c) => c.key === key) ?? CAST[0];
