// Still Room tokens for an SVG <style> (conventions s5.1; source: research/06-still-room-digest.md).
// Dark is the default (console); light = workshop via prefers-color-scheme.
// Pure data, no imports.

/** The CSS block, embedded once per SVG document. */
export const TOKENS_CSS = `svg{
--panel:#2a2f45;--tile:#3a4162;--well:#0f111c;--muted:#5a627f;
--edge:#0f111c;--edge-mid:#414968;--hi:#414968;--shade:#1b1f30;
--hi-tile:#56608a;--shade-tile:#262b40;
--text:#f4efe6;--text2:#9aa0b8;--text2-tile:#b4bad0;--on-accent:#1a1d2b;--link:#ffb545;
--accent:#ff8a2a;--accent-glow:#ffb545;--accent-shade:#b8501a;
--rival:#3ab4ff;--rival-glow:#9fdcff;--rival-shade:#1e6fc2;
--ok:#3ddc84;--warn:#ffe05a;--danger:#ff4d4d;--arcane:#8c75fa;--info:#4dd8ff;
--l-accent:#ffb545;--l-ok:#3ddc84;--l-warn:#ffe05a;--l-danger:#ff4d4d;
--font-pixel:"Silkscreen",ui-monospace,Menlo,monospace;
--font-body:"Chivo",system-ui,-apple-system,sans-serif;
--font-mono:"Space Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme: light){svg{
--panel:#efe8d9;--tile:#faf6ec;--well:#ffffff;--muted:#cfc7b5;
--edge:#1a1d2b;--edge-mid:#b8ae98;--hi:#ffffff;--shade:#cfc7b5;--hi-tile:#ffffff;--shade-tile:#e4ddcc;
--text:#1a1d2b;--text2:#5b5e72;--text2-tile:#5b5e72;--on-accent:#1a1d2b;--link:#9e4416;
--l-accent:#b8501a;--l-ok:#1f7a48;--l-warn:#8a6a00;--l-danger:#c2331f;
}}
text{font-family:var(--font-pixel);letter-spacing:1px}
.mono{font-family:var(--font-mono);letter-spacing:0}
.body{font-family:var(--font-body);letter-spacing:0}
.step3{animation-timing-function:steps(3)}
.step4{animation-timing-function:steps(4)}
@media (prefers-reduced-motion: no-preference){.blink{animation:blink 1s steps(3) infinite}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.55}}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}`

/** `<style>` element holding TOKENS_CSS. */
export const TOKENS_STYLE = `<style>${TOKENS_CSS}</style>`

/** CSS var references, for attribute use: fill="var(--accent)". */
export const V = {
  panel: 'var(--panel)',
  tile: 'var(--tile)',
  well: 'var(--well)',
  muted: 'var(--muted)',
  edge: 'var(--edge)',
  edgeMid: 'var(--edge-mid)',
  hi: 'var(--hi)',
  shade: 'var(--shade)',
  hiTile: 'var(--hi-tile)',
  shadeTile: 'var(--shade-tile)',
  text: 'var(--text)',
  text2: 'var(--text2)',
  onAccent: 'var(--on-accent)',
  accent: 'var(--accent)',
  rival: 'var(--rival)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  arcane: 'var(--arcane)',
  info: 'var(--info)',
  lAccent: 'var(--l-accent)',
  lOk: 'var(--l-ok)',
  lWarn: 'var(--l-warn)',
  lDanger: 'var(--l-danger)',
} as const

/** Signal name -> segment/edge fill var. Signals are fills, edges and glyphs only; text uses lText. */
export type Signal = 'ok' | 'warn' | 'danger' | 'arcane' | 'info' | 'accent' | 'rival' | 'neutral'
export const SIGNAL_FILL: Record<Signal, string> = {
  ok: V.ok,
  warn: V.warn,
  danger: V.danger,
  arcane: V.arcane,
  info: V.info,
  accent: V.accent,
  rival: V.rival,
  neutral: V.muted,
}
/** Signal name -> label colour for TEXT (light-mode safe). */
export const SIGNAL_TEXT: Record<Signal, string> = {
  ok: V.lOk,
  warn: V.lWarn,
  danger: V.lDanger,
  arcane: V.arcane,
  info: V.info,
  accent: V.lAccent,
  rival: V.rival,
  neutral: V.text2,
}

/** Tier colours (agents.md): Fable, Opus, Sonnet, Haiku, other. */
export const TIER_COLOR = {
  fable: '#c084fc',
  opus: '#f2c14e',
  sonnet: '#3ab4ff',
  haiku: '#3ddc84',
  other: '#5a627f',
} as const

/** Fixed hex values (rules.json allowed list) for places a CSS var cannot reach. */
export const HEX = {
  accent: '#ff8a2a',
  accentGlow: '#ffb545',
  rival: '#3ab4ff',
  rivalGlow: '#9fdcff',
  ok: '#3ddc84',
  warn: '#ffe05a',
  danger: '#ff4d4d',
  arcane: '#8c75fa',
  info: '#4dd8ff',
} as const

/** Font families (same stacks as the CSS vars). */
export const FONT = {
  pixel: '"Silkscreen",ui-monospace,Menlo,monospace',
  body: '"Chivo",system-ui,-apple-system,sans-serif',
  mono: '"Space Mono",ui-monospace,SFMono-Regular,Menlo,monospace',
} as const

/** Never draw text below this size (conventions s5.2). */
export const MIN_FONT_PX = 9

/** Band row height in px (conventions s4.2). */
export const BAND_H = 30

/** Gap between band segments in px. */
export const SEG_GAP = 12
