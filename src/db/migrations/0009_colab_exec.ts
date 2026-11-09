import type { Migration } from "../../types.js";

/** `colab_exec`: start times (ms since the epoch) of the Python runs of the last hour, so `COLAB_EXEC_MAX_PER_HOUR` survives a restart. */
export const m0009: Migration = {
  version: 9,
  name: "colab_exec",
  up(db) {
    db.run("CREATE TABLE colab_exec (ts INTEGER NOT NULL)");
    db.run("CREATE INDEX colab_exec_ts ON colab_exec (ts)");
  },
};
