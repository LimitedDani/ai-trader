/**
 * ML feature recorder. Appends one JSONL row per symbol per 5-min cycle to
 * ml-data.jsonl in STATE_DIR (the Railway volume). Each row captures the
 * exact features the strategy saw AND the price at that moment — so the
 * training label (forward return N cycles later) can be reconstructed
 * offline by joining consecutive rows of the same symbol. No separate
 * outcome feed needed; the file is a self-contained dataset.
 *
 * ~425 symbols × 288 cycles/day ≈ 20 MB/day of JSONL — years of headroom
 * on a 50 GB volume, and trivially downloadable via /api/ml-data.
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ML_DATA_FILE = process.env.ML_DATA_FILE ?? join(process.env.STATE_DIR ?? '.', 'ml-data.jsonl');
export const mlLoggingEnabled = process.env.ML_LOG !== '0'; // on by default

export interface MlRow {
  t: string; // ISO timestamp — join key for forward-return labels
  s: string; // symbol
  p: number; // price now
  z: number | null; // z-score vs 4h mean
  vol: number | null; // volatility as % of price (std/price*100)
  spr: number | null; // spread %
  bear: boolean; // BTC-below-mean regime flag
  trig: number; // how many symbols were triggered this cycle (market breadth)
  hold: boolean; // were we holding this symbol
}

export function recordRows(rows: MlRow[], log: (msg: string) => void): void {
  if (!mlLoggingEnabled || rows.length === 0) return;
  try {
    mkdirSync(dirname(ML_DATA_FILE), { recursive: true });
    appendFileSync(ML_DATA_FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  } catch (err) {
    log(`WARN: ml-data write failed: ${(err as Error).message}`);
  }
}

export function dataFileMB(): number {
  try {
    return statSync(ML_DATA_FILE).size / 1e6;
  } catch {
    return 0;
  }
}
