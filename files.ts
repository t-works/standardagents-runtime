import fs from 'node:fs';
import path from 'node:path';
import type {
  FileChunk,
  FileRecord,
  FileStats,
  FindResult,
  GrepResult,
  ReaddirResult,
  WriteFileOptions,
} from '@standardagents/spec';

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function mimeOf(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Normalize a thread path to `/a/b` and refuse anything that escapes the root. */
function normalize(p: string): string {
  // Treat backslashes as separators too, so Windows paths cannot escape the root.
  const clean = path.posix.normalize(`/${String(p ?? '').replace(/\\/g, '/')}`).replace(/\/+$/, '');
  if (clean.split('/').includes('..')) throw new Error(`Invalid thread path: ${p}`);
  return clean === '' ? '/' : clean;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Per-thread file system. The store owns the directory; every path is confined
 * to it, and every record uses the specification's `FileRecord` shape.
 */
export class ThreadFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private abs(p: string): string {
    const rel = normalize(p);
    const abs = path.resolve(this.root, `.${rel}`);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes the thread file system: ${p}`);
    }
    return abs;
  }

  private record(p: string, stat: fs.Stats): FileRecord {
    const rel = normalize(p);
    return {
      path: rel,
      name: rel === '/' ? '/' : path.posix.basename(rel),
      mimeType: stat.isDirectory() ? 'inode/directory' : mimeOf(rel),
      storage: 'local',
      size: stat.size,
      isDirectory: stat.isDirectory(),
      metadata: {},
      createdAt: Math.floor(stat.birthtimeMs * 1000),
      updatedAt: Math.floor(stat.mtimeMs * 1000),
    };
  }

  /** Copy a file from another thread into this one, returning the local record. */
  importFrom(sourceRoot: string, sourcePath: string): FileRecord {
    const from = new ThreadFiles(sourceRoot).abs(sourcePath);
    const rel = normalize(sourcePath);
    const to = this.abs(rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return this.record(rel, fs.statSync(to));
  }

  /** Relocate a file or directory inside this thread's tree. The destination must not exist. */
  moveFile(from: string, to: string): FileRecord {
    const source = this.abs(from);
    const target = this.abs(to);
    if (target === this.root) throw new Error(`Invalid thread path: ${to}`);
    if (target === source) throw new Error(`Source and destination are the same: ${to}`);
    // fs.renameSync would move a directory into its own subtree and lose the lot.
    if (target.startsWith(source + path.sep)) throw new Error(`Cannot move '${from}' into itself: ${to}`);
    // Spec: "The destination must not already exist". Checked here because renameSync
    // silently overwrites on POSIX while Windows refuses, so behaviour would differ per OS.
    if (fs.existsSync(target)) throw new Error(`Destination already exists: ${to}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return this.record(to, fs.statSync(target));
  }

  /** Rename in place: the new name is a bare segment, never a path. */
  renameFile(p: string, newName: string): FileRecord {
    if (!newName || newName === '.' || newName === '..' || /[\\/]/.test(newName)) {
      throw new Error(`Invalid file name: ${newName}`);
    }
    return this.moveFile(p, path.posix.join(path.posix.dirname(normalize(p)), newName));
  }

  writeFile(p: string, data: ArrayBuffer | string, mimeType?: string, options: WriteFileOptions = {}): FileRecord {
    const target = this.abs(p);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data as ArrayBuffer);
    fs.writeFileSync(target, bytes);
    const record = this.record(p, fs.statSync(target));
    record.mimeType = mimeType || record.mimeType;
    record.metadata = options.metadata ?? {};
    if (options.width) record.width = options.width;
    if (options.height) record.height = options.height;
    return record;
  }

  readFile(p: string): ArrayBuffer | null {
    try {
      const buf = fs.readFileSync(this.abs(p));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      return null;
    }
  }

  async *readFileStream(p: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<FileChunk> {
    const abs = this.abs(p);
    const size = fs.statSync(abs).size;
    const chunkSize = 256 * 1024;
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const handle = await fs.promises.open(abs, 'r');
    try {
      for (let index = 0; index < totalChunks; index++) {
        if (options.signal?.aborted) return;
        const buffer = Buffer.alloc(Math.min(chunkSize, size - index * chunkSize));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, index * chunkSize);
        yield {
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead),
          index,
          totalChunks,
          isLast: index === totalChunks - 1,
        };
      }
    } finally {
      await handle.close();
    }
  }

  statFile(p: string): FileRecord | null {
    try {
      return this.record(p, fs.statSync(this.abs(p)));
    } catch {
      return null;
    }
  }

  readdirFile(p: string): ReaddirResult {
    try {
      const dir = this.abs(p);
      const entries = fs
        .readdirSync(dir)
        .sort()
        .map((name) => this.record(path.posix.join(normalize(p), name), fs.statSync(path.join(dir, name))));
      return { entries };
    } catch {
      return { entries: [] };
    }
  }

  unlinkFile(p: string): void {
    fs.rmSync(this.abs(p), { force: true });
  }

  mkdirFile(p: string): FileRecord {
    const target = this.abs(p);
    fs.mkdirSync(target, { recursive: true });
    return this.record(p, fs.statSync(target));
  }

  rmdirFile(p: string): void {
    fs.rmdirSync(this.abs(p));
  }

  getFileStats(): FileStats {
    let fileCount = 0;
    let directoryCount = 0;
    let totalSize = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          directoryCount++;
          walk(full);
        } else {
          fileCount++;
          totalSize += fs.statSync(full).size;
        }
      }
    };
    walk(this.root);
    return { fileCount, directoryCount, totalSize };
  }

  grepFiles(pattern: string): GrepResult[] {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'g');
    } catch {
      return [];
    }
    const results: GrepResult[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
        let text: string;
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue;
        const matches: GrepResult['matches'] = [];
        text.split('\n').forEach((line, i) => {
          regex.lastIndex = 0;
          if (regex.test(line)) matches.push({ line: i + 1, content: line });
        });
        if (matches.length) {
          results.push({ path: normalize(path.relative(this.root, full)), matches });
        }
      }
    };
    walk(this.root);
    return results;
  }

  findFiles(pattern: string): FindResult {
    const regex = globToRegExp(pattern);
    const paths: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = normalize(path.relative(this.root, full));
        if (entry.isDirectory()) walk(full);
        if (regex.test(rel) || regex.test(entry.name)) paths.push(rel);
      }
    };
    walk(this.root);
    return { paths };
  }

  /** No image decoder in this runtime; the capability is present and empty. */
  getFileThumbnail(_p: string): ArrayBuffer | null {
    return null;
  }
}
