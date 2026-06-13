// Distinguishes touch/mobile devices from desktops and reflects the verdict as
// body classes (`is-mobile` / `is-desktop`) that drive the responsive CSS:
// collapsible bars, a single-column control stack and larger touch targets.
// Re-evaluated on resize and orientation change so a rotated phone, a flipped
// tablet, or a resized desktop window each land in the right layout.

function detect() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const narrow = window.matchMedia('(max-width: 820px)').matches;
  // Mobile = a touch-first device on a phone/tablet-sized viewport. A desktop
  // that happens to have a touchscreen stays "desktop": its pointer is fine and
  // its window is wide, so the full side-by-side layout still fits.
  return (touch || coarse) && narrow;
}

let mobile = null;
export function isMobile() { return mobile; }

// Toggle the body classes when the verdict changes; returns the current value.
export function applyDeviceClass() {
  const m = detect();
  if (m === mobile) return m;
  mobile = m;
  document.body.classList.toggle('is-mobile', m);
  document.body.classList.toggle('is-desktop', !m);
  return m;
}

window.addEventListener('resize', applyDeviceClass);
window.addEventListener('orientationchange', applyDeviceClass);
