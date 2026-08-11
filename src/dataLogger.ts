/**
 * ML training-data recorder. Appends one JSONL row per symbol per 5-min
 * stats cycle to ml-data.jsonl in STATE_DIR (the Railway volume), capturing
 * the exact features the strategy saw. Trade outcomes live separately in
 * live-state.json fills; joining the two on timestamp+symbol later gives a
 * labeled dataset for the direction-classifier experiment.
 *
 * ~30 symbols × 288 bars/day ≈ 2 MB/day — years of headroom on the volume.
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ML_DATA_FILE = process.env.ML_DATA_FILE ?? join(process.env.STATE_DIR ?? '.', 'ml-data.jsonl');

export interface MlRow {
  t: string;
  symbol: string;
  price: number;
  z: number | null;
  volPct: number | null;
  spreadPct: number | null;
  regimeBearish: boolean;
  triggeredCount: number;
  holding: boolean;
}

export function recordRows(rows: MlRow[], log: (msg: string) => void): void {
  if (rows.length === 0) return;
  try {
    mkdirSync(dirname(ML_DATA_FILE), { recursive: true });
    appendFileSync(ML_DATA_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    log(`WARN: ml-data write failed: ${(err as Error).message}`);
  }
}

export function dataFileSizeBytes(): number {
  try {
    return statSync(ML_DATA_FILE).size;
  } catch {
    return 0;
  }
}
