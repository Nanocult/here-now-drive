import { Plugin, Notice, Menu, TFile, TAbstractFile, TFolder } from 'obsidian';
import { HereNowSyncSettings, DEFAULT_SETTINGS, HereNowSyncSettingTab } from './settings';
import { AuthManager } from './auth';
import { SyncEngine } from './sync/SyncEngine';
import { StatusBarManager } from './ui/StatusBarManager';
import { OfflineQueue } from './sync/OfflineQueue';
import { TrashManager } from './sync/TrashManager';
import { SyncLogger, LogEntry } from './utils/logger';
import { RightPanelManager } from './ui/RightPanelManager';

import { DriveAPI } from './api/DriveAPI';

export default class HereNowSyncPlugin extends Plugin {
  settings: HereNowSyncSettings;
  
  // Core components
  authManager: AuthManager;
  syncEngine: SyncEngine;
  statusBar: StatusBarManager;
  offlineQueue: OfflineQueue;
  trashManager: TrashManager;
  rightPanelManager: RightPanelManager;
  
  // State
  private syncIntervalId: number | null = null;
  private isSyncing = false;

  async onload() {
    await this.loadSettings();
    
    // Initialize managers
    this.authManager = new AuthManager(this);
    this.trashManager = new TrashManager(this);
    this.statusBar = new StatusBarManager(this);
    this.offlineQueue = new OfflineQueue(this);
    this.syncEngine = new SyncEngine(this);
    this.rightPanelManager = new RightPanelManager(this);
    
    // Register the right panel view
    this.rightPanelManager.registerView();

    // Register ribbon icon - opens the right panel
    this.addRibbonIcon('sync', 'here.now Sync Panel', async () => {
      await this.rightPanelManager.openRightPanel();
    });
    
    // Register settings tab
    this.addSettingTab(new HereNowSyncSettingTab(this.app, this));
    
    // Register commands
    this.addCommands();
    
    // Register file event listeners
    this.registerVaultEvents();
    
    // Start periodic sync timer (if enabled)
    this.startPeriodicSync();

    // Initial sync after layout ready (if API key configured)
    this.app.workspace.onLayoutReady(async () => {
      // Check if sync is enabled
      if (!this.settings.syncEnabled) {
        console.log('⏭️ Startup sync skipped: sync disabled in settings');
        return;
      }

      // Check if offline queue is enabled (required for auto-sync)
      if (!this.settings.enableOfflineQueue) {
        console.log('⏭️ Startup sync skipped: offline queue disabled');
        return;
      }

      if (await this.authManager.hasValidKey() && this.settings.syncEnabled) {
        // Small delay to let vault fully load
        setTimeout(async () => {
          await this.syncEngine.triggerSync({ 
            source: 'startup', 
            full: true // Full sync on first run after startup
          });
        }, 2000);
      }
    });
    
    // Listen for online/offline events
    window.addEventListener('online', () => {
      this.statusBar.updateStatus('🌐 Back online - syncing queued changes...');
      this.offlineQueue.processQueue();
    });

    window.addEventListener('offline', () => {
      this.statusBar.updateStatus('📴 Offline - changes will sync when reconnected');
    });
    
    // Expose SyncLogger to window for diagnostics in settings
    (window as any).SyncLogger = SyncLogger;
    
    this.AddContextMenu();
    
    console.log('✅ here.now Sync plugin loaded');
  }

  async onunload() {
    // Clean up periodic sync timer
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    
    // Cancel any ongoing sync operations
    this.syncEngine.cancelOngoingSync();
    
    console.log('🔌 here.now Sync plugin unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Restart periodic sync if interval changed
    this.startPeriodicSync();
  }

  private AddContextMenu() {
    // Add file context menu
    this.registerEvent(this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
      menu.addSeparator();
      menu.addItem((item) => {
        item.setTitle(`🔄 Sync "${file.name}"`)
          .setIcon('sync')
          .onClick(async () => {
            await this.syncEngine.triggerScopedSync(file);
          });
      });
    }));

