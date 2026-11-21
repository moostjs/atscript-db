import { expect } from "vite-plus/test";

/**
 * Shared rows and checks of the SQL `vector-score` specs (since 0.1.183), for
 * the tables of `fixtures/vector-score.as` (of each adapter).
 */

/** A vector search row as the specs read it. */
export type Row = { id: string; _distance: number; $score: number };

/** Unit vectors at 0°, 30°, 90°, 120°, 180° from the query [1, 0]: cosine = dot = 1, .866, 0, −.5, −1. */
export const ANGLES = [
  { id: "a", title: "0°", embedding: [1, 0] },
  { id: "b", title: "30°", embedding: [Math.cos(Math.PI / 6), 0.5] },
  { id: "c", title: "90°", embedding: [0, 1] },
  { id: "e", title: "120°", embedding: [-0.5, Math.sin((2 * Math.PI) / 3)] },
  { id: "d", title: "180°", embedding: [-1, 0] },
];
export const Q_ANGLE = [1, 0];

/** Points at distance 0, 0.5, 1, 3, 9 from the query [0, 0]: score 1, .667, .5, .25, .1. */
export const POINTS = [
  { id: "a", title: "0", embedding: [0, 0] },
  { id: "b", title: "0.5", embedding: [0.5, 0] },
  { id: "c", title: "1", embedding: [1, 0] },
  { id: "d", title: "3", embedding: [3, 0] },
  { id: "e", title: "9", embedding: [9, 0] },
];
export const Q_POINT = [0, 0];

export const ids = (rows: Row[]) => rows.map((r) => r.id);

/** Every row reaches `threshold` (float32 distances: 1e-6 slack). */
export function expectAtLeast(rows: Row[], threshold: number) {
  for (const row of rows) expect(row.$score).toBeGreaterThanOrEqual(threshold - 1e-6);
}

export function expectDescending(rows: Row[]) {
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i]!.$score).toBeLessThanOrEqual(rows[i - 1]!.$score);
  }
}
