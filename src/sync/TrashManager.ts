import { TFile, Notice } from 'obsidian';
import HereNowSyncPlugin from '../main';

export class TrashManager {
  constructor(private plugin: HereNowSyncPlugin) {}

  /**
   * Move a file to the trash folder instead of deleting
   */
  async moveToTrash(file: TFile): Promise<boolean> {
    const trashPath = `${this.plugin.settings.trashFolderName}/${file.path}`;
    
    try {
      // Ensure trash folder exists
      await this.ensureTrashFolderExists();
      
      // Move file to trash
      await this.plugin.app.vault.rename(file, trashPath);
      
      // Notify user
      const msg = `🗑️ Moved to trash: ${file.path}`;
      console.log(msg);
      if (this.plugin.settings.showNotifications) {
        new Notice(msg, 3000);
      }
      
      return true;
      
    } catch (error: any) {
      console.error(`❌ Failed to move to trash: ${file.path}`, error);
      
      // Fallback: just delete (user can restore from system trash)
      try {
        await this.plugin.app.vault.delete(file, true);
        new Notice(`⚠️ File deleted (trash move failed): ${file.path}`, 4000);
      } catch (deleteError) {
        console.error('❌ Fallback delete also failed:', deleteError);
        throw error; // Re-throw original error
      }
      
      return false;
    }
  }

  /**
   * Handle deletion event by moving to trash
   * Note: Obsidian's delete event fires AFTER file is deleted,
   * so this should be called BEFORE the actual delete operation
   */
  async handleLocalDeletion(path: string): Promise<void> {
    // This is a placeholder - actual implementation depends on
    // intercepting delete commands via custom file menu actions
    console.log(`🗑️ Trash handler called for: ${path}`);
  }

  /**
   * Ensure trash folder exists in vault
   */
  async ensureTrashFolderExists(): Promise<void> {
    const trashName = this.plugin.settings.trashFolderName;
    const trashFolder = this.plugin.app.vault.getAbstractFileByPath(trashName);
    
    if (!trashFolder) {
      await this.plugin.app.vault.createFolder(trashName);
      console.log(`📁 Created trash folder: ${trashName}`);
    }
  }

  /**
   * Check if a path should be excluded from sync (trash policy)
   */
  isSyncable(path: string): boolean {
    // Never sync trash folder contents
    if (path.startsWith(this.plugin.settings.trashFolderName + '/')) {
      return false;
    }
    
    // Delegate to plugin's exclusion logic
    return !this.plugin.shouldExcludePath(path);
  }

  /**
   * Get list of files in trash (for user review)
   */
  async getTrashedFiles(): Promise<TFile[]> {
    const trashName = this.plugin.settings.trashFolderName;
    const trashFolder = this.plugin.app.vault.getAbstractFileByPath(trashName);
    
    if (!trashFolder) return [];
    
    return this.plugin.app.vault
      .getFiles()
      .filter(file => file.path.startsWith(trashName + '/'));
  }

  /**
   * Restore a file from trash to original location
   */
  async restoreFromTrash(trashedFile: TFile): Promise<void> {
    const trashName = this.plugin.settings.trashFolderName;
    const originalPath = trashedFile.path.substring(trashName.length + 1);
    
    if (!originalPath) {
      throw new Error('Invalid trash file path');
    }
    
    // Move back to original location
    await this.plugin.app.vault.rename(trashedFile, originalPath);
    
    new Notice(`♻️ Restored: ${originalPath}`, 3000);
  }

  /**
   * Permanently delete a file from trash
   */
  async permanentlyDelete(trashedFile: TFile): Promise<void> {
    await this.plugin.app.vault.delete(trashedFile, true);
    new Notice(`🗑️ Permanently deleted: ${trashedFile.path}`, 3000);
  }
}