    // Editor context menu
    this.registerEvent(this.app.workspace.on('editor-menu', (menu: Menu) => {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        menu.addSeparator();
        menu.addItem((item) => {
          item.setTitle(`🔄 Sync "${activeFile.name}"`)
              .setIcon('sync')
              .onClick(async () => {
                await this.syncEngine.triggerScopedSync(activeFile);
              });
        });
      }
    }));
  }
  
  private addCommands() {
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now with here.now',
      callback: async () => {
        if (!(await this.authManager.hasValidKey())) {
          new Notice('⚠️ Please configure your here.now API key first');
          return;
        }
        await this.syncEngine.triggerManualSync();
      }
    });
    
    this.addCommand({
      id: 'toggle-sync',
      name: 'Toggle periodic sync',
      callback: () => {
        this.settings.syncEnabled = !this.settings.syncEnabled;
        this.saveSettings();
        new Notice(`Periodic sync ${this.settings.syncEnabled ? 'enabled' : 'disabled'}`);
      }
    });
    
    this.addCommand({
      id: 'publish-to-site',
      name: 'Publish current vault to here.now Site',
      callback: async () => {
        // 🔒 Restriction: Validate site slug before proceeding
        if (!this.settings.siteSlug || this.settings.siteSlug.trim() === '') {
          new Notice('⚠️ Site slug not configured. Please set it in plugin settings.', 5000);
          
          // UX: Open settings tab for quick configuration
          (this.app as any).setting?.open();
          (this.app as any).setting?.openTabById?.(this.manifest.id);
          return;
        }

        await this.syncEngine.publishToSite();
      }
    });
    
    // Note: Log viewing/clearing moved to right panel
    // These commands now just open the right panel or export to file
    this.addCommand({
      id: 'view-sync-logs',
      name: 'View sync logs (opens right panel)',
      callback: async () => {
        await this.rightPanelManager.openRightPanel();
      }
    });
    
    this.addCommand({
      id: 'export-all-sync-logs',
      name: 'Export all sync logs to file',
      callback: async () => {
        const text = SyncLogger.exportAsText();
        const logs = SyncLogger.getLogs();
        
        if (logs.length === 0) {
          new Notice('📋 No logs to export', 3000);
          return;
        }
        
        // Create a new note with the logs
        const fileName = `sync-logs-${new Date().toISOString().split('T')[0]}.md`;
        try {
          await this.app.vault.create(fileName, `# here.now Sync Logs\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`\n${text}\n\`\`\``);
          new Notice(`📋 Exported ${logs.length} log entries to ${fileName}`, 5000);
        } catch (error: any) {
          new Notice(`❌ Failed to export logs: ${error.message}`, 5000);
        }
      }
    });
    
    this.addCommand({
      id: 'clear-sync-logs',
      name: 'Clear sync logs',
      callback: () => {
        SyncLogger.clear();
        this.rightPanelManager.refreshPanel();
        new Notice('🗑️ Sync logs cleared', 3000);
      }
    });

    this.addCommand({
      id: 'test-batch-upload',
      name: 'Test batch upload to here.now',
      callback: async () => {
        const apiKey = await this.authManager.getApiKey();
        if (!apiKey) {
          new Notice('❌ No API key configured');
          return;
        }
        
        const driveApi = new DriveAPI(this, apiKey);
        const driveId = (await driveApi.getDefaultDrive()).id;
        
        const testContent = new TextEncoder().encode(
          `# Test Upload\n\nTimestamp: ${new Date().toISOString()}\n\nThis is a test of the batch commit workflow.`
        );
        
        try {
          new Notice('🔄 Testing batch upload...');
          const result = await driveApi.uploadFile(
            driveId,
            `test-batch/${Date.now()}.md`,
            testContent.buffer,
            'text/markdown; charset=utf-8'
          );
          new Notice(`✅ Batch upload successful: ${result.path}`);
          console.log('📦 Upload result:', result);
        } catch (e: any) {
          new Notice(`❌ Batch upload failed: ${e.message}`);
          console.error('🔥 Upload error:', e);
        }
      }
    });
  }

  private registerVaultEvents() {
    // Handle file creation
    this.registerEvent(
      this.app.vault.on('create', async (file) => {
        if (file instanceof TFile && this.trashManager.isSyncable(file.path)) {
          this.offlineQueue.enqueue({ type: 'upload', file });
        }
      })
    );
    
    // Handle file modification
    this.registerEvent(
      this.app.vault.on('modify', async (file) => {
        if (file instanceof TFile && this.trashManager.isSyncable(file.path)) {
          this.offlineQueue.enqueue({ type: 'upload', file });
        }
      })
    );
    
    // Handle file deletion - move to trash instead of remote delete
    this.registerEvent(
      this.app.vault.on('delete', async (file) => {
        if (file instanceof TFile) {
          // Note: file is already deleted, so we can't move it
          // Instead, we should intercept before deletion via a custom delete command
          // For now, log that remote cleanup may be needed
          console.log(`🗑️ File deleted locally: ${file.path} (remote cleanup pending)`);
        }
      })
    );
    
    // Handle file rename
    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && this.trashManager.isSyncable(file.path)) {
          // Treat rename as delete old + create new
          this.offlineQueue.enqueue({ type: 'delete-remote', path: oldPath });
          this.offlineQueue.enqueue({ type: 'upload', file });
        }
      })
    );
  }

  private startPeriodicSync() {
    // Clear existing interval
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    
    // Only start if sync is enabled and API key is configured
    if (!this.settings.syncEnabled) {
      console.log('⏭️ Periodic sync disabled in settings');
      return;
    }

    // Also check if offline queue is disabled - if so, don't run startup sync
    if (!this.settings.enableOfflineQueue) {
      console.log('⏭️ Offline queue disabled - skipping automatic sync on startup');
    }
    
    const intervalMinutes = this.settings.syncIntervalMinutes;
    const intervalMs = intervalMinutes * 60 * 1000;
    
    this.syncIntervalId = window.setInterval(async () => {
      if (this.isSyncing) {
        console.log('⏭️ Skipping periodic sync - another sync is in progress');
        return;
      }
      
      if (!(await this.authManager.hasValidKey())) {
        console.log('⏭️ Skipping periodic sync - no valid API key');
        return;
      }
      
      await this.syncEngine.triggerSync({ source: 'timer', full: false });
    }, intervalMs);
    
    console.log(`⏱️ Periodic sync started: every ${intervalMinutes} minutes`);
  }

  // Helper: Check if a path should be excluded from sync
  shouldExcludePath(path: string): boolean {
    // Always exclude trash folder
    if (path.startsWith(this.settings.trashFolderName + '/')) {
      return true;
    }
    
    // Always exclude Obsidian config
    if (path.startsWith('.obsidian/')) {
      return true;
    }
    
    // Check user-defined exclude patterns
    if (this.settings.excludedPatterns.some(pattern => {
      // Simple glob matching - in production, use minimatch library
      const regex = new RegExp(
        pattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
      );
      return regex.test(path);
    })) {
      return true;
    }
    
    // Check if sync scope is limited to specific folders
    if (this.settings.syncScope === 'specific-folders' && this.settings.includedFolders.length > 0) {
      return !this.settings.includedFolders.some(folder => 
        path === folder || path.startsWith(folder + '/')
      );
    }
    
    return false;
  }
}