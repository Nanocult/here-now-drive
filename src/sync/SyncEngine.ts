import { TFile, TFolder, TAbstractFile, Notice } from 'obsidian';
import HereNowSyncPlugin from '../main';
import { DriveAPI } from '../api/DriveAPI';
import { SitesAPI } from '../api/SitesAPI';
import { HereNowFile, SiteInfo } from '../api/HereNowAPI';
import { computeFileHash } from '../utils/hash';
import { normalizePath } from '../utils/path';
import { SyncLogger } from '../utils/logger';

export type SyncOperation = 
  | { type: 'upload'; file: TFile }
  | { type: 'download'; remoteFile: HereNowFile }
  | { type: 'delete-remote'; path: string }
  | { type: 'move-to-trash'; path: string };

export interface SyncPlan {
  operations: SyncOperation[];
  summary: {
    uploads: number;
    downloads: number;
    deletes: number;
    conflicts: number;
  };
  timestamp: number;
}

export interface SyncOptions {
  source: 'manual' | 'timer' | 'startup' | 'event' | 'queue';
  full?: boolean; // Force full sync vs incremental
}

export class SyncEngine {
  private driveApi!: DriveAPI;
  private sitesApi!: SitesAPI;
  private checksumCache: Map<string, string> = new Map();
  private remoteFilesCache: Map<string, HereNowFile> = new Map();
  private isSyncing = false;
  private abortController: AbortController | null = null;


  getIsSyncing(): boolean {
    return this.isSyncing;
  }

  stopSync(): void {
    if (this.abortController) {
      this.abortController.abort();
      SyncLogger.log('Sync', 'Sync stopped by user');
      this.isSyncing = false;
      this.abortController = null;
      this.plugin.statusBar.updateStatus('⏹️ Sync stopped');
      this.plugin.rightPanelManager.refreshPanel();
    } else {
      this.isSyncing = false;
      this.plugin.statusBar.updateStatus('⏹️ Sync stopped');
      this.plugin.rightPanelManager.refreshPanel();
    }
  }

  constructor(private plugin: HereNowSyncPlugin) {}

  private async initAPIs(): Promise<boolean> {
    const apiKey = await this.plugin.authManager.getApiKey();
    if (!apiKey) {
      SyncLogger.error('Sync', 'Cannot initialize APIs: no API key');
      return false;
    }
    
    this.driveApi = new DriveAPI(this.plugin, apiKey);
    this.sitesApi = new SitesAPI(this.plugin, apiKey);
    return true;
  }

  /**
   * Trigger manual sync from UI/command
   */
  async triggerManualSync(): Promise<void> {
    if (this.isSyncing) {
      new Notice('⏳ Sync already in progress...');
      return;
    }
    
    if (!(await this.plugin.authManager.hasValidKey())) {
      new Notice('⚠️ Please configure your here.now API key first');
      return;
    }
    
    await this.triggerSync({ source: 'manual', full: true });
  }

  /**
   * Resolve the drive ID to use (auto-discover default Drive if none configured)
   */
  private async resolveDriveId(): Promise<string> {
    const configuredId = this.plugin.settings.driveId;
    if (configuredId && configuredId.length > 0) {
      SyncLogger.log('Sync', `Using configured Drive ID: ${configuredId}`);
      return configuredId;
    }
    
    SyncLogger.log('Sync', 'No Drive ID configured, auto-discovering default Drive...');
    const defaultDrive = await this.driveApi.getDefaultDrive();
    SyncLogger.log('Sync', `Auto-discovered Drive: ${JSON.stringify(defaultDrive)}`);
    
    // Save the discovered drive ID so subsequent syncs use it
    this.plugin.settings.driveId = defaultDrive.id;
    await this.plugin.saveSettings();
    
    return defaultDrive.id;
  }

