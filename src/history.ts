import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, ContentPart } from './api';
import { atomicWriteSync } from './utils/fileLock';
import { workspaceDataPath, workspaceWindowDataPath } from './workspaceData';

export interface SavedInputHistoryImage {
    dataUrl: string;
    name: string;
    size: number;
}

export interface SavedInputHistoryItem {
    text: string;
    images?: SavedInputHistoryImage[] | null;
}

export interface HistoryEntry {
    id: string;
    title: string;
    timestamp: string;
    model: string;
    modelEndpointId?: string;
    messageCount: number;
}

export interface HistoryConversation extends HistoryEntry {
    messages: ChatMessage[];
    mode?: string;
    personaId?: string;
    activeSkillPrompt?: string;
    inputHistory?: SavedInputHistoryItem[];
}

/**
 * Lightweight index file that stores only metadata
 * for all conversations. This avoids reading every full JSON file just to list entries.
 */
interface HistoryIndex {
    [id: string]: HistoryEntry;
}

export class HistoryManager {
    private historyDir: string;
    private indexPath: string;
    private _index: HistoryIndex | null = null;
    /** IDs deleted in this session — excluded during index merge to prevent re-addition from disk */
    private _deletedIds = new Set<string>();

    constructor(workspace = process.cwd(), _windowSessionId?: string) {
        // Saved history is workspace-level so it survives debug restarts.
        // Live agent state remains window-isolated in memory/token/conversation storage.
        this.historyDir = workspaceDataPath(workspace, 'history');
        this.indexPath = path.join(this.historyDir, 'index.json');
        this.ensureDir();
        this.migrateWindowScopedHistory(workspace);
    }

    private ensureDir(): void {
        if (!fs.existsSync(this.historyDir)) {
            fs.mkdirSync(this.historyDir, { recursive: true });
        }
    }

    private filePath(id: string): string {
        if (!this.isSafeId(id)) {
            throw new Error('Invalid history id');
        }
        return path.join(this.historyDir, `${id}.json`);
    }

    private isSafeId(id: string): boolean {
        return typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
    }

