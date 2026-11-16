import type { EngineEvents } from "./engine.js";

/*
 * Progress for the command line, on stderr so --json and --format md output stays clean.
 * In a terminal it is one line that updates in place. Anywhere else (an assistant running the
 * command, a CI log) it prints a line per event, and a "still working" line when nothing has
 * been printed for a while, so a long run never looks stuck.
 */

export interface Reporter {
  events: EngineEvents;
  /** Print the closing line and stop the timer. */
  done(summary?: string): void;
}

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function createReporter(opts: { tty?: boolean; write?: (s: string) => void; now?: () => number; heartbeatMs?: number } = {}): Reporter {
  const tty = opts.tty ?? Boolean(process.stderr.isTTY);
  const write = opts.write ?? ((s: string) => void process.stderr.write(s));
  const now = opts.now ?? Date.now;
  const started = now();
  let requests = 0;
  let current = "starting";
  let lastPrinted = now();
  const reads = new Map<string, string[]>();
  let stepsDone = 0;
  let stepsTotal = 0;
  let writingSince = 0;

  const elapsed = () => clock(now() - started);
  const left = () => {
    if (!stepsDone || stepsDone >= stepsTotal) return "";
    const per = (now() - writingSince) / stepsDone;
    return `, about ${clock(per * (stepsTotal - stepsDone))} left`;
  };
  const status = () => `[${elapsed()}] ${current} (${requests} request${requests === 1 ? "" : "s"})`;

  const show = (line: string, important = false) => {
    // In a terminal, events stay on screen as lines and the status line below keeps updating.
    if (tty) write(important ? `\r\x1b[2K${line}\n` : `\r\x1b[2K${line.slice(0, (process.stderr.columns ?? 100) - 1)}`);
    else if (important) {
      write(`${line}\n`);
      lastPrinted = now();
    }
  };

  const timer = setInterval(() => {
    if (tty) show(status());
    else if (now() - lastPrinted >= (opts.heartbeatMs ?? 10_000)) show(`[${elapsed()}] still working: ${current} (${requests} requests so far)`, true);
  }, tty ? 250 : 1000);
  timer.unref?.();

  return {
    events: {
      request: () => {
        requests++;
        if (tty) show(status());
      },
      read: (store, kind, items) => {
        const list = [...(reads.get(store) ?? []), `${kind} ${items}`];
        reads.set(store, list);
        current = `reading ${store}: ${list.join(", ")}`;
        show(`[${elapsed()}] read ${store}: ${kind} (${items} item${items === 1 ? "" : "s"})`, true);
      },
      phase: (message) => {
        if (message.startsWith("writing")) writingSince = now();
        current = message;
        show(`[${elapsed()}] ${message}`, true);
      },
      bulk: (kind, written, total) => {
        // Status line only: Shopify reports this every few seconds.
        current = `Shopify is writing ${kind} in bulk: about ${written} of ${total}`;
        if (tty) show(status());
      },
      step: (done, total, message) => {
        if (!writingSince) writingSince = now();
        stepsDone = done;
        stepsTotal = total;
        current = `writing ${done}/${total}${left()}: ${message}`;
        show(`[${elapsed()}] ${current}`, true);
      },
    },
    done(summary) {
      clearInterval(timer);
      const line = `[${elapsed()}] done${summary ? `: ${summary}` : ""}, ${requests} request${requests === 1 ? "" : "s"}`;
      if (tty) write(`\r\x1b[2K${line}\n`);
      else write(`${line}\n`);
    },
  };
}
