import { Menu, Plugin, Notice } from 'obsidian';
import HereNowSyncPlugin from '../main';

export class StatusBarManager {
  private statusBarItem: HTMLElement;
  private lastSyncTime: number | null = null;
  private syncStartTime: number | null = null;

  constructor(private plugin: HereNowSyncPlugin) {
    this.statusBarItem = plugin.addStatusBarItem();
    this.statusBarItem.addClass('here-now-sync-status');
    this.statusBarItem.setText('☁️ here.now');
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.style.userSelect = 'none';

    this.statusBarItem.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      
      const menu = new Menu();

      // Sync Now menu item - changes to Stop Sync when syncing
      const isSyncing = this.plugin.syncEngine.getIsSyncing();
      if (isSyncing) {
        menu.addItem(item => item
          .setTitle('Stop Sync')
          .setIcon('circle-pause')
          .onClick(() => this.plugin.syncEngine.stopSync()));
      } else {
        menu.addItem(item => item
          .setTitle('Sync Now')
          .setIcon('refresh-cw')
          .onClick(() => this.plugin.syncEngine.triggerManualSync()));
      }

      menu.addItem(item => item
        .setTitle('View Sync Logs')
        .setIcon('file-text')
        .onClick(async () => {
          await this.plugin.rightPanelManager.openRightPanel();
        }));

      menu.addItem(item => item
        .setTitle('Settings')
        .setIcon('settings')
        .onClick(() => {
          (this.plugin.app as any).setting?.open();
          (this.plugin.app as any).setting?.openTabById?.(this.plugin.manifest.id);
        }));
      
      menu.showAtMouseEvent(event);

      // Click to trigger manual sync
      plugin.syncEngine.triggerManualSync();
    });
    this.updateStatus('⚪ Not synced');
  }

  /**
   * Update status bar text
   */
  updateStatus(message: string): void {
    this.statusBarItem.setText(message);
    this.statusBarItem.removeClass('syncing', 'error');
  }

  /**
   * Show sync progress with percentage
   */
  showSyncProgress(current: number, total: number): void {
    if (this.syncStartTime === null) {
      this.syncStartTime = Date.now();
    }
    
    const percent = Math.round((current / total) * 100);
    const elapsed = Math.round((Date.now() - this.syncStartTime) / 1000);
    
    this.statusBarItem.setText(`🔄 ${percent}% (${current}/${total}) • ${elapsed}s`);
    this.statusBarItem.addClass('syncing');
  }

  /**
   * Update last successful sync time
   */
  updateLastSync(timestamp: number): void {
    this.lastSyncTime = timestamp;
    this.syncStartTime = null;
    
    const timeStr = this.formatTimeAgo(timestamp);
    this.statusBarItem.setText(`✅ Synced ${timeStr}`);
    this.statusBarItem.removeClass('syncing', 'error');
  }

  /**
   * Show error state
   */
  showError(message: string): void {
    this.statusBarItem.setText(`❌ Error`);
    this.statusBarItem.addClass('error');
    
    if (this.plugin.settings.showNotifications) {
      new Notice(`Sync error: ${message}`, 6000);
    }
    
    // Auto-clear error state after 10 seconds
    setTimeout(() => {
      if (this.lastSyncTime) {
        this.updateLastSync(this.lastSyncTime);
      }
    }, 10000);
  }

  /**
   * Show detailed sync summary
   */
  showSummary(summary: {
    uploads: number;
    downloads: number;
    conflicts: number;
    duration: number;
  }): void {
    const parts = [];
    if (summary.uploads > 0) parts.push(`↑${summary.uploads}`);
    if (summary.downloads > 0) parts.push(`↓${summary.downloads}`);
    if (summary.conflicts > 0) parts.push(`⚔️${summary.conflicts}`);
    
    const message = `✅ Synced ${parts.join(' ')} in ${summary.duration}s`;
    this.updateStatus(message);
    
    if (this.plugin.settings.showNotifications) {
      new Notice(message, 4000);
    }
  }

  /**
   * Get last sync time for display
   */
  getLastSyncDisplay(): string {
    if (!this.lastSyncTime) return 'Never';
    return this.formatDateTime(this.lastSyncTime);
  }

  /**
   * Format a timestamp as a relative time string (e.g., "3 minutes ago")
   */
  private formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return this.formatDateTime(timestamp);
  }

  /**
   * Format a timestamp as a date string (e.g., "Jan 15, 14:30")
   */
  private formatDateTime(timestamp: number): string {
    const date = new Date(timestamp);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day}, ${hours}:${mins}`;
  }
}