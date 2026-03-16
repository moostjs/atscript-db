export interface TGenericLogger {
  error(...messages: any[]): void;
  warn(...messages: any[]): void;
  log(...messages: any[]): void;
  info(...messages: any[]): void;
  debug(...messages: any[]): void;
}
export const NoopLogger: TGenericLogger = {
  error: () => {},
  warn: () => {},
  log: () => {},
  info: () => {},
  debug: () => {},
};
