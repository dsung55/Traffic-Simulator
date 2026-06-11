# Traffic-Simulator

A 2D top-down highway/city traffic microsimulation (IDM car-following + MOBIL
lane changing) rendered on an HTML5 canvas. Cars have driver personalities
(aggressive / normal / passive), physically sized bodies, realistic multi-phase
lane changes (signal → wait for a gap → smooth steer-over, with cooperative
yielding), a metered on-ramp, an optional exit ramp, incidents, weather, and a
city arterial scenario with signals.

## Running

The app is plain static files using ES modules, so it needs to be served over
HTTP (browsers block module imports from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server (or GitHub Pages) works. There is no build step and no
dependencies.

## Code layout

| File | Contents |
| --- | --- |
| `index.html` | Markup only (control panel, metrics, inspector) |
| `style.css` | All styling |
| `js/config.js` | Constants, driver profiles, scenario definitions |
| `js/state.js` | The mutable `sim` state object + small derived helpers |
| `js/engine.js` | Simulation: IDM, MOBIL lane-change state machine, integration, spawning, tick |
| `js/rng.js` | Random source: `Math.random` in the app, seedable for deterministic tests |
| `js/render.js` | Canvas renderer (static scene + dynamic layers), camera, pointer input |
| `js/ui.js` | Control wiring, live metrics, sparkline, vehicle inspector |
| `js/dom.js` | Tiny shared DOM helpers |
| `js/main.js` | Entry point: wires everything, injects the engine's UI hooks, starts the loops |

## Testing

The simulation core (`engine.js`, `state.js`, `config.js`) has no DOM
dependency — `main.js` injects the UI/render callbacks via `setEngineHooks` —
so it runs headless under Node's built-in test runner (no dependencies,
Node ≥ 18):

```sh
npm test
```

Tests live in `test/`. They seed the RNG (`seedRng` in `js/rng.js`) so every
run is reproducible; the live app keeps using `Math.random`, so on-screen
traffic stays non-deterministic. Coverage includes the IDM math, gap/leader
queries, the lane-change state machine, light phasing, and per-tick physical
invariants (no clipping, bounded speeds/positions, liveness) run across
multiple scenarios and seeds.

Units: 1 cell = 7.5 m, 1 tick = 1 simulated second (200 ms wall clock);
speeds are in cells/second (1 cell/s ≈ 16.8 mph). Rendering runs at 60 fps
and interpolates between ticks.
