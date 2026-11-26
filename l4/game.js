export const WIDTH = 900;
export const HEIGHT = 420;
export const START_X = 145;
export const RADIUS = 13;
export const SPACING = 285;
export const FIRST_GATE = 580;
export const GAP = 170;
export const GATE_WIDTH = 46;
export const STEP = 0.025;
export const SPEED = 155;
export const GRAVITY = 590;
export const MAX_FALL_SPEED = 340;
export const FLAP_INTERVAL = 90;

export function newRun() {
  return { x: START_X, y: HEIGHT / 2, vy: 0, points: 0, phase: "ready", version: 0 };
}

export function lift(run) {
  if (run.phase === "over") Object.assign(run, { ...newRun(), version: run.version });
  run.phase = "flying";
  run.vy = -245;
  run.version++;
}

export function gate(index) {
  const offsets = [0, 46, -37, 64, -56, 17, -68, 31, -21];
  return { x: FIRST_GATE + index * SPACING, y: HEIGHT / 2 + offsets[index % offsets.length] };
}

export function advance(run) {
  run.x += SPEED * STEP;
  run.vy = Math.min(MAX_FALL_SPEED, run.vy + GRAVITY * STEP);
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
