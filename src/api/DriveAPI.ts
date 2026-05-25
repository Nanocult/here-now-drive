import { requestUrl } from 'obsidian';
import { SyncLogger } from '../utils/logger';
import { HereNowAPI, HereNowFile, DriveInfo, DriveBatchResponse } from './HereNowAPI';

export class DriveAPI extends HereNowAPI {
  /**
   * Get or create default Drive for this user
   * Handles both {drive: {...}} and direct DriveInfo response formats
   */
  async getDefaultDrive(): Promise<DriveInfo> {
    const response: any = await this.request<any>({
      url: `${this.baseUrl}/drives/default`,
      method: 'GET'
    });
    
    // API may return { drive: DriveInfo } or DriveInfo directly
    const drive = response.drive || response;
    SyncLogger.log('API', `Default drive response: ${JSON.stringify(drive).substring(0, 200)}`);
    
    return drive as DriveInfo;
  }

  /**
   * Get specific Drive by ID
   */
  async getDrive(driveId: string): Promise<DriveInfo> {
    const response: any = await this.request<any>({
      url: `${this.baseUrl}/drives/${driveId}`,
      method: 'GET'
    });
    
    const drive = response.drive || response;
    return drive as DriveInfo;
  }

  /**
   * List files in a Drive with optional prefix filtering
   */
  async listFiles(driveId: string, prefix: string = ''): Promise<HereNowFile[]> {
    const params = new URLSearchParams();
    if (prefix) params.set('prefix', prefix);
    
    const response: any = await this.request<any>({
      url: `${this.baseUrl}/drives/${driveId}/files?${params}`,
      method: 'GET'
    });
    
    // API may return { files: [...] } or [...] directly
    const files = Array.isArray(response) ? response : (response.files || []);
    SyncLogger.log('API', `listFiles returned ${files.length} files`);
    
    return files as HereNowFile[];
  }

  /**
   * Get presigned URL for uploading a file
   * Returns uploadUrl, uploadId, and expiresAt
   */
  async getUploadUrl(
    driveId: string, 
    path: string, 
    contentType: string,
    size: number
  ): Promise<{ uploadUrl: string; uploadId: string; expiresAt: string }> {
    const response: any = await this.request({
      url: `${this.baseUrl}/drives/${driveId}/files/uploads`,
      method: 'POST',
      body: JSON.stringify({
        path,
        contentType,
        size
      })
    });

    // API may return { uploadUrl, uploadId, expiresAt } directly
    // or wrap them in a nested object
    // Handle both direct and nested response formats
    const result = response.uploadUrl ? response : (response.data || response);
    SyncLogger.log('API', `Upload URL response has uploadId: ${!!result.uploadId}`);
    
    return {
      uploadUrl: result.uploadUrl,
      uploadId: result.uploadId || result.upload_id || '',
      expiresAt: result.expiresAt || result.expires_at || ''
    };
  }

  /**
   * Upload file content to presigned URL
   */
  async uploadToPresignedUrl(
    uploadUrl: string, 
    content: ArrayBuffer, 
    contentType: string
  ): Promise<void> {
    SyncLogger.log('API', `Uploading ${content.byteLength} bytes to presigned URL...`);
    
    await requestUrl({
      url: uploadUrl,
      method: 'PUT',
      headers: this.plugin.authManager.getPresignedHeaders(contentType),
      body: content,
      throw: true
    });
    
    SyncLogger.log('API', 'Presigned upload completed');
  }

