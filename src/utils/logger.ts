/**
 * Persistent sync logger - logs errors and events to console and a dedicated log array
 * that can be viewed in the plugin's debug UI or exported for troubleshooting.
 */

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: any;
}

export class SyncLogger {
  private static logs: LogEntry[] = [];
  private static readonly MAX_LOGS = 500;

  static log(category: string, message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: 'info',
      category,
      message
    };
    if (data !== undefined) entry.data = data;
    
    this.addEntry(entry);
    console.log(`[here.now][${category}] ${message}`);
  }

  static warn(category: string, message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: 'warn',
      category,
      message
    };
    if (data !== undefined) entry.data = data;
    
    this.addEntry(entry);
    console.warn(`[here.now][${category}] ⚠️ ${message}`);
  }

  static error(category: string, message: string, data?: any): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: 'error',
      category,
      message
    };
    if (data !== undefined) entry.data = data;
    
    this.addEntry(entry);
    console.error(`[here.now][${category}] ❌ ${message}`);
  }

  private static addEntry(entry: LogEntry): void {
    this.logs.push(entry);
    // Keep log size bounded
    if (this.logs.length > this.MAX_LOGS) {
      this.logs = this.logs.slice(-this.MAX_LOGS);
    }
  }

  /**
   * Get all log entries
   */
  static getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Get only error entries
   */
  static getErrors(): LogEntry[] {
    return this.logs.filter(l => l.level === 'error');
  }

  /**
   * Get recent entries
   */
  static getRecent(count: number = 50): LogEntry[] {
    return this.logs.slice(-count);
  }

  /**
   * Clear all logs
   */
  static clear(): void {
    this.logs = [];
    console.log('[here.now] Logs cleared');
  }

  /**
   * Export logs as formatted text for sharing/debugging
   */
  static exportAsText(): string {
    const header = '=== here.now Sync Logs ===\n';
    const lines = this.logs.map(entry => {
      const date = new Date(entry.timestamp).toISOString();
      return `[${date}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}${entry.data ? '\n  Data: ' + JSON.stringify(entry.data, null, 2) : ''}`;
    });
    return header + lines.join('\n');
  }
}