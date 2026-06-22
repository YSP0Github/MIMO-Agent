import * as fs from 'fs';
import * as path from 'path';

export interface WorkspaceFilePickerEntry {
    name: string;
    relativePath: string;
    fullPath: string;
    kind: 'file' | 'directory';
    depth: number;
    parent: string;
}

export const DEFAULT_WORKSPACE_FILE_PICKER_MAX_ENTRIES = 12_000;

function compareWorkspaceEntries(a: WorkspaceFilePickerEntry, b: WorkspaceFilePickerEntry): number {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
}

export function collectWorkspaceFileEntries(root: string, maxEntries = DEFAULT_WORKSPACE_FILE_PICKER_MAX_ENTRIES): WorkspaceFilePickerEntry[] {
    const results: WorkspaceFilePickerEntry[] = [];
    const ignored = new Set(['.git', 'node_modules', 'out', 'dist', '.vscode', '__pycache__']);
    const ignoredFileExt = new Set(['.pyc', '.pyo', '.map']);

    const toEntry = (fullPath: string, kind: 'file' | 'directory'): WorkspaceFilePickerEntry => {
        const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
        return {
            name: path.basename(fullPath),
            relativePath,
            fullPath,
            kind,
            depth: relativePath ? relativePath.split('/').length - 1 : 0,
            parent: relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '',
        };
    };

    const sortEntries = (entries: fs.Dirent[]) => entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (queue.length > 0 && results.length < maxEntries) {
        const current = queue.shift()!;
        if (current.depth > 8) continue;
        try {
            const entries = sortEntries(fs.readdirSync(current.dir, { withFileTypes: true }));
            const childDirs: string[] = [];
            for (const entry of entries) {
                if (results.length >= maxEntries) break;
                if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
                const fullPath = path.join(current.dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(toEntry(fullPath, 'directory'));
                    childDirs.push(fullPath);
                } else if (entry.isFile() && !ignoredFileExt.has(path.extname(entry.name).toLowerCase())) {
                    results.push(toEntry(fullPath, 'file'));
                }
            }
            for (const dir of childDirs) {
                queue.push({ dir, depth: current.depth + 1 });
            }
        } catch {
            // Skip inaccessible dirs.
        }
    }

    return results;
}

export function orderWorkspaceFileEntriesForTree(entries: WorkspaceFilePickerEntry[], maxEntries = entries.length): WorkspaceFilePickerEntry[] {
    const byParent = new Map<string, WorkspaceFilePickerEntry[]>();
    for (const entry of entries) {
        const key = entry.parent || '';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key)!.push(entry);
    }

    for (const siblings of byParent.values()) {
        siblings.sort(compareWorkspaceEntries);
    }

    const ordered: WorkspaceFilePickerEntry[] = [];
    const walk = (parent: string): void => {
        const siblings = byParent.get(parent) || [];
        for (const entry of siblings) {
            if (ordered.length >= maxEntries) return;
            ordered.push(entry);
            if (entry.kind === 'directory') walk(entry.relativePath);
            if (ordered.length >= maxEntries) return;
        }
    };

    walk('');
    return ordered;
}
