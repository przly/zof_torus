# Hero Torus — Front-End Integration Guide

A self-contained WebGL hero background: a blurred, noise-textured torus that
gently swings toward the cursor (or a tapped point on mobile). No build
step, no dependencies — three plain files.

- `index.html` — reference markup, shows the minimal structure required
- `styles.css` — required baseline styles for the hero section + canvas
- `hero.js` — all WebGL logic, a single self-invoking function, no exports

## Integration steps

1. **Copy the markup structure** from `index.html`:

   ```html
   <section class="hero">
     <canvas id="torus-canvas"></canvas>
   </section>

   <script src="hero.js" defer></script>
   ```

   `hero.js` looks up the canvas by the hard-coded id `torus-canvas` — if
   you rename it, update the `getElementById` call at the top of the file
   to match. Only include this markup **once per page**; the script doesn't
   support multiple instances.

2. **Merge the CSS** from `styles.css` into your stylesheet (or keep it as
   a separate file). The two rules that matter functionally:
   - `.hero` needs `position: relative`, a defined height, and
     `overflow: hidden` so the canvas can fill it via `position: absolute;
     inset: 0`.
   - Text selection and iOS's long-press callout are disabled on `.hero`
     (`user-select: none`, `-webkit-touch-callout: none`) since its only
     content is the canvas.

3. **Load `hero.js` with `defer`** (or place it at the end of `<body>`).
   It self-initializes on load — no setup call needed from your side.

4. **Keep the background color in sync.** `hero.js` has a `BG_COLOR`
   constant (`[0.1725, 0.2941, 0.9490]`, i.e. `#2c4bf2`) that WebGL clears
   to every frame, independent of CSS. If you change `.hero`'s background
   color, update `BG_COLOR` to match or you'll see a mismatched flash/edge
   before the canvas paints.

## Behavior the team should know about

- **Silent fallback**: if WebGL isn't available, the script returns early
  and draws nothing — no error, no fallback image. The `.hero` background
  color alone is the degraded state, so make sure it looks acceptable on
  its own.
- **`prefers-reduced-motion: reduce`** freezes the animated noise texture
  and stops the swing from tracking pointer movement (the render loop
  keeps running but nothing changes frame to frame).
- **Device-tier heuristics are automatic** — no flags to set. Coarse
  pointer (touch) devices get tap-to-move instead of hover, drop grain
  entirely, and use a wider swing range tuned for smaller screens. Low
  core-count *non-touch* devices (e.g. an old laptop) fall back to cheaper
  blur/geometry.
- **Rendering pauses on tab hide** (`visibilitychange`) and resumes when
  the tab is visible again, to save battery/CPU.
- **Resize handling uses `ResizeObserver`**, not a single size check at
  load — this matters on mobile, where the canvas can otherwise briefly
  measure a zero/incorrect size before layout settles.

## Testing checklist before shipping a change

- Desktop: mouse parallax tracks smoothly, no jank on resize.
- Mobile Safari/Chrome: tap-to-move works, no text-selection popup on
  long-press, torus isn't squashed/distorted on a cold load.
- `prefers-reduced-motion` enabled in OS settings: animation is static.
- Rotate device / resize window: canvas stays correctly proportioned.
- Backgrounding the tab and returning: animation pauses and resumes.

## Browser support

Requires WebGL1 (falls back to `experimental-webgl`) and `ResizeObserver`
(supported in all current evergreen browsers). No polyfills are bundled —
add one if you need to support older browsers than that.
