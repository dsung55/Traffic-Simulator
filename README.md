# Traffic-Simulator

A browser traffic lab. Change demand, drivers, road design, traffic control and
conditions, then watch what each one does to speed, flow, travel time and
stop-and-go waves. Under the hood it is a 2D top-down microsimulation (IDM
car-following + MOBIL lane changing) on an HTML5 canvas, with a highway
scenario (on-ramp, optional exit ramp, incidents) and a city arterial with
traffic signals.

## Running

The app is plain static files using ES modules, so it needs to be served over
HTTP (browsers block module imports from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server (or GitHub Pages) works. There is no build step and no
dependencies. It works on desktop and on phones (touch: tap a car, pinch to
zoom, the controls fold into a bottom sheet).

## Using it

**Top bar:** choose the road layout (Highway / City), open **Experiments**,
trigger a phantom **Brake**, toggle the speed **Heat map**, set the sim speed
(1×–8×), pause and restart. Below that are the live metrics.

**Bottom dock:** every variable, grouped into tabs. Each control shows its
value in real units, and the <kbd>i</kbd> button explains what it is and why it
matters. A blue dot marks settings changed from the default (the tab shows how
many); the ↺ button next to a changed control restores its default. Controls
that don't apply to the current layout are hidden, and the tab says so.

| Tab | Controls |
| --- | --- |
| Demand | Mainline demand (veh/h/lane), on-ramp demand (veh/h), exit ramp + share exiting |
| Drivers & Vehicles | Reaction time (s), aggressive / cautious / distracted drivers (%), automated vehicles (%), trucks (%) |
| Road | Lanes, speed limit (mph), on-ramp merge-lane length, keep trucks out of the left lane |
| Traffic Control | Ramp meter + release interval, variable speed limit (highway); signal cycle length, green split, green wave (city) |
| Events | Phantom brake, incident + lanes blocked + rubbernecking |
| Environment | Weather: clear, rain, fog, snow |
| Simulation | Speed heat-map overlay, restore defaults, shortcuts, welcome tip |

**Metrics:** a plain-language verdict (free flow, near capacity, breakdown,
spillback…), the Highway Capacity Manual **Level of Service** (A–F; density
for freeways, control delay per signal for the arterial, and F whenever demand
exceeds capacity and a queue builds upstream), and tiles for average speed,
flow (veh/h/lane), density (veh/mi/lane), travel time, delay per vehicle, stops
per vehicle, the ramp queue, the queue wait and the entry queue. Travel time
is measured on the road, from entering it to leaving; time spent waiting to
get on (upstream when demand exceeds what the road takes, or at the ramp
meter) is reported separately as **Queue wait**, so a fix that speeds up the
road by holding cars back shows both sides. Two charts show speed
and flow over the last few minutes, and flow vs density (the *fundamental
diagram*). Hover a chart to read values, and hover or tap a tile for its
definition.

**Vehicle inspector:** click any vehicle to see its speed, desired speed,
acceleration, gap and time headway, reaction time, lane, and whether it is
automated, distracted or exiting. The Brake button in the inspector makes that
driver brake.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| <kbd>Space</kbd> | Pause / play |
| <kbd>R</kbd> | Restart the run (settings are kept) |
| <kbd>1</kbd>–<kbd>4</kbd> | Sim speed 1× / 2× / 4× / 8× |
| <kbd>B</kbd> | Phantom brake (selected car, or a random one mid-road) |
| <kbd>H</kbd> | Speed heat-map overlay |
| <kbd>S</kbd> | Save a baseline |
| <kbd>E</kbd> | Experiments |
| <kbd>?</kbd> | Shortcut list |
| <kbd>+</kbd> / <kbd>−</kbd>, <kbd>0</kbd> or <kbd>F</kbd>, arrows | Zoom, fit, pan |
| <kbd>Esc</kbd> | Close menus, deselect |

## Learning guide

The core loop is **observe → save a baseline → change one thing → compare**.

1. Let traffic settle for two to three minutes (fast-forward with <kbd>4</kbd>).
   Trip statistics cover the last two minutes of completed trips, so they need
   that long to reflect the current settings.
2. Press **Save baseline** (<kbd>S</kbd>). This snapshots the last minute of
   metrics and all settings.
3. Change **one** factor. The metrics bar lists what changed since the
   baseline (for example "Ramp meter Off → On").
4. Wait for traffic to respond (the bar shows "settling…" for the first
   minute; give it two or three), then read the deltas: **green = better,
   red = worse**, with the right direction per metric (higher speed and flow
   are better; longer travel time, more delay, stops, queues and waits are
   worse; density is neutral). The summary line weighs travel time on the road
   against the queues to get on, e.g. "Trips on the road are 9% faster than
   the baseline, but 40 more vehicles are now waiting to get on. A trade-off,
   not a free win."

### Experiments

**Experiments** sets these up for you. Each one configures a situation, tells
you what to watch and why it happens, warms up, then runs the A/B step and
reports the metrics that matter for it. Every experiment is also run headlessly
in `test/experiments.test.js` (same warm-up, baseline, change and settling time,
several seeds), which checks that its metrics move the way its explanation
says. Single runs are random, so incident experiments in particular can
occasionally buck the trend.

| Experiment | What it teaches |
| --- | --- |
| Phantom traffic jam | Near capacity, one hard brake becomes a jam that travels upstream. Quicker reactions damp it. |
| Ramp metering: who pays? | A meter moves the queue onto the ramp: ramp waits grow a lot, while the mainline gains a little at best unless the merge was breaking down. |
| More green for the main street | Signal capacity ≈ saturation flow × green share: more green cuts delay and stops sharply. |
| Rubbernecking at an incident | Gawking drivers slow the open lanes too; stopping it restores speed past the scene. |
| Rain and heavy trucks | Longer gaps and big vehicles reduce capacity, so the same demand can tip into congestion. |
| Automated vehicles vs stop-and-go | AVs react instantly and keep steady gaps, absorbing waves: throughput and speed rise. |
| Speed harmonization | A lower upstream limit near a bottleneck means much less hard braking, but on a short road it does not make trips faster. |
| Green wave | Coordinated signal offsets let platoons pass light after light without stopping. |

### Things worth knowing

- **More demand does not mean more flow.** Flow peaks at capacity (about
  2,000 veh/h/lane on a freeway). Past that point the road jams and carries
  *fewer* vehicles. Watch the flow vs density chart bend over.
- **Stop-and-go waves move backwards.** Turn on the heat map and watch red
  bands travel against the traffic.
- **Bottlenecks decide everything.** Extra capacity only helps where the
  constraint is: a merge, an incident, or a signal.
- **Trade-offs are real.** Ramp meters, lower limits and green splits make one
  group wait so the system flows better. Check both sides in the metrics.

## Code layout

| File | Contents |
| --- | --- |
| `index.html` | Markup shell: top bar, metrics, dock, inspector, dialogs |
| `style.css` | All styling (dark glass theme, desktop + mobile layouts) |
| `js/config.js` | Constants, driver profiles, scenario definitions |
| `js/state.js` | The mutable `sim` state object + small derived helpers |
| `js/engine.js` | Simulation: IDM, MOBIL lane-change state machine, integration, demand, stats |
| `js/rng.js` | Random source: `Math.random` in the app, seedable for deterministic tests |
| `js/render.js` | Canvas renderer, camera, pointer input (mouse, pen, multi-touch pinch/pan) |
| `js/ui.js` | UI orchestration: run controls, metrics + baseline comparison, experiments, inspector, shortcuts, onboarding |
| `js/ui/spec.js` | Declarative table of every control: field, range, units, scenario, explanation |
| `js/ui/controls.js` | Builds the tabbed control dock from the spec and keeps it in sync with `sim` |
| `js/ui/stats.js` | Stats sampling in sim time, Level of Service, the verdict line |
| `js/ui/charts.js` | Speed/flow time series and the flow-density scatter (DPR-crisp canvases) |
| `js/ui/experiments.js` | Guided experiment definitions |
| `js/ui/popover.js` | Shared accessible info popover |
| `js/device.js` | Mobile/desktop detection → `is-mobile`/`is-desktop` body classes |
| `js/dom.js` | Tiny shared DOM helpers |
| `js/main.js` | Entry point: wires everything, runs the tick loop at `TICK_MS / sim.timeScale` |

To add a control, add a row to `CONTROLS` in `js/ui/spec.js`. The dock,
"changed" badges, baseline diff and restore-defaults pick it up automatically.

## Testing

The simulation core (`engine.js`, `state.js`, `config.js`) has no DOM
dependency (`main.js` injects the UI/render callbacks via `setEngineHooks`),
so it runs headless under Node's built-in test runner (no dependencies,
Node ≥ 18):

```sh
npm test
```

Tests live in `test/`. They seed the RNG (`seedRng` in `js/rng.js`) so every
run is reproducible; the live app keeps using `Math.random`, so on-screen
traffic stays non-deterministic.

Units: 1 cell = 7.5 m, 1 tick = 1 simulated second (200 ms wall clock at 1×,
25 ms at 8×); speeds are in cells/second (1 cell/s ≈ 16.8 mph). Rendering
runs at 60 fps and interpolates between ticks.
