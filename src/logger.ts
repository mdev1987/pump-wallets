import { appendFile, mkdir } from 'node:fs/promises';

/**
 * Small file + console logger.
 *
 * Every token gets its own log file while all messages are also copied into a
 * global scanner log. Errors additionally go to a dedicated error log.
 */
export class Logger {
  private readonly globalFile: string;
  private readonly tokenFile?: string;
  private readonly errorFile: string;

  constructor(private readonly dir: string, token?: string) {
    this.globalFile = `${dir}/scanner.log`;
    this.errorFile = `${dir}/errors.log`;
    this.tokenFile = token ? `${dir}/token-${token}.log` : undefined;
  }

  static async create(dir: string, token?: string): Promise<Logger> {
    await mkdir(dir, { recursive: true });
    return new Logger(dir, token);
  }

  child(token: string): Logger {
    return new Logger(this.dir, token);
  }

  info(message: string): Promise<void> {
    return this.write('INFO', message);
  }

  warn(message: string): Promise<void> {
    return this.write('WARN', message);
  }

  error(message: string, error?: unknown): Promise<void> {
    const detail = error instanceof Error ? `${message}: ${error.message}` : message;
    const line = this.format('ERROR', detail);
    console.error(line);
    return Promise.all([
      appendFile(this.globalFile, `${line}\n`),
      appendFile(this.errorFile, `${line}\n`),
      this.tokenFile ? appendFile(this.tokenFile, `${line}\n`) : Promise.resolve(),
    ]).then(() => undefined);
  }

  private write(level: 'INFO' | 'WARN', message: string): Promise<void> {
    const line = this.format(level, message);
    if (level === 'WARN') console.warn(line);
    else console.log(line);
    return Promise.all([
      appendFile(this.globalFile, `${line}\n`),
      this.tokenFile ? appendFile(this.tokenFile, `${line}\n`) : Promise.resolve(),
    ]).then(() => undefined);
  }

  private format(level: string, message: string): string {
    return `${new Date().toISOString()} | ${level} | ${message}`;
  }
}
