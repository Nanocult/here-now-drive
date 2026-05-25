import { TFile, Notice } from 'obsidian';
import HereNowSyncPlugin from '../main';
import { HereNowFile } from '../api/HereNowAPI';
import { SyncOperation } from './SyncEngine';

export type QueuedOperation = SyncOperation & {
  queuedAt: number;
  retryCount: number;
  lastError?: string;
};

export class OfflineQueue {
  private queue: QueuedOperation[] = [];
  private isProcessing = false;
  private isOnline = navigator.onLine;

  constructor(private plugin: HereNowSyncPlugin) {
    // Listen for network status changes
    window.addEventListener('online', () => this.handleOnline());
    window.addEventListener('offline', () => this.handleOffline());
  }

  /**
   * Add an operation to the queue (or execute immediately if online)
   */
  enqueue(operation: SyncOperation): void {
    if (!this.plugin.settings.enableOfflineQueue) {
      // If queue disabled, try to execute immediately
      this.plugin.syncEngine.triggerSync({ source: 'event', full: false });
      return;
    }

    if (this.isOnline) {
      // Execute immediately when online
      this.plugin.syncEngine.triggerSync({ source: 'event', full: false });
    } else {
      // Queue for later
      const queued: QueuedOperation = {
        ...operation,
        queuedAt: Date.now(),
        retryCount: 0
      };
      
      // Prevent queue from growing too large
      if (this.queue.length >= this.plugin.settings.maxQueueSize) {
        this.queue.shift(); // Remove oldest
        console.log('⚠️ Queue full, removed oldest operation');
      }
      
      this.queue.push(queued);
      this.plugin.statusBar.updateStatus(`📦 ${this.queue.length} changes queued (offline)`);
      console.log(`📦 Queued ${operation.type} for ${this.getOperationPath(operation)}`);
    }
  }

  /**
   * Process all queued operations
   */
  async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    this.plugin.statusBar.updateStatus(`🔄 Processing ${this.queue.length} queued changes...`);

    const initialCount = this.queue.length;
    
    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      
      try {
        // Trigger a sync which will process pending changes
        await this.plugin.syncEngine.triggerSync({ 
          source: 'queue', 
          full: false 
        });
        
        if (this.plugin.settings.showDetailedLogs) {
          console.log(`✅ Processed queued ${op.type}: ${this.getOperationPath(op)}`);
        }
      } catch (error: any) {
        // Re-queue with exponential backoff
        op.retryCount++;
        op.lastError = error.message;
        
        if (op.retryCount < 3) {
          const delay = Math.min(1000 * Math.pow(2, op.retryCount), 30000);
          console.log(`⏱️ Retrying ${op.type} in ${delay}ms (attempt ${op.retryCount})`);
          
          // Re-add to front of queue after delay
          setTimeout(() => {
            this.queue.unshift(op);
            if (navigator.onLine) this.processQueue();
          }, delay);
        } else {
          // Give up and notify
          console.error(`❌ Failed to process queued ${op.type} after 3 attempts:`, error);
          if (this.plugin.settings.showNotifications) {
            new Notice(`⚠️ Failed to sync: ${this.getOperationPath(op)}`, 5000);
          }
        }
      }
    }
    
    this.isProcessing = false;
    
    if (this.queue.length === 0) {
      this.plugin.statusBar.updateStatus('✅ All queued changes synced');
      console.log(`✅ Processed ${initialCount} queued operations`);
    }
  }

  /**
   * Handle transition to online state
   */
  private handleOnline(): void {
    this.isOnline = true;
    console.log('🌐 Network online - processing queue');
    this.processQueue();
  }

  /**
   * Handle transition to offline state
   */
  private handleOffline(): void {
    this.isOnline = false;
    console.log('📴 Network offline - queuing changes');
  }

  /**
   * Get human-readable path for an operation
   */
  private getOperationPath(op: SyncOperation): string {
    switch (op.type) {
      case 'upload': return op.file.path;
      case 'download': return op.remoteFile.path;
      case 'delete-remote': return op.path;
      case 'move-to-trash': return op.path;
      default: return 'unknown';
    }
  }

  /**
   * Clear all queued operations
   */
  clear(): void {
    this.queue = [];
    console.log('🗑️ Cleared offline queue');
  }

  /**
   * Get queue statistics
   */
  getStats(): { count: number; oldest?: number; newest?: number } {
    if (this.queue.length === 0) {
      return { count: 0 };
    }
    return {
      count: this.queue.length,
      oldest: Math.min(...this.queue.map(q => q.queuedAt)),
      newest: Math.max(...this.queue.map(q => q.queuedAt))
    };
  }
}