  /**
   * Main sync entry point
   */
  async triggerSync(options: SyncOptions): Promise<void> {
    if (this.isSyncing) {
      SyncLogger.log('Sync', 'Sync already running, skipping');
      return;
    }

    if (!(await this.plugin.authManager.hasValidKey())) {
      SyncLogger.log('Sync', 'No valid API key, skipping sync');
      return;
    }

    this.isSyncing = true;
    this.abortController = new AbortController();
    this.plugin.statusBar.updateStatus('🔄 Starting sync...');
    SyncLogger.log('Sync', `Sync triggered (source: ${options.source}, full: ${options.full || false})`);

    try {
      // Initialize APIs
      if (!await this.initAPIs()) {
        throw new Error('Failed to initialize here.now APIs');
      }

      // Resolve Drive ID (auto-discover if not configured)
      const driveId = await this.resolveDriveId();
      SyncLogger.log('Sync', `Using Drive ID: ${driveId}`);
      this.plugin.statusBar.updateStatus(`🔄 Drive: ${driveId}`);

      // Step 1: Fetch remote files for comparison
      this.plugin.statusBar.updateStatus('🔍 Fetching remote files...');
      const remoteFiles = await this.fetchAllRemoteFiles(driveId);
      SyncLogger.log('Sync', `Found ${remoteFiles.size} remote files`);

      // Step 2: Detect changes by comparing local vs remote
      this.plugin.statusBar.updateStatus('🔍 Comparing files...');
      const plan = await this.detectChanges(remoteFiles);

      if (plan.operations.length === 0) {
        SyncLogger.log('Sync', 'No changes detected, vault is up to date');
        this.plugin.statusBar.updateLastSync(Date.now());
        new Notice('✅ Vault is up to date', 3000);
        return;
      }

      SyncLogger.log('Sync', `Sync plan: ${plan.summary.uploads} uploads, ${plan.summary.downloads} downloads, ${plan.summary.conflicts} conflicts`);

      // Step 3: Execute the sync plan
      await this.executeSyncPlan(driveId, plan);

      // Step 4: Auto-publish to Site if enabled
      if (this.plugin.settings.autoPublishToSite && 
          this.plugin.settings.siteSlug &&
          plan.summary.uploads > 0) {
        SyncLogger.log('Sync', 'Auto-publishing to Site...');
        await this.publishToSite();
      }

      // Update UI
      this.plugin.statusBar.updateLastSync(Date.now());
      const msg = `✅ Synced: ${plan.summary.uploads}↑ ${plan.summary.downloads}↓`;
      SyncLogger.log('Sync', `Sync completed: ${msg}`);
      if (this.plugin.settings.showNotifications) {
        new Notice(msg, 4000);
      }

    } catch (error: any) {
      const errorMsg = error.message || String(error);
      SyncLogger.error('Sync', `Sync failed: ${errorMsg}`, { source: options.source, error });
      this.plugin.statusBar.showError(errorMsg);
      if (this.plugin.settings.showNotifications) {
        new Notice(`❌ Sync error: ${errorMsg}`, 8000);
      }
    } finally {
      this.isSyncing = false;
      this.abortController = null;
    }
  }

  /**
   * Fetch all syncable remote files from Drive
   */
  private async fetchAllRemoteFiles(driveId: string): Promise<Map<string, HereNowFile>> {
    const remoteFiles = new Map<string, HereNowFile>();
    
    const files = await this.driveApi.listFiles(driveId);
    SyncLogger.log('Sync', `Drive returned ${files.length} files`);
    
    for (const file of files) {
      // Skip trash folder on remote
      if (file.path.startsWith('.trash/')) continue;
      
      // Only sync files in included scope
      if (this.plugin.shouldExcludePath(file.path)) continue;
      
      remoteFiles.set(file.path, file);
    }
    
    // Update cache
    this.remoteFilesCache = remoteFiles;
    return remoteFiles;
  }

  async triggerScopedSync(target: TAbstractFile): Promise<void> {
    if (this.isSyncing) {
      new Notice('⏳ Sync already in progress...');
      return;
    }
    if (!(await this.plugin.authManager.hasValidKey())) {
      new Notice('⚠️ Please configure your here.now API key first');
      return;
    }

    this.isSyncing = true;
    this.abortController = new AbortController();
    this.plugin.statusBar.updateStatus(`🔄 Syncing ${target.name}...`);

    try {
      if (!await this.initAPIs()) throw new Error('API initialization failed');
      const driveId = this.plugin.settings.driveId || (await this.driveApi.getDefaultDrive()).id;

      if (target instanceof TFile) {
        await this.syncSingleFile(driveId, target);
      } else if (target instanceof TFolder) {
        await this.syncFolderContents(driveId, target);
      }

      this.plugin.statusBar.updateLastSync(Date.now());
      new Notice(`✅ Successfully synced ${target.name}`, 3000);
    } catch (error: any) {
      this.plugin.statusBar.showError(error.message);
      new Notice(`❌ Sync failed: ${error.message}`, 5000);
    } finally {
      this.isSyncing = false;
      this.abortController = null;
    }
  }

