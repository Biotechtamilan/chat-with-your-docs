import { randomUUID } from "node:crypto";
import type { TraceData, TraceStage } from "./types";

/**
 * Collects per-stage timings for one question. The finished trace is stored
 * and also sent to the browser, so "why did it answer that, and why was it
 * slow" can be read off the screen instead of reconstructed from logs.
 */
export class TraceRecorder {
  readonly id = randomUUID();
  private readonly startedAt = performance.now();
  private readonly stages: TraceStage[] = [];

  async stage<T>(name: string, run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await run();
    } finally {
      this.record(name, performance.now() - started);
    }
  }

  record(name: string, ms: number): void {
    this.stages.push({ name, ms: Math.round(ms) });
  }

  /** Milliseconds since the recorder was created. */
  elapsed(): number {
    return Math.round(performance.now() - this.startedAt);
  }

  snapshot(fields: Omit<TraceData, "id" | "stages" | "totalMs">): TraceData {
    return { id: this.id, stages: [...this.stages], totalMs: this.elapsed(), ...fields };
  }
}
