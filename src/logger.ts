type LogFn = (level: "debug" | "info" | "warning" | "error", message: string) => void;

let _log: LogFn = (_level, message) => {
  process.stderr.write(`${message}\n`);
};

export function setLogger(fn: LogFn): void {
  _log = fn;
}

export function log(level: "debug" | "info" | "warning" | "error", message: string): void {
  _log(level, message);
}