    private migrateWindowScopedHistory(workspace: string): void {
        const markerPath = path.join(this.historyDir, '.window-history-migrated');
        if (fs.existsSync(markerPath)) return;

        const windowsDir = workspaceDataPath(workspace, 'windows');
        const MAX_WINDOWS = 16;
        const MAX_FILES_PER_WINDOW = 60;
        const MAX_TOTAL_FILES = 200;
        let copied = 0;

        try {
            if (!fs.existsSync(windowsDir)) {
                atomicWriteSync(markerPath, new Date().toISOString());
                return;
            }

            const windows = fs.readdirSync(windowsDir)
                .map(name => {
                    const historyPath = workspaceWindowDataPath(workspace, name, 'history');
                    try {
                        return { name, historyPath, mtime: fs.statSync(historyPath).mtimeMs };
                    } catch {
                        return null;
                    }
                })
                .filter((entry): entry is { name: string; historyPath: string; mtime: number } => !!entry)
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, MAX_WINDOWS);

            for (const win of windows) {
                if (copied >= MAX_TOTAL_FILES) break;
                const files = fs.readdirSync(win.historyPath)
                    .filter(f => f.endsWith('.json') && f !== 'index.json')
                    .map(name => {
                        const sourcePath = path.join(win.historyPath, name);
                        try {
                            return { name, sourcePath, mtime: fs.statSync(sourcePath).mtimeMs };
                        } catch {
                            return null;
                        }
                    })
                    .filter((entry): entry is { name: string; sourcePath: string; mtime: number } => !!entry)
                    .sort((a, b) => b.mtime - a.mtime)
                    .slice(0, MAX_FILES_PER_WINDOW);

                for (const file of files) {
                    if (copied >= MAX_TOTAL_FILES) break;
                    const targetPath = path.join(this.historyDir, file.name);
                    if (fs.existsSync(targetPath)) continue;
                    try {
                        fs.copyFileSync(file.sourcePath, targetPath);
                        copied++;
                    } catch { /* skip files that cannot be migrated */ }
                }
            }

            if (copied > 0) {
                this._index = null;
                this.loadIndex();
            }
            atomicWriteSync(markerPath, new Date().toISOString());
        } catch {
            try {
                atomicWriteSync(markerPath, new Date().toISOString());
            } catch { /* ignore marker write errors */ }
        }
    }

    // ── Index management ──

    /**
     * Load the index from disk, or build it from existing files (backward compat).
     * Validates each entry to ensure required fields exist.
     *
     * PERFORMANCE: When rebuilding from files, sorts by mtime (newest first)
     * and limits to MAX_BUILD_FILES to avoid blocking the UI on first access.
     */
    private loadIndex(): HistoryIndex {
        if (this._index) return this._index;

        // Try to read existing index
        try {
            if (fs.existsSync(this.indexPath)) {
                const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
                this._index = {};
                for (const [id, entry] of Object.entries(raw)) {
                    if (entry && typeof entry === 'object' && (entry as any).id) {
                        this._index[id] = {
                            id: (entry as any).id,
                            title: (entry as any).title || 'Untitled',
                            timestamp: (entry as any).timestamp || '',
                            model: (entry as any).model || '',
                            modelEndpointId: (entry as any).modelEndpointId || '',
                            messageCount: (entry as any).messageCount || 0,
                        };
                    }
                }
                return this._index!;
            }
        } catch { /* corrupted index, rebuild */ }

        // Build index from existing conversation files (backward compatibility)
        // Limit to most recent 100 files to avoid UI freeze on first access
        const MAX_BUILD_FILES = 100;
        this._index = {};
        try {
            const files = fs.readdirSync(this.historyDir)
                .filter(f => f.endsWith('.json') && f !== 'index.json')
                .map(f => {
                    try {
                        return { name: f, mtime: fs.statSync(path.join(this.historyDir, f)).mtimeMs };
                    } catch {
                        return { name: f, mtime: 0 };
                    }
                })
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, MAX_BUILD_FILES);

            for (const f of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.historyDir, f.name), 'utf-8'));
                    if (data.id) {
                        this._index[data.id] = {
                            id: data.id,
                            title: data.title || 'Untitled',
                            timestamp: data.timestamp || '',
                            model: data.model || '',
                            modelEndpointId: data.modelEndpointId || '',
                            messageCount: data.messageCount || 0,
                        };
                    }
                } catch { /* skip corrupted files */ }
            }
            this.saveIndex();
        } catch { /* ignore */ }

        return this._index!;
    }

    /**
     * Persist the index to disk with merge strategy for multi-window safety.
     *
     * Before writing, re-reads the disk index and merges:
     * - Entries only on disk are preserved (added by another window)
     * - Entries in memory take precedence for overlapping keys (our updates win)
     * This prevents concurrent windows from overwriting each other's entries.
     */
    private saveIndex(): void {
        if (!this._index) return;
        try {
            // Merge with disk version to avoid losing entries from other windows
            let merged: HistoryIndex = { ...this._index };
            try {
                if (fs.existsSync(this.indexPath)) {
                    const diskIndex: HistoryIndex = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
                    // Keep disk entries that we don't have in memory (added by another window)
                    // BUT skip entries deleted in this session to prevent re-addition
                    for (const [id, entry] of Object.entries(diskIndex)) {
                        if (!merged[id] && !this._deletedIds.has(id) && entry && typeof entry === 'object' && entry.id) {
                            merged[id] = entry;
                        }
                    }
                }
            } catch { /* corrupted disk index — use memory version only */ }

            atomicWriteSync(this.indexPath, JSON.stringify(merged, null, 2));
            // Update memory to reflect the merged state
            this._index = merged;
        } catch { /* ignore write errors */ }
    }

    // ── Helpers ──

    /**
     * Extract plain text from message content (handles string, ContentPart[], null).
     */
    private extractText(content: string | ContentPart[] | null | undefined): string {
        if (!content) return '';
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.filter(p => p.type === 'text').map(p => p.text || '').join('');
    }

    private trimText(text: string, maxChars: number): string {
        if (!text || text.length <= maxChars) return text || '';
        const head = text.slice(0, Math.floor(maxChars * 0.55));
        const tail = text.slice(-Math.floor(maxChars * 0.35));
        return `${head}\n\n... (${text.length - head.length - tail.length} chars omitted for history responsiveness) ...\n\n${tail}`;
    }

    private trimContent(content: string | ContentPart[] | null | undefined, maxChars: number): string | ContentPart[] {
        if (typeof content === 'string') return this.trimText(content, maxChars);
        if (Array.isArray(content)) {
            return content.map(part => {
                if (part.type === 'text') {
                    return { ...part, text: this.trimText(part.text || '', maxChars) };
                }
                return part;
            });
        }
        return '';
    }

    private extractUserImages(content: string | ContentPart[] | null | undefined): SavedInputHistoryImage[] {
        if (!Array.isArray(content)) return [];
        return content
            .filter((part): part is ContentPart & { type: 'image_url'; image_url?: { url?: string } } => part?.type === 'image_url')
            .map((part, index) => ({
                dataUrl: String(part.image_url?.url || ''),
                name: `image-${index + 1}`,
                size: 0,
            }))
            .filter(image => /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(image.dataUrl))
            .slice(0, 12);
    }

    private extractUserImagesFromMessage(message: ChatMessage): SavedInputHistoryImage[] {
        const uiImages = Array.isArray(message._uiImages)
            ? message._uiImages
                .map((image, index) => ({
                    dataUrl: String(image?.dataUrl || ''),
                    name: String(image?.name || `image-${index + 1}`),
                    size: Number(image?.size || 0),
                }))
                .filter(image => /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(image.dataUrl))
                .slice(0, 12)
            : [];
        return uiImages.length > 0 ? uiImages : this.extractUserImages(message.content);
    }

    // ── Public API ──

    /**
     * Normalize messages before saving to history.
     * Fixes common format issues that cause messy replay:
     * 1. null content → empty string (assistant messages with tool_calls)
     * 2. Ensure reasoning_content is always a string (never undefined)
     * 3. Ensure tool messages have _toolName fallback from tool_calls
     *
     * PERFORMANCE: Only creates copies when normalization is actually needed.
     * Messages that are already well-formed are kept as-is (no deep clone).
     */
    private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
        // Build a map of tool_call_id → tool name from assistant messages
        const toolNameMap = new Map<string, string>();
        for (const m of messages) {
            if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) {
                    toolNameMap.set(tc.id, tc.function.name);
                }
            }
        }

        return messages.map(m => {
            const needsContent = m.content === null || m.content === undefined;
            const needsReasoning = m.role === 'assistant' && m.reasoning_content === undefined;
            const needsToolName = m.role === 'tool' && !m._toolName && m.tool_call_id;
            const needsSnapshotCopy = m.role === 'assistant' && m._uiSnapshot !== undefined;
            const needsUiImagesCopy = m.role === 'user' && m._uiImages !== undefined;
            const maxContent = m.role === 'tool' ? 200_000 : m.role === 'assistant' ? 200_000 : 500_000;
            const content = this.trimContent(m.content, maxContent);
            const reasoning = m.role === 'assistant' && m.reasoning_content
                ? this.trimText(m.reasoning_content, 100_000)
                : m.reasoning_content;

            // Skip copy if message is already well-formed
            if (!needsContent && !needsReasoning && !needsToolName && !needsSnapshotCopy && !needsUiImagesCopy && content === m.content && reasoning === m.reasoning_content) {
                return m;
            }

            const copy: ChatMessage = {
                role: m.role,
                content,
            };

            if (m.role === 'assistant') {
                copy.reasoning_content = reasoning || '';
                if (m.tool_calls) copy.tool_calls = m.tool_calls;
                if (m._elapsedSec !== undefined) copy._elapsedSec = m._elapsedSec;
                if (m._uiSnapshot !== undefined) copy._uiSnapshot = m._uiSnapshot;
            }

            if (m.role === 'user' && m._uiImages !== undefined) {
                copy._uiImages = m._uiImages;
            }

            if (m.role === 'tool') {
                copy.tool_call_id = m.tool_call_id;
                copy._toolName = m._toolName || (m.tool_call_id ? toolNameMap.get(m.tool_call_id) : undefined) || 'tool';
                copy._toolElapsed = m._toolElapsed || 0;
            }

            return copy;
        });
    }

    /**
     * Save or overwrite a conversation by ID.
     * Also updates the lightweight index.
     */
    private buildInputHistory(messages: ChatMessage[]): SavedInputHistoryItem[] {
        const seen = new Set<string>();
        const result: SavedInputHistoryItem[] = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role !== 'user') continue;
            const text = this.extractText(msg.content).trim();
            const images = this.extractUserImagesFromMessage(msg);
            if (!text && images.length === 0) continue;
            const key = JSON.stringify({ text, images: images.map(image => image.dataUrl) });
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({
                text,
                images: images.length > 0 ? images : null,
            });
            if (result.length >= 50) break;
        }
        return result;
    }

    save(
        id: string,
        title: string,
        messages: ChatMessage[],
        model: string,
        metadata: Partial<Pick<HistoryConversation, 'mode' | 'personaId' | 'activeSkillPrompt' | 'inputHistory' | 'modelEndpointId'>> = {},
    ): void {
        if (!this.isSafeId(id)) return;
        const messageCount = messages.filter(m => m.role === 'user' || m.role === 'assistant').length;
        const timestamp = new Date().toISOString();

        // Normalize messages before saving to fix format issues
        const normalized = this.normalizeMessages(messages);

        // Save full conversation file
        const entry: HistoryConversation = {
            id,
            title: title || 'Untitled',
            timestamp,
            model,
            modelEndpointId: metadata.modelEndpointId || '',
            messageCount,
            messages: normalized,
            mode: metadata.mode,
            personaId: metadata.personaId,
            activeSkillPrompt: metadata.activeSkillPrompt,
            inputHistory: metadata.inputHistory || this.buildInputHistory(normalized),
        };
        atomicWriteSync(this.filePath(id), JSON.stringify(entry, null, 2));

        // Update index (O(1) instead of re-reading all files)
        const index = this.loadIndex();
        index[id] = { id, title: title || 'Untitled', timestamp, model, modelEndpointId: metadata.modelEndpointId || '', messageCount };
        this.saveIndex();
    }

    /**
     * List all saved conversations (newest first).
     * Reads only the lightweight index file — O(1) regardless of history size.
     */
    list(): HistoryEntry[] {
        const index = this.loadIndex();
        return Object.values(index)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    /**
     * Load a full conversation by ID.
     * Applies format fixup to ensure old history files render correctly.
     * If fixup was needed, re-saves the file so it's correct on next load.
     */
    load(id: string): HistoryConversation | null {
        if (!this.isSafeId(id)) return null;
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath(id), 'utf-8'));
            if (data && Array.isArray(data.messages)) {
                const { messages: fixed, wasFixed } = this.fixupMessages(data.messages);
                data.messages = fixed;
                // Re-save if fixup changed anything (one-time migration)
                if (wasFixed) {
                    try {
                        atomicWriteSync(this.filePath(id), JSON.stringify(data, null, 2));
                    } catch { /* ignore write errors */ }
                }
            }
            return data as HistoryConversation;
        } catch {
            return null;
        }
    }

    /**
     * Fix common format issues in old history files so they render correctly.
     * This runs on load (not save) to handle legacy data without re-saving everything.
     * Returns [fixedMessages, wasFixed] — caller decides whether to re-save.
     */
    fixupMessages(messages: ChatMessage[]): { messages: ChatMessage[]; wasFixed: boolean } {
        // Build tool name map from assistant messages
        const toolNameMap = new Map<string, string>();
        for (const m of messages) {
            if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) {
                    toolNameMap.set(tc.id, tc.function.name);
                }
            }
        }

        let wasFixed = false;
        const result = messages.map(m => {
            // null content → empty string
            if (m.content === null || m.content === undefined) {
                m = { ...m, content: '' };
                wasFixed = true;
            }
            // Ensure reasoning_content is always a string
            if (m.role === 'assistant' && m.reasoning_content === undefined) {
                m = { ...m, reasoning_content: '' };
                wasFixed = true;
            }
            // Ensure tool messages have _toolName
            if (m.role === 'tool' && !m._toolName && m.tool_call_id) {
                const fallback = toolNameMap.get(m.tool_call_id) || 'tool';
                m = { ...m, _toolName: fallback };
                wasFixed = true;
            }
            return m;
        });

        return { messages: wasFixed ? result : messages, wasFixed };
    }

    /**
     * Delete a conversation by ID.
     * Also removes from the index.
     */
    delete(id: string): boolean {
        if (!this.isSafeId(id)) return false;
        try {
            const fp = this.filePath(id);
            if (fs.existsSync(fp)) {
                fs.unlinkSync(fp);
            }
            // Remove from index and track deletion to prevent re-addition from disk
            const index = this.loadIndex();
            delete index[id];
            this._deletedIds.add(id);
            this.saveIndex();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Search conversations by keyword (full-text search on titles and messages).
     */
    search(query: string): HistoryEntry[] {
        const lower = query.toLowerCase().trim();
        const index = this.loadIndex();
        const results: HistoryEntry[] = [];
        const matchedIds = new Set<string>();
        if (!lower) return this.list();

        // Search titles from index (fast)
        if (lower.length < 2) {
            return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        }
        const entries = Object.values(index)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, 80);
        for (const entry of entries) {
            if (entry.title?.toLowerCase().includes(lower)) {
                results.push(entry);
                matchedIds.add(entry.id);
            }
        }

        // Search message content (requires reading full files — slower)
        for (const entry of Object.values(index)) {
            if (matchedIds.has(entry.id)) continue; // already matched by title
            try {
                const data = JSON.parse(fs.readFileSync(this.filePath(entry.id), 'utf-8')) as HistoryConversation;
                for (const msg of data.messages || []) {
                    const content = this.extractText(msg.content);
                    if (content.toLowerCase().includes(lower)) {
                        results.push(entry);
                        matchedIds.add(entry.id);
                        break;
                    }
                }
            } catch { /* skip corrupted files */ }
        }

        return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    }

    /**
     * Export a conversation to Markdown.
     * Accepts either a conversation ID (string) or a pre-loaded HistoryConversation.
     */
    exportMarkdown(idOrConv: string | HistoryConversation): string | null {
        const conv = typeof idOrConv === 'string' ? this.load(idOrConv) : idOrConv;
        if (!conv) return null;

        let md = `# ${conv.title}\n\n`;
        md += `> Model: ${conv.model}\n`;
        md += `> Date: ${conv.timestamp}\n`;
        md += `> Messages: ${conv.messageCount}\n\n---\n\n`;

        for (const msg of conv.messages) {
            if (msg.role === 'user') {
                const text = this.extractText(msg.content);
                md += `## User\n\n${text}\n\n`;
            } else if (msg.role === 'assistant') {
                const text = this.extractText(msg.content);
                if (text) md += `## Assistant\n\n${text}\n\n`;
            }
        }

        return md;
    }

    /**
     * Export a conversation to JSON.
     * Accepts either a conversation ID (string) or a pre-loaded HistoryConversation.
     */
    exportJson(idOrConv: string | HistoryConversation): string | null {
        const conv = typeof idOrConv === 'string' ? this.load(idOrConv) : idOrConv;
        if (!conv) return null;
        return JSON.stringify(conv, null, 2);
    }

    /**
     * Export all conversations as a JSON array.
     */
    exportAllJson(): string {
        const entries = this.list();
        const conversations = entries.map(e => this.load(e.id)).filter(Boolean);
        return JSON.stringify(conversations, null, 2);
    }
}
