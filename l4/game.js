export const WIDTH = 900;
export const HEIGHT = 420;
export const START_X = 145;
export const RADIUS = 13;
export const SPACING = 285;
export const FIRST_GATE = 580;
export const GAP = 170;
export const GATE_WIDTH = 46;
export const STEP = 0.025;

export function newRun() {
  return { x: START_X, y: HEIGHT / 2, vy: 0, points: 0, phase: "ready", version: 0 };
}

export function gate(index) {
  const offsets = [0, 46, -37, 64, -56, 17, -68, 31, -21];
  return { x: FIRST_GATE + index * SPACING, y: HEIGHT / 2 + offsets[index % offsets.length] };
}

export function advance(run) {
  run.x += 155 * STEP;
  run.vy = Math.min(340, run.vy + 590 * STEP);
  run.y += run.vy * STEP;
  const obstacle = gate(run.points);
  const hitsGate = run.x + RADIUS >= obstacle.x &&
    run.x - RADIUS <= obstacle.x + GATE_WIDTH &&
    Math.abs(run.y - obstacle.y) + RADIUS >= GAP / 2;
  if (hitsGate || run.y <= RADIUS || run.y >= HEIGHT - RADIUS) {
    run.y = Math.min(HEIGHT - RADIUS, Math.max(RADIUS, run.y));
    run.phase = "over";
  } else if (run.x - RADIUS > obstacle.x + GATE_WIDTH) {
    run.points++;
  }
}
