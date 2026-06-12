// Centralized pseudo-random source so every bit of simulation randomness can be
// made deterministic in tests. Defaults to Math.random (production behaviour is
// unchanged); seedRng() swaps in a reproducible Park–Miller LCG — the same
// generator the city skyline uses — and resetRng() restores Math.random.
let _rand = Math.random;

// Park–Miller minimal-standard LCG: deterministic, dependency-free, ample
// variety for vehicle/spawn jitter. Returns floats in [0,1).
function seedRng(seed) {
  let s = (seed >>> 0) % 2147483647;
  if (s <= 0) s += 2147483646;
  _rand = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
function resetRng() { _rand = Math.random; }
// Draw the next pseudo-random float in [0,1). Use everywhere the sim would
// otherwise call Math.random so a single seed reproduces an entire run.
function rng() { return _rand(); }

export { rng, seedRng, resetRng };
