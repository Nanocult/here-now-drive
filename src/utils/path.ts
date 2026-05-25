/**
 * Normalize a file path (handle different OS separators)
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Get the directory path from a file path
 */
export function getDirectoryPath(filePath: string): string {
  const parts = normalizePath(filePath).split('/');
  parts.pop(); // Remove filename
  return parts.join('/') || '/';
}

/**
 * Get the file name from a path
 */
export function getFileName(filePath: string): string {
  return normalizePath(filePath).split('/').pop() || '';
}

/**
 * Get file extension (without dot)
 */
export function getFileExtension(filePath: string): string {
  const fileName = getFileName(filePath);
  const lastDot = fileName.lastIndexOf('.');
  return lastDot > 0 ? fileName.substring(lastDot + 1) : '';
}

/**
 * Check if path matches a glob pattern (simple implementation)
 * For production, use the minimatch library
 */
export function matchesGlob(path: string, pattern: string): boolean {
  // Convert glob to regex
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '§§§') // Temp placeholder
    .replace(/\*/g, '[^/]*')
    .replace(/§§§/g, '.*')
    .replace(/\?/g, '.');
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normalizePath(path));
}

/**
 * Join path segments safely
 */
export function joinPath(...segments: string[]): string {
  return segments
    .map(s => normalizePath(s))
    .join('/')
    .replace(/\/+/g, '/');
}