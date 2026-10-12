/**
 * The runs of a job's tasks that may still be going, in the job's own storage. A run is a vessel's slot running one
 * attempt of one task: it begins at the claim that hands it out, and ends only on its vessel's word that its process
 * exited or was killed, or that its container is gone. A task's status lists them (`ArmadaJob.taskStatus`), so a task
 * can tell whether the run that left something behind still runs. A run its vessel lost track of, or one in a
 * container that would not stop, stays listed.
 */
export interface Run {
  readonly vessel: string;
  readonly slot: number;
  readonly index: number;
  readonly attempt: number;
}

/** What a vessel says of a run it ended, beside its name and task: its slot and attempt. */
export interface RunEnd {
  readonly slot: number;
  readonly attempt: number;
}

export class Runs {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS runs (vessel TEXT NOT NULL, slot INTEGER NOT NULL, idx INTEGER NOT NULL, attempt INTEGER NOT NULL,
      started INTEGER NOT NULL, PRIMARY KEY (vessel, slot, idx, attempt))`);
  }

  began({ vessel, slot, index, attempt }: Run, started: number): void {
    this.sql.exec('INSERT OR IGNORE INTO runs (vessel, slot, idx, attempt, started) VALUES (?, ?, ?, ?, ?)', vessel, slot, index, attempt, started);
  }

  /** The run exited or was killed. */
  ended({ vessel, slot, index, attempt }: Run): void {
    this.sql.exec('DELETE FROM runs WHERE vessel = ? AND slot = ? AND idx = ? AND attempt = ?', vessel, slot, index, attempt);
  }

  /** `vessel`'s container is gone, and every run in it. */
  gone(vessel: string): void {
    this.sql.exec('DELETE FROM runs WHERE vessel = ?', vessel);
  }

  of(index: number): { vessel: string; slot: number; attempt: number; started: number }[] {
    return this.sql.exec<{ vessel: string; slot: number; attempt: number; started: number }>('SELECT vessel, slot, attempt, started FROM runs WHERE idx = ? ORDER BY started', index).toArray();
  }
}