  private async syncSingleFile(driveId: string, file: TFile): Promise<void> {
    if (!this.plugin.trashManager.isSyncable(file.path)) return;

    const localHash = await computeFileHash(this.plugin.app.vault, file);
    let remoteFile: HereNowFile | null = null;
    
    try {
      remoteFile = await this.driveApi.getFileMetadata(driveId, file.path);
    } catch (e) { /* File doesn't exist remotely */ }

    if (!remoteFile) {
      await this.executeUpload(driveId, file);
    } else if (remoteFile.hash !== localHash) {
      const action = await this.resolveConflict(file, remoteFile, localHash);
      if (action === 'upload') await this.executeUpload(driveId, file);
      else if (action === 'download') await this.executeDownload(driveId, remoteFile);
      else if (action === 'keep-both') await this.createConflictCopy(file, remoteFile);
    }
    // If hashes match, do nothing (already in sync)
  }

  private async syncFolderContents(driveId: string, folder: TFolder): Promise<void> {
    const folderPath = folder.path;
    const filesInFolder = this.plugin.app.vault.getFiles().filter(f => 
      f.path.startsWith(folderPath + '/')
    );

    for (const file of filesInFolder) {
      if (this.abortController?.signal.aborted) break;
      await this.syncSingleFile(driveId, file);
    }
  }

  /**
   * Detect changes between local vault and remote Drive
   */
  private async detectChanges(remoteFiles: Map<string, HereNowFile>): Promise<SyncPlan> {
    const operations: SyncOperation[] = [];
    const summary = { uploads: 0, downloads: 0, deletes: 0, conflicts: 0 };
    
    // Get all local files that should be synced
    const localFiles = await this.getLocalFiles();
    SyncLogger.log('Sync', `Local files to check: ${localFiles.size}`);

    // Compare: local file vs remote counterpart
    for (const [path, localFile] of localFiles) {
      const remoteFile = remoteFiles.get(path);
      
      // Read local content and compute hash
      const vault = this.plugin.app.vault;
      const localHash = await computeFileHash(vault, localFile);
      
      if (!remoteFile) {
        // File exists locally but not on remote → upload
        SyncLogger.log('Sync', `New local file: ${path} (hash: ${localHash.substring(0, 8)}...)`);
        operations.push({ type: 'upload', file: localFile });
        summary.uploads++;
        this.checksumCache.set(path, localHash);
      } else if (remoteFile.hash !== localHash) {
        // Both exist but hashes differ → conflict
        SyncLogger.log('Sync', `Conflict detected: ${path} (local: ${localHash.substring(0, 8)}..., remote: ${(remoteFile.hash || '?').substring(0, 8)}...)`);
        const action = await this.resolveConflict(localFile, remoteFile, localHash);
        
        switch (action) {
          case 'upload':
            operations.push({ type: 'upload', file: localFile });
            summary.uploads++;
            this.checksumCache.set(path, localHash);
            break;
          case 'download':
            operations.push({ type: 'download', remoteFile });
            summary.downloads++;
            break;
          case 'keep-both':
            await this.createConflictCopy(localFile, remoteFile);
            summary.conflicts++;
            break;
        }
      } else {
        SyncLogger.log('Sync', `Unchanged: ${path} — skipping`);
      }
    }
    
    // Handle remote-only files (exist on remote but not locally)
    for (const [path, remoteFile] of remoteFiles) {
      if (!localFiles.has(path) && !this.isInTrash(path)) {
        SyncLogger.log('Sync', `New remote file: ${path}`);
        operations.push({ type: 'download', remoteFile });
        summary.downloads++;
      }
    }
    
    return { operations, summary, timestamp: Date.now() };
  }

  /**
   * Get all local files respecting sync scope and exclusions
   */
  private async getLocalFiles(): Promise<Map<string, TFile>> {
    const files = new Map<string, TFile>();
    const vault = this.plugin.app.vault;
    
    // Include all files (markdown + other types)
    for (const file of vault.getFiles()) {
      if (this.plugin.shouldExcludePath(file.path)) continue;
      files.set(file.path, file);
    }
    
    return files;
  }

  /**
   * Resolve conflict using configured strategy
   */
  private async resolveConflict(
    local: TFile, 
    remote: HereNowFile, 
    localHash: string
  ): Promise<'upload' | 'download' | 'keep-both' | 'skip'> {
    const localMtime = local.stat.mtime;
    const remoteMtime = new Date(remote.lastModified).getTime();
    
    SyncLogger.log('Sync', `Resolving conflict: ${local.path} (local mtime: ${new Date(localMtime).toISOString()}, remote mtime: ${remote.lastModified})`);
    
    // Apply configured strategy
    switch (this.plugin.settings.conflictStrategy) {
      case 'timestamp-wins':
        return localMtime > remoteMtime ? 'upload' : 'download';
      case 'local-wins':
        return 'upload';
      case 'remote-wins':
        return 'download';
      case 'keep-both':
        return 'keep-both';
      default:
        return 'upload';
    }
  }

