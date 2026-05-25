import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import HereNowSyncPlugin from '../main';
import { SyncLogger, LogEntry } from '../utils/logger';

export const RIGHT_PANEL_VIEW_TYPE = 'here-now-sync-right-panel';

export class RightPanelManager {
  private plugin: HereNowSyncPlugin;

  constructor(plugin: HereNowSyncPlugin) {
    this.plugin = plugin;
  }

  /**
   * Register the view type with Obsidian
   */
  registerView(): void {
    this.plugin.registerView(
      RIGHT_PANEL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new RightPanelView(leaf, this.plugin)
    );
  }

  /**
   * Open the right panel
   */
  async openRightPanel(): Promise<void> {
    // Check if the view is already open
    const existingLeaves = this.plugin.app.workspace.getLeavesOfType(RIGHT_PANEL_VIEW_TYPE);
    
    if (existingLeaves.length > 0) {
      // Reveal existing view
      this.plugin.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    // Create new leaf in right sidebar
    const leaf = this.plugin.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: RIGHT_PANEL_VIEW_TYPE,
        active: true,
      });
      // Reveal the new leaf
      this.plugin.app.workspace.revealLeaf(leaf);
    } else {
      new Notice('⚠️ Could not open right panel');
    }
  }

  /**
   * Close the right panel
   */
  closeRightPanel(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType(RIGHT_PANEL_VIEW_TYPE);
    leaves.forEach(leaf => leaf.detach());
  }

  /**
   * Refresh the panel content (call after sync operations)
   */
  refreshPanel(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType(RIGHT_PANEL_VIEW_TYPE);
    leaves.forEach(leaf => {
      if (leaf.view instanceof RightPanelView) {
        leaf.view.refresh();
      }
    });
  }
}

export class RightPanelView extends ItemView {
  private plugin: HereNowSyncPlugin;
  private logContainer: HTMLElement | null = null;
  private syncButton: HTMLButtonElement | null = null;
  private clearButton: HTMLButtonElement | null = null;
  private settingsButton: HTMLButtonElement | null = null;
  private statusIndicator: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: HereNowSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return RIGHT_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'here.now Sync';
  }

  getIcon(): string {
    return 'sync';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();

    // Header with title
    const header = container.createEl('div', { cls: 'here-now-panel-header' });
    header.createEl('h3', { text: 'here.now Sync' });

    // Action buttons row
    const buttonRow = container.createEl('div', { cls: 'here-now-button-row' });
    
    // Sync button
    this.syncButton = buttonRow.createEl('button', { 
      cls: 'here-now-btn here-now-btn-primary',
      text: '🔄 Sync'
    });
    this.syncButton.addEventListener('click', async () => {
      await this.handleSyncClick();
    });

    // Clear logs button
    this.clearButton = buttonRow.createEl('button', { 
      cls: 'here-now-btn here-now-btn-secondary',
      text: '🗑️ Clear'
    });
    this.clearButton.addEventListener('click', () => {
      this.handleClearClick();
    });

    // Settings button (icon only)
    this.settingsButton = buttonRow.createEl('button', { 
      cls: 'here-now-btn here-now-btn-icon',
      attr: { 'aria-label': 'Settings' }
    });
    this.settingsButton.innerHTML = '⚙️';
    this.settingsButton.addEventListener('click', () => {
      this.handleSettingsClick();
    });

    // Status indicator
    this.statusIndicator = container.createEl('div', { 
      cls: 'here-now-status-indicator',
      text: 'Ready'
    });

    // Filter buttons
    const filterRow = container.createEl('div', { cls: 'here-now-filter-row' });
    const allFilter = filterRow.createEl('button', { 
      cls: 'here-now-filter-btn active',
      'data-filter': 'all',
      text: 'All'
    });
    const errorsFilter = filterRow.createEl('button', { 
      cls: 'here-now-filter-btn',
      'data-filter': 'error',
      text: '❌ Errors'
    });
    const warningsFilter = filterRow.createEl('button', { 
      cls: 'here-now-filter-btn',
      'data-filter': 'warn',
      text: '⚠️ Warnings'
    });

    // Add filter click handlers
    [allFilter, errorsFilter, warningsFilter].forEach(btn => {
      btn.addEventListener('click', (e) => {
        filterRow.querySelectorAll('.here-now-filter-btn').forEach(b => b.classList.remove('active'));
        (e.target as HTMLElement).classList.add('active');
        this.renderLogs((e.target as HTMLElement).dataset.filter || 'all');
      });
    });

    // Log container
    this.logContainer = container.createEl('div', { cls: 'here-now-log-container' });
    
    // Initial render
    this.renderLogs('all');

    // Auto-refresh every second when panel is open
    this.registerInterval(window.setInterval(() => {
      const activeFilter = filterRow.querySelector('.here-now-filter-btn.active')?.dataset.filter || 'all';
      this.updateSyncButtonState();
    }, 1000));
  }

  async onClose(): Promise<void> {
    // Cleanup
    const container = this.containerEl.children[1];
    container.empty();
  }

  /**
   * Refresh the panel content
   */
  refresh(): void {
    const activeFilter = this.containerEl.querySelector('.here-now-filter-btn.active')?.dataset.filter || 'all';
    this.renderLogs(activeFilter);
  }

  private async handleSyncClick(): Promise<void> {
    if (this.plugin.syncEngine.getIsSyncing()) {
      this.plugin.syncEngine.stopSync();
      return;
    }

    try {
      await this.plugin.syncEngine.triggerManualSync();
      
      if (this.statusIndicator) {
        this.statusIndicator.setText('✅ Sync completed');
        this.statusIndicator.removeClass('syncing');
        this.statusIndicator.addClass('success');
      }
    } catch (error: any) {
      if (this.statusIndicator) {
        this.statusIndicator.setText(`❌ Sync failed: ${error.message}`);
        this.statusIndicator.removeClass('syncing');
        this.statusIndicator.addClass('error');
      }
    } finally {
      // Reset status after delay
      setTimeout(() => {
        if (this.statusIndicator) {
          this.statusIndicator.setText('Ready');
          this.statusIndicator.removeClass('success', 'error');
        }
      }, 3000);
    }
  }

  private handleClearClick(): void {
    SyncLogger.clear();
    this.renderLogs('all');
    new Notice('🗑️ Sync logs cleared');
  }

  private handleSettingsClick(): void {
    // Open the plugin settings tab
    (this.plugin.app as any).setting?.open();
    (this.plugin.app as any).setting?.openTabById?.(this.plugin.manifest.id);
  }

  /**
   * Update sync button state based on sync progress
   */
  private updateSyncButtonState(): void {
    if (!this.syncButton) return;

    const isSyncing = this.plugin.syncEngine.getIsSyncing();
    if (isSyncing) {
      this.syncButton.setText('⏹️ Stop Sync');
      this.syncButton.addClass('here-now-btn-stop');
      // Change click handler to stop sync
      this.syncButton.onclick = async () => {
        this.plugin.syncEngine.stopSync();
        this.updateSyncButtonState();
      };
    } else {
      this.syncButton.setText('🔄 Sync');
      this.syncButton.removeClass('here-now-btn-stop');
      this.syncButton.onclick = async () => {
        await this.handleSyncClick();
      };
    }
  }  
  
  private renderLogs(filter: string): void {
    if (!this.logContainer) return;

    this.logContainer.empty();

    let logs: LogEntry[];
    
    if (filter === 'all') {
      logs = SyncLogger.getRecent(50);
    } else if (filter === 'error') {
      logs = SyncLogger.getErrors();
    } else if (filter === 'warn') {
      logs = SyncLogger.getLogs().filter(l => l.level === 'warn');
    } else {
      logs = [];
    }

    if (logs.length === 0) {
      const emptyMsg = this.logContainer.createEl('div', { 
        cls: 'here-now-empty-logs',
        text: filter === 'all' ? 'No sync logs available' : `No ${filter} logs`
      });
      return;
    }

    // Render logs in reverse order (newest first)
    logs.reverse().forEach(entry => {
      const logItem = this.createLogItem(entry);
      this.logContainer?.appendChild(logItem);
    });
  }

  private createLogItem(entry: LogEntry): HTMLElement {
    const item = document.createElement('div');
    item.className = `here-now-log-item here-now-log-${entry.level}`;
    
    // Icon based on level
    const icon = entry.level === 'error' ? '❌' : entry.level === 'warn' ? '⚠️' : 'ℹ️';
    
    // Time
    const time = new Date(entry.timestamp).toLocaleTimeString();
    
    // Category badge
    const category = entry.category;
    
    // Main row (clickable)
    const mainRow = item.createEl('div', { cls: 'here-now-log-main' });
    mainRow.createEl('span', { cls: 'here-now-log-icon', text: icon });
    mainRow.createEl('span', { cls: 'here-now-log-time', text: time });
    mainRow.createEl('span', { cls: 'here-now-log-category', text: category });
    mainRow.createEl('span', { cls: 'here-now-log-message', text: entry.message });

    // Details section (hidden by default)
    const detailsSection = item.createEl('div', { cls: 'here-now-log-details' });
    
    if (entry.data) {
      const dataPre = detailsSection.createEl('pre', { 
        cls: 'here-now-log-data',
        text: JSON.stringify(entry.data, null, 2)
      });
    }

    // Toggle details on click
    mainRow.style.cursor = 'pointer';
    mainRow.addEventListener('click', () => {
      const isExpanded = detailsSection.hasClass('expanded');
      if (isExpanded) {
        detailsSection.removeClass('expanded');
        detailsSection.style.display = 'none';
      } else {
        detailsSection.addClass('expanded');
        detailsSection.style.display = 'block';
      }
    });

    return item;
  }
}
