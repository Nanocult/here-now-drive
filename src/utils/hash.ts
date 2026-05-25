import { Vault, TFile } from 'obsidian';

/**
 * Compute SHA-256 hash of a file's content
 */
export async function computeFileHash(vault: Vault, file: TFile): Promise<string> {
  const content = file.extension === 'md'
    ? await vault.read(file)
    : await vault.readBinary(file);
  
  const buffer = typeof content === 'string'
    ? new TextEncoder().encode(content).buffer
    : content;
  
  return computeHash(buffer);
}

/**
 * Compute SHA-256 hash of ArrayBuffer
 */
export async function computeHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute quick hash for change detection (faster, less collision-resistant)
 * Use for initial filtering before SHA-256
 */
export function quickHash(content: string): number {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}