  /**
   * Create a conflict copy of a file
   */
  private async createConflictCopy(local: TFile, remote: HereNowFile): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = local.extension || 'md';
    const baseName = local.path.replace(new RegExp(`\\.${ext}$`), '');
    const conflictPath = `${baseName}.conflict-${timestamp}.${ext}`;
    
    SyncLogger.log('Sync', `Creating conflict copy: ${conflictPath}`);
    
    try {
      const remoteContent = await this.driveApi.downloadFile(
        this.plugin.settings.driveId || '',
        remote.path
      );
      
      if (remote.contentType?.startsWith('text/')) {
        const text = new TextDecoder().decode(remoteContent);
        await this.plugin.app.vault.create(conflictPath, text);
      } else {
        await this.plugin.app.vault.createBinary(conflictPath, remoteContent);
      }
      
      new Notice(`📋 Created conflict copy: ${conflictPath}`, 5000);
    } catch (error: any) {
      SyncLogger.error('Sync', `Failed to create conflict copy: ${error.message}`);
    }
  }

  /**
   * Execute a sync plan: perform all operations
   */
  private async executeSyncPlan(
    driveId: string, 
    plan: SyncPlan
  ): Promise<void> {
    const total = plan.operations.length;
    let succeeded = 0;
    let failed = 0;
    
    SyncLogger.log('Sync', `Executing plan: ${total} operations`);
    
    for (let i = 0; i < total; i++) {
      if (this.abortController?.signal.aborted) {
        SyncLogger.log('Sync', 'Sync cancelled by user');
        break;
      }
      
      const op = plan.operations[i];
      this.plugin.statusBar.showSyncProgress(i + 1, total);
      
      try {
        switch (op.type) {
          case 'upload':
            await this.executeUpload(driveId, op.file);
            SyncLogger.log('Sync', `✅ Uploaded: ${op.file.path}`);
            break;
          case 'download':
            await this.executeDownload(driveId, op.remoteFile);
            SyncLogger.log('Sync', `✅ Downloaded: ${op.remoteFile.path}`);
            break;
          case 'delete-remote':
            SyncLogger.log('Sync', `Skipping remote delete (trash policy): ${op.path}`);
            break;
          case 'move-to-trash':
            await this.plugin.trashManager.handleLocalDeletion(op.path);
            break;
        }
        succeeded++;
      } catch (error: any) {
        failed++;
        const opPath = op.type === 'upload' ? op.file.path : 
                       op.type === 'download' ? op.remoteFile.path : 
                       op.path || 'unknown';
        SyncLogger.error('Sync', `Failed ${op.type}: ${opPath} — ${error.message}`);
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    SyncLogger.log('Sync', `Plan executed: ${succeeded} succeeded, ${failed} failed out of ${total}`);
  }

  /**
   * Upload a local file to Drive
   */
  private async executeUpload(driveId: string, file: TFile): Promise<void> {
    const vault = this.plugin.app.vault;
    SyncLogger.log('Sync', `Uploading: ${file.path} (${file.extension})`);
    
    // Read file content as binary (ArrayBuffer)
    let contentBuffer: ArrayBuffer;
    
    if (file.extension === 'md' || file.extension === 'txt' || file.extension === 'css' || file.extension === 'js' || file.extension === 'json' || file.extension === 'html') {
      // Text-based files: read as string and convert to ArrayBuffer
      const text = await vault.read(file);
      contentBuffer = new TextEncoder().encode(text).buffer as ArrayBuffer;
    } else {
      // Binary files: read directly
      contentBuffer = await vault.readBinary(file);
    }
    
    const contentType = this.getMimeType(file.extension);
    SyncLogger.log('Sync', `Content type: ${contentType}, size: ${contentBuffer.byteLength} bytes`);
    
    // Upload via Drive API (3-step: get presigned URL → upload → finalize)
    await this.driveApi.uploadFile(driveId, file.path, contentBuffer, contentType);
    
    // Update checksum cache
    const hash = await computeFileHash(vault, file);
    this.checksumCache.set(file.path, hash);
    
    SyncLogger.log('Sync', `✅ Uploaded: ${file.path} (${(contentBuffer.byteLength / 1024).toFixed(1)} KB)`);
  }

  /**
   * Download a remote file to local vault
   */
  private async executeDownload(driveId: string, remoteFile: HereNowFile): Promise<void> {
    const vault = this.plugin.app.vault;
    SyncLogger.log('Sync', `Downloading: ${remoteFile.path} (${remoteFile.contentType}, ${remoteFile.size} bytes)`);
    
    // Download the file content as ArrayBuffer
    const content = await this.driveApi.downloadFile(driveId, remoteFile.path);
    SyncLogger.log('Sync', `Downloaded ${content.byteLength} bytes for ${remoteFile.path}`);
    
    // Determine if content is text-based
    const isText = remoteFile.contentType?.startsWith('text/') || 
                   remoteFile.contentType === 'application/json' ||
                   remoteFile.contentType === 'application/javascript' ||
                   remoteFile.name?.endsWith('.md') ||
                   remoteFile.name?.endsWith('.txt');
    
    // Check if file already exists locally
    const localFile = vault.getAbstractFileByPath(remoteFile.path);
    
    if (localFile instanceof TFile) {
      // Update existing file
      if (isText) {
        const text = new TextDecoder().decode(content);
        await vault.modify(localFile, text);
      } else {
        await vault.modifyBinary(localFile, content);
      }
      SyncLogger.log('Sync', `Updated existing file: ${remoteFile.path}`);
    } else {
      // Create new file
      // Ensure parent directories exist
      const parentPath = remoteFile.path.split('/').slice(0, -1).join('/');
      if (parentPath) {
        const parentFolder = vault.getAbstractFileByPath(parentPath);
        if (!parentFolder) {
          await vault.createFolder(parentPath);
          SyncLogger.log('Sync', `Created folder: ${parentPath}`);
        }
      }
      
      if (isText) {
        const text = new TextDecoder().decode(content);
        await vault.create(remoteFile.path, text);
      } else {
        await vault.createBinary(remoteFile.path, content);
      }
      SyncLogger.log('Sync', `Created new file: ${remoteFile.path}`);
    }
    
    // Update cache
    this.checksumCache.set(remoteFile.path, remoteFile.hash || '');
  }

  /**
   * Publish current Drive state to configured Site
   */
  async publishToSite(): Promise<void> {
    // 🔒 Double-check Site slug is set
    if (!this.plugin.settings.siteSlug || this.plugin.settings.siteSlug.trim() === '') {
      const errorMsg = 'Cannot publish: Site slug is not configured in settings.';
      this.plugin.statusBar.showError(errorMsg);
      throw new Error(errorMsg);
    }

    //if (!this.plugin.settings.siteSlug) {
    //  SyncLogger.log('Sync', 'No Site slug configured, skipping publish');
    //  return;
    //}
    
    if (!this.driveApi || !this.sitesApi) {
      if (!await this.initAPIs()) {
        throw new Error('Cannot publish: API not initialized');
      }
    }
    
    const driveId = this.plugin.settings.driveId || '';
    if (!driveId) {
      throw new Error('Cannot publish: no Drive ID (auto-discover first)');
    }
    
    this.plugin.statusBar.updateStatus('🌐 Publishing to Site...');
    SyncLogger.log('Sync', 'Publishing to Site...');
    
    try {
      const site = await this.sitesApi!.publishFromDrive({
        driveId,
        slug: this.plugin.settings.siteSlug!,
        title: `${this.plugin.app.vault.getName()} — Auto-published`,
        description: `Synced from Obsidian on ${new Date().toLocaleString()}`
      });
      
      const msg = `🌐 Published to: ${site.url}`;
      SyncLogger.log('Sync', msg);
      if (this.plugin.settings.showNotifications) {
        new Notice(msg, 5000);
      }
      
    } catch (error: any) {
      SyncLogger.error('Sync', `Publish failed: ${error.message}`);
      throw new Error(`Failed to publish to Site: ${error.message}`);
    }
  }

  /**
   * Cancel ongoing sync operation
   */
  cancelOngoingSync(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.plugin.statusBar.updateStatus('🛑 Sync cancelled');
      SyncLogger.log('Sync', 'Sync cancelled by user');
    }
  }

  /**
   * Check if path is in trash folder
   */
  private isInTrash(path: string): boolean {
    return path.startsWith(this.plugin.settings.trashFolderName + '/');
  }

  /**
   * Get MIME type for file extension
   */
  private getMimeType(extension: string): string {
    const types: Record<string, string> = {
      'md': 'text/markdown',
      'txt': 'text/plain',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'pdf': 'application/pdf',
      'svg': 'image/svg+xml',
      'mp4': 'video/mp4',
      'mp3': 'audio/mpeg',
      'zip': 'application/zip',
      'json': 'application/json',
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'yaml': 'text/yaml',
      'yml': 'text/yaml',
      'xml': 'text/xml'
    };
    return types[extension.toLowerCase()] || 'application/octet-stream';
  }
}