// The terminal UI: one spinner line on stderr — braille frames, the
// elapsed seconds, and the service's own stage labels. stderr carries
// every message and warning; stdout carries only the reply, so
// `ommisa ask "…" > answer.txt` stays clean.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(out = process.stderr) {
  if (!out.isTTY) {
    let last = "";
    return {
      stage(label) {
        if (label && label !== last) {
          last = label;
          out.write(`· ${label}\n`);
        }
      },
      done() {},
    };
  }
  let i = 0;
  let label = "Thinking";
  const started = Date.now();
  const timer = setInterval(() => {
    const s = ((Date.now() - started) / 1000).toFixed(0);
    out.write(`\r${FRAMES[i++ % FRAMES.length]} ${label}… ${s}s`);
  }, 80);
  return {
    stage(l) {
      if (l == null) {
        clearInterval(timer);
        out.write("\r" + " ".repeat(60) + "\r");
        return;
      }
      label = l;
    },
    done() {
      clearInterval(timer);
      out.write("\r" + " ".repeat(60) + "\r");
    },
  };
}

/** For whole-payload answers (cache hits arrive as one blob): a fast
 *  typewriter so cached replies still read as streaming — capped at
 *  ~1.5 s regardless of length. */
export function writeAnimated(text, out = process.stdout) {
  return new Promise((resolve) => {
    const total = text.length;
    const step = Math.max(1, Math.ceil(total / 160));
    let i = 0;
    const t = setInterval(() => {
      i = Math.min(total, i + step);
      out.write(text.slice(Math.max(0, i - step), i));
      if (i >= total) {
        clearInterval(t);
        resolve();
      }
    }, 8);
  });
}