  /**
   * Get metadata for a specific file
   */
  async getFileMetadata(driveId: string, path: string): Promise<HereNowFile> {
    const encodedPath = this.encodePath(path);
    const response: any = await this.request<any>({
      url: `${this.baseUrl}/drives/${driveId}/files/${encodedPath}`,
      method: 'HEAD'
    });
    // HEAD response headers may contain file metadata
    const lastModifiedHeader = response.headers?.['last-modified'];
    const file: HereNowFile = {
      path,
      name: path.split('/').pop() || path,
      hash: response.headers?.['etag']?.replace(/"/g, '') || '',
      size: parseInt(response.headers?.['content-length'] || '0', 10),
      lastModified: lastModifiedHeader ? new Date(lastModifiedHeader).toISOString() : new Date().toISOString(),
      contentType: response.headers?.['content-type'] || 'application/octet-stream'
    };
    return file;
  }

  /**
   * Commit an upload using the batch endpoint (preferred over finalize)
   * Supports both new files (ifNoneMatch: '*') and updates (ifMatch: 'hash')
   */
  async commitUploadBatch_old(
    driveId: string,
    uploadId: string,
    filePath: string,
    options: {
      isNew?: boolean;
      currentHash?: string;
      contentType?: string;
      metadata?: Record<string, any>;
    } = {}
  ): Promise<HereNowFile> {
    SyncLogger.log('API', `Committing upload via batch: uploadId=${uploadId}, path=${filePath}`);
    
    const url = `${this.baseUrl}/drives/${driveId}/files`;
    
    // Build the commit operation
    const operation: Record<string, any> = {
      op: 'upload',
      uploadId,
      path: filePath
    };
    
    // Add optional metadata
    if (options.contentType) {
      operation.contentType = options.contentType;
    }
    if (options.metadata) {
      operation.metadata = options.metadata;
    }
    
    // Determine concurrency control strategy
    if (options.isNew === true) {
      operation.ifNoneMatch = '*';
      SyncLogger.log('API', `Batch commit: ifNoneMatch='*' for new file: ${filePath}`);
    } else if (options.currentHash) {
      operation.ifMatch = options.currentHash;
      SyncLogger.log('API', `Batch commit: ifMatch='${options.currentHash}' for update: ${filePath}`);
    } else {
      // Auto-detect via HEAD request
      try {
        const existing = await this.getFileMetadata(driveId, filePath);
        operation.ifMatch = options.currentHash || existing.hash;
        SyncLogger.log('API', `Batch commit: auto-detected existing file, using ifMatch`);
      } catch (e: any) {
        operation.ifNoneMatch = '*';
        SyncLogger.log('API', `Batch commit: auto-detected new file, using ifNoneMatch='*'`);
      }
    }
    
    const batchBody: Record<string, any> = {
      ops: [operation]
    };
    
    // Only include baseVersionId at root level for updates (not new files)
    if (!options.isNew && options.currentHash) {
      batchBody.baseVersionId = options.currentHash;
      SyncLogger.log('API', `Batch commit: including baseVersionId='${options.currentHash}'`);
    }
    
    SyncLogger.log('API', `Batch request body: ${JSON.stringify(batchBody)}`);
    
    // Execute batch commit via PATCH
    const response = await requestUrl({
      url,
      method: 'PATCH',
      headers: {
        ...this.getAuthHeaders(),
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(batchBody),
      throw: false
    });
    
    SyncLogger.log('API', `Batch commit response: ${response.status}`);
    
    // Handle errors
    if (response.status >= 400) {
      const errorText = response.text ? response.text.substring(0, 500) : 'No response body';
      SyncLogger.error('API', `HTTP ${response.status}: ${errorText}`);
      
      if (response.status === 412 && errorText.includes('ifMatch')) {
        SyncLogger.error('API', '💡 Hint: File was modified since you read it. Retry with fresh hash.');
      } else if (response.status === 409 && errorText.includes('ifNoneMatch')) {
        SyncLogger.error('API', '💡 Hint: File already exists. Use ifMatch instead of ifNoneMatch.');
      }
      
      throw new Error(`Batch commit failed ${response.status}: ${errorText}`);
    }
    
    // Parse response
    if (!response.text || response.text.length === 0) {
      SyncLogger.log('API', 'Empty batch commit response');
      return {
        path: filePath,
        name: filePath.split('/').pop() || filePath,
        size: 0,
        contentType: options.contentType || 'application/octet-stream',
        lastModified: new Date().toISOString()
      } as HereNowFile;
    }
    
    try {
      const parsed = JSON.parse(response.text);
      // Response may be { file: {...} }, { files: [...] }, { ops: [...] }, or direct file object
      const result = parsed.file || parsed.files?.[0] || parsed.ops?.[0]?.result || parsed;
      return result as HereNowFile;
    } catch (parseError: any) {
      SyncLogger.error('API', `Batch commit JSON parse error: ${parseError.message}`);
      throw new Error(`Invalid JSON response: ${response.text.substring(0, 200)}`);
    }
  }

  /**
   * Commit upload via batch endpoint (PATCH /drives/{driveId}/files)
   * Uses correct op values: "write" or "create" per OpenAPI spec
   */
  async commitUploadBatch(
    driveId: string,
    uploadId: string,
    filePath: string,
    options: {
      isNew?: boolean;
      currentHash?: string;
    } = {}
  ): Promise<HereNowFile> {
    SyncLogger.log('API', `Batch commit: uploadId=${uploadId}, path=${filePath}`);
    
    const url = `${this.baseUrl}/drives/${driveId}/files`;
    
    // Build operation with SPEC-COMPLIANT fields only
    const operation: Record<string, any> = {
      op: options.isNew === true ? 'create' : 'write',  // ← "create" or "write", NOT "upload"
      uploadId,
      path: filePath
    };
    
    // Add concurrency control (spec-compliant)
    if (options.isNew === true) {
      operation.ifNoneMatch = '*';  // ← Exact string "*", const constraint
      SyncLogger.log('API', `Batch: ifNoneMatch='*' for new file`);

    } else if (options.currentHash) {
      operation.ifMatch = options.currentHash;
      SyncLogger.log('API', `Batch: ifMatch='${options.currentHash.substring(0, 16)}...'`);
    }
    
    // Build batch body: ops array + baseVersionId at ROOT level
    const batchBody: Record<string, any> = {
      ops: [operation]  // ← "ops" not "operations"
    };
    
    // baseVersionId ONLY for updates, at ROOT level (not inside ops)
    if (!options.isNew && options.currentHash) {
      batchBody.baseVersionId = options.currentHash;
      SyncLogger.log('API', `Batch: baseVersionId at root level`);
    }
    
    SyncLogger.log('API', `Batch request body: ${JSON.stringify(batchBody)}`);
    
    // Execute via PATCH (not POST)
    return await this.request<DriveBatchResponse>({
      url,
      method: 'PATCH',  // ← PATCH, not POST
      body: JSON.stringify(batchBody)

    }).then(response => {
      // Extract file from DriveBatchResponse
      const result = response as any;
      const file = result.files?.[0] || result.file || result;
      return file as HereNowFile;
    });
  }

  /**
   * Finalize upload workflow
   */
  async finalizeUpload(
    driveId: string,
    uploadId: string,
    options: { filePath?: string; expectedHash?: string; isNew?: boolean } = {}
  ): Promise<HereNowFile> {
    SyncLogger.log('API', `Finalizing upload with uploadId: ${uploadId}`);
    const url = `${this.baseUrl}/drives/${driveId}/files/finalize`;

    const body: Record<string, any> = { uploadId };

    // Determine concurrency control based ONLY on options, NO HEAD request
    if (options.isNew === true) {
      // Explicitly creating new file
      body.ifNoneMatch = '*';
      SyncLogger.log('API', `Finalize: ifNoneMatch='*' (forceNew=true)`);

    } else if (options.expectedHash) {
      // Hash provided AND not forcing new = update existing
      body.ifMatch = options.expectedHash;
      SyncLogger.log('API', `Finalize: ifMatch='${options.expectedHash.substring(0, 16)}...'`);

    } else {
      // Default: assume new file
      body.ifNoneMatch = '*';
      SyncLogger.log('API', `Finalize: ifNoneMatch='*' (default)`);
    }

    SyncLogger.log('API', `Finalize request body: ${JSON.stringify(body)}`);

    // Use inherited request() for consistent error handling
    return await this.request<HereNowFile>({
      url,
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  /**
   * Complete upload workflow: get URL → upload → finalize
   */
  async uploadFile(
    driveId: string,
    path: string,
    content: ArrayBuffer,
    contentType: string
  ): Promise<HereNowFile> {
    const size = content.byteLength;
    SyncLogger.log('Sync', `Uploading: ${path}`);
    
    // Step 1: Get presigned URL + uploadId
    const { uploadUrl, uploadId } = await this.getUploadUrl(driveId, path, contentType, size);
    
    // Step 2: Upload content to presigned URL
    await this.uploadToPresignedUrl(uploadUrl, content, contentType);
    
    // Step 3: Compute hash for content verification
    const contentHash = await this.computeHash(content);
    
    // Step 4: Check if file exists on remote (HEAD request HERE, not in finalize)
    let isNew = false;
    try {
      await this.getFileMetadata(driveId, path);
      isNew = false;
      SyncLogger.log('API', `File exists on remote: ${path}`);
      
    } catch (e: any) {
      // 404 or other error = new file
      isNew = true;
      SyncLogger.log('API', `New file on remote: ${path}`);
    }

    // Step 5: Commit via batch endpoint (spec-compliant)
    return await this.commitUploadBatch(driveId, uploadId, path, {
      isNew,
      currentHash: isNew ? undefined : contentHash
    });
  }

  /**
   * Download file content from Drive
   */
  async downloadFile(driveId: string, path: string): Promise<ArrayBuffer> {
    const encodedPath = this.encodePath(path);
    SyncLogger.log('API', `Downloading: ${driveId}/${path} (encoded: ${encodedPath})`);
    
    const response = await requestUrl({
      url: `${this.baseUrl}/drives/${driveId}/files/${encodedPath}`,
      method: 'GET',
      headers: this.getAuthHeaders(),
      throw: true
    });
    
    SyncLogger.log('API', `Downloaded file, arrayBuffer size: ${response.arrayBuffer?.byteLength || 0}`);
    return response.arrayBuffer;
  }

  /**
   * Delete file from Drive (use with caution - we prefer trash)
   */
  async deleteFile(driveId: string, path: string): Promise<void> {
    const encodedPath = this.encodePath(path);
    await this.request({
      url: `${this.baseUrl}/drives/${driveId}/files/${encodedPath}`,
      method: 'DELETE'
    });
  }

  /**
   * Move file to trash prefix (soft delete)
   */
  async moveToTrash(driveId: string, path: string): Promise<void> {
    const trashPath = `.trash/${path}`;
    SyncLogger.log('API', `Remote trash not implemented: ${path} → ${trashPath}`);
  }
}