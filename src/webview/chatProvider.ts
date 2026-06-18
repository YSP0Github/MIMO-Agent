import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { MiMoAgent } from '../agent';
import { AgentMode } from '../agent';
import { HistoryManager } from '../history';
import { readSettings, saveSetting, getSettingsPanel, loadConfig } from '../config';
import { renderMarkdown, renderStreamingMarkdown } from '../markdown';
import { ApiEndpointMode, ContentPart, ChatMessage, MiMoAPI, normalizeApiEndpointMode } from '../api';
import { getContextStats } from '../context';
import { buildPlanExecutionMessage, getMimoPlansDir, looksLikePlanResponse, sanitizePlanMarkdown } from '../planMode';
import { ReadonlyPreviewProvider } from '../readonlyPreview';

/**
 * Auto-clean old plan files in ~/.mimo/plans/
 * Rules:
 *  - Max total size: 10MB
 *  - Max file count: 50
 *  - Always keep the 10 most recent files
 * Runs after each plan save; no-ops on error.
 */
function cleanOldPlans(dir: string): void {
    try {
        const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
        const MAX_COUNT = 50;
        const KEEP_RECENT = 10;

        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.md'))
            .map(f => {
                const fp = path.join(dir, f);
                const stat = fs.statSync(fp);
                return { name: f, path: fp, size: stat.size, mtime: stat.mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime); // newest first

        if (files.length <= KEEP_RECENT) return; // too few to clean

        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const needsClean = files.length > MAX_COUNT || totalSize > MAX_SIZE_BYTES;
        if (!needsClean) return;

        // Delete oldest files (starting after KEEP_RECENT), stop when under both limits
        let freed = 0;
        let deleted = 0;
        for (let i = KEEP_RECENT; i < files.length; i++) {
            // Check after each deletion: stop when BOTH size and count are within limits
            const currentSize = totalSize - freed;
            const currentCount = files.length - deleted;
            if (currentSize <= MAX_SIZE_BYTES && currentCount <= MAX_COUNT) break;

            const f = files[i];
            try {
                fs.unlinkSync(f.path);
                freed += f.size;
                deleted++;
            } catch { /* skip files that can't be deleted (locked, permissions) */ }
        }
    } catch { /* ignore cleanup errors */ }
}

function extractText(content: string | ContentPart[] | null | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(p => p.type === 'text').map(p => p.text || '').join('');
}

function extractInputHistory(messages: ChatMessage[]): Array<{ text: string; images: Array<{ dataUrl: string; name: string; size: number }> | null }> {
    const seen = new Set<string>();
    const result: Array<{ text: string; images: Array<{ dataUrl: string; name: string; size: number }> | null }> = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;
        const text = extractText(msg.content).trim();
        const images = Array.isArray(msg.content)
            ? msg.content
                .filter((part: any) => part?.type === 'image_url' && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(String(part?.image_url?.url || '')))
                .map((part: any, index: number) => ({
                    dataUrl: String(part.image_url?.url || ''),
                    name: `image-${index + 1}`,
                    size: 0,
                }))
                .slice(0, 12)
            : [];
        if (!text && images.length === 0) continue;
        const key = JSON.stringify({ text, images: images.map(image => image.dataUrl) });
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ text, images: images.length > 0 ? images : null });
        if (result.length >= 50) break;
    }
    return result;
}

function formatContextTokenCount(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1_000_000) {
        const v = n / 1_000_000;
        return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}M`;
    }
    if (n >= 1_000) {
        const v = n / 1_000;
        return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}k`;
    }
    return String(Math.round(n));
}

function isPathInside(parent: string, child: string): boolean {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function sanitizeString(value: unknown, maxLen: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value.replace(/\x00/g, '').trim().slice(0, maxLen);
}

function escapeHtml(value: string): string {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        '\'': '&#39;',
    }[ch] || ch));
}

function sanitizeNumber(value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(max, Math.max(min, value));
}

function sanitizeBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function detectProviderFromBaseUrl(baseUrl: string): string {
    const normalized = String(baseUrl || '').toLowerCase();
    if (normalized.includes('xiaomimimo') || normalized.includes('mimo')) return 'mimo';
    if (normalized.includes('deepseek')) return 'deepseek';
    if (normalized.includes('openai.com')) return 'openai';
    if (normalized.includes('dashscope.aliyuncs.com')) return 'qwen';
    if (normalized.includes('open.bigmodel.cn') || normalized.includes('api.z.ai')) return 'zhipu';
    if (normalized.includes('moonshot.cn') || normalized.includes('moonshot.ai')) return 'moonshot';
    if (normalized.includes('volces.com')) return 'volcengine';
    if (normalized.includes('siliconflow')) return 'siliconflow';
    if (normalized.includes('qianfan.baidubce.com')) return 'qianfan';
    if (normalized.includes('hunyuan.cloud.tencent.com')) return 'hunyuan';
    if (normalized.includes('openrouter.ai')) return 'openrouter';
    if (normalized.includes('groq.com')) return 'groq';
    if (normalized.includes('generativelanguage.googleapis.com')) return 'gemini';
    if (normalized.includes('mistral.ai')) return 'mistral';
    if (normalized.includes('api.x.ai')) return 'xai';
    return 'custom';
}

function sanitizeMode(value: unknown): AgentMode | undefined {
    return value === 'auto' || value === 'polling' || value === 'plan' || value === 'adversarial' || value === 'infinite'
        ? value
        : undefined;
}

function pendingAiTitle(input: string): string {
    return buildLocalConversationTitle(input);
}

function buildLocalConversationTitle(input: string): string {
    const raw = String(input || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!raw) return vscode.env.language.startsWith('zh') ? '\u65b0\u4efb\u52a1' : 'New task';

    const fileMatch = raw.match(/(?:^|[\s"'`])(?:[\w.-]+[\\/])+([\w.-]+\.[A-Za-z0-9]{1,8})\b/)
        || raw.match(/\b([\w.-]+\.[A-Za-z0-9]{1,8})\b/);
    const fileName = fileMatch?.[1] || '';
    const lower = raw.toLowerCase();
    const isChinese = /[\u4e00-\u9fff]/.test(raw) || vscode.env.language.startsWith('zh');
    if (fileName) {
        if (/fix|bug|error|\u62a5\u9519|\u4fee\u590d|\u9519\u8bef|\u95ee\u9898/.test(lower)) return isChinese ? `\u4fee\u590d ${fileName}` : `Fix ${fileName}`;
        if (/optimi[sz]e|polish|beautify|style|layout|\u4f18\u5316|\u7f8e\u5316|\u8c03\u6574|\u6539\u8fdb/.test(lower)) return isChinese ? `\u4f18\u5316 ${fileName}` : `Optimize ${fileName}`;
        if (/explain|why|how|\u89e3\u91ca|\u8bf4\u660e|\u5206\u6790/.test(lower)) return isChinese ? `\u89e3\u91ca ${fileName}` : `Explain ${fileName}`;
        return isChinese ? `\u5904\u7406 ${fileName}` : `Update ${fileName}`;
    }

    let title = raw
        .replace(/^(?:please\s+)?(?:help\s+me\s+|can\s+you\s+|could\s+you\s+)/i, '')
        .replace(/^(?:\u5e2e\u6211|\u8bf7|\u80fd\u4e0d\u80fd|\u53ef\u4ee5\u5e2e\u6211|\u9ebb\u70e6\u4f60)\s*/i, '')
        .replace(/[\u3002\uff01\uff1f.!?]+$/g, '')
        .trim();
    title = sanitizeAiTitle(title) || (isChinese ? '\u65b0\u4efb\u52a1' : 'New task');
    return title;
}

function sanitizeAiTitle(raw: string): string {
    let title = (raw || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^["'“”‘’《》\s]+|["'“”‘’《》\s]+$/g, '')
        .replace(/^(标题|title)\s*[:：]\s*/i, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    title = title.replace(/[。！？.!?]+$/g, '').trim();
    if (!title) return '';
    const hasChinese = /[\u4e00-\u9fff]/.test(title);
    const maxLen = hasChinese ? 18 : 48;
    if (title.length > maxLen) title = title.slice(0, maxLen).trim();
    return title;
}

function sanitizeImages(input: unknown): Array<{ dataUrl: string; name: string; size: number }> | undefined {
    if (!Array.isArray(input)) return undefined;
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
    const MAX_IMAGES = 8;
    const out: Array<{ dataUrl: string; name: string; size: number }> = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        const dataUrl = sanitizeString(raw.dataUrl, Math.ceil(MAX_IMAGE_BYTES * 1.4));
        if (!dataUrl || !/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(dataUrl)) continue;
        const size = sanitizeNumber(raw.size, 0, MAX_IMAGE_BYTES) ?? 0;
        const name = sanitizeString(raw.name, 256) || 'image';
        out.push({ dataUrl, name, size });
        if (out.length >= MAX_IMAGES) break;
    }
    return out.length > 0 ? out : undefined;
}

function sanitizeSettings(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== 'object') return {};
    const s = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const apiKey = sanitizeString(s.api_key, 4096);
    if (apiKey !== undefined) out.api_key = apiKey;
    const baseUrl = sanitizeString(s.base_url, 2048);
    if (baseUrl && /^https?:\/\//i.test(baseUrl)) out.base_url = baseUrl.replace(/\/+$/, '');
    const model = sanitizeString(s.model, 128);
    if (model !== undefined) out.model = model;
    const apiEndpointRaw = sanitizeString(s.api_endpoint, 32);
    if (apiEndpointRaw !== undefined) out.api_endpoint = normalizeApiEndpointMode(apiEndpointRaw);
    const activeProviderProfile = sanitizeString(s.active_provider_profile, 80);
    if (activeProviderProfile !== undefined) out.active_provider_profile = activeProviderProfile;
    if (s.active_route && typeof s.active_route === 'object') {
        const rawRoute = s.active_route as Record<string, unknown>;
        const endpointId = sanitizeString(rawRoute.endpoint_id, 80);
        const routeModel = sanitizeString(rawRoute.model, 128);
        if (endpointId && routeModel) out.active_route = { endpoint_id: endpointId, model: routeModel };
    }
    if (Array.isArray(s.provider_profiles)) {
        out.provider_profiles = s.provider_profiles
            .map((profile) => {
                if (!profile || typeof profile !== 'object') return undefined;
                const raw = profile as Record<string, unknown>;
                const id = sanitizeString(raw.id, 80);
                const name = sanitizeString(raw.name, 120) || id;
                const provider = sanitizeString(raw.provider, 80) || detectProviderFromBaseUrl(String(raw.base_url || ''));
                const baseUrl = sanitizeString(raw.base_url, 2048);
                const apiEndpoint = normalizeApiEndpointMode(raw.api_endpoint);
                const profileModel = sanitizeString(raw.model, 128) || '';
                const apiKey = sanitizeString(raw.api_key, 4096) || '';
                const profileModels = Array.isArray(raw.models)
                    ? raw.models.map(v => sanitizeString(v, 128)).filter((v): v is string => !!v).slice(0, 100)
                    : [];
                if (!id || !baseUrl || !/^https?:\/\//i.test(baseUrl)) return undefined;
                return {
                    id,
                    name,
                    provider,
                    show_in_picker: raw.show_in_picker !== false,
                    base_url: baseUrl.replace(/\/+$/, ''),
                    api_endpoint: apiEndpoint,
                    model: profileModel,
                    api_key: apiKey,
                    models: profileModels,
                };
            })
            .filter(Boolean)
            .slice(0, 50);
    }
    if (Array.isArray(s.models)) {
        out.models = s.models
            .map(v => sanitizeString(v, 128))
            .filter((v): v is string => !!v)
            .slice(0, 50);
    }
    const maxTokens = sanitizeNumber(s.max_tokens, 256, 65536);
    if (maxTokens !== undefined) out.max_tokens = Math.round(maxTokens);
    const temperature = sanitizeNumber(s.temperature, 0, 2);
    if (temperature !== undefined) out.temperature = temperature;
    const topP = sanitizeNumber(s.top_p, 0, 1);
    if (topP !== undefined) out.top_p = topP;
    const reasoningEffort = sanitizeString(s.reasoning_effort, 16);
    if (reasoningEffort) {
        const normalizedReasoning =
            reasoningEffort === 'off' || reasoningEffort === 'low' ? 'fast' :
            reasoningEffort === 'auto' || reasoningEffort === 'medium' ? 'balanced' :
            reasoningEffort === 'high' ? 'deep' :
            ['turbo', 'fast', 'balanced', 'deep', 'max'].includes(reasoningEffort) ? reasoningEffort : undefined;
        if (normalizedReasoning) {
            out.reasoning_effort = normalizedReasoning;
            out.enable_thinking = normalizedReasoning === 'deep' || normalizedReasoning === 'max';
        }
    }
    const maxOutputLen = sanitizeNumber(s.max_output_len, 1000, 200000);
    if (maxOutputLen !== undefined) out.max_output_len = Math.round(maxOutputLen);
    const commandTimeout = sanitizeNumber(s.command_timeout, 5, 3600);
    if (commandTimeout !== undefined) out.command_timeout = Math.round(commandTimeout);
    const completionSoundVolume = sanitizeNumber(s.ui_completion_sound_volume, 0, 100);
    if (completionSoundVolume !== undefined) out.ui_completion_sound_volume = Math.round(completionSoundVolume);
    const dependencyLongTimeout = sanitizeNumber(s.dependency_install_long_timeout_sec, 60, 3600);
    if (dependencyLongTimeout !== undefined) out.dependency_install_long_timeout_sec = Math.round(dependencyLongTimeout);
    const memoryMaxItems = sanitizeNumber(s.memory_max_items, 10, 500);
    if (memoryMaxItems !== undefined) out.memory_max_items = Math.round(memoryMaxItems);
    const memoryMaxInjected = sanitizeNumber(s.memory_max_injected, 0, 20);
    if (memoryMaxInjected !== undefined) out.memory_max_injected = Math.round(memoryMaxInjected);
    const dependencyProjectMode = sanitizeString(s.dependency_install_project_mode, 32);
    if (dependencyProjectMode && ['auto', 'confirm', 'disabled'].includes(dependencyProjectMode)) {
        out.dependency_install_project_mode = dependencyProjectMode;
    }
    const dependencySystemMode = sanitizeString(s.dependency_install_system_mode, 32);
    if (dependencySystemMode && ['confirm', 'disabled'].includes(dependencySystemMode)) {
        out.dependency_install_system_mode = dependencySystemMode;
    }
    const sandboxCpu = sanitizeNumber(s.sandbox_cpu, 1, 8);
    if (sandboxCpu !== undefined) out.sandbox_cpu = Math.round(sandboxCpu);
    const sandboxMode = sanitizeString(s.sandbox_mode, 32);
    if (sandboxMode && ['safe', 'docker'].includes(sandboxMode)) out.sandbox_mode = sandboxMode;
    for (const key of ['enable_thinking', 'ui_completion_sound', 'sandbox_enabled', 'sandbox_git_snapshot', 'sandbox_logging', 'sandbox_network_disabled', 'dependency_install_enabled', 'memory_enabled', 'memory_learn_from_explicit_preferences']) {
        const value = sanitizeBoolean(s[key]);
        if (value !== undefined) out[key] = value;
    }
    const sandboxImage = sanitizeString(s.sandbox_image, 200);
    if (sandboxImage !== undefined) out.sandbox_image = sandboxImage;
    const sandboxMemory = sanitizeString(s.sandbox_memory, 32);
    if (sandboxMemory !== undefined) out.sandbox_memory = sandboxMemory;
    return out;
}

function sanitizeSkill(input: unknown): { name: string; description: string; tools?: string[]; prompt: string } | null {
    if (!input || typeof input !== 'object') return null;
    const raw = input as Record<string, unknown>;
    const name = sanitizeString(raw.name, 80);
    const description = sanitizeString(raw.description, 500);
    const prompt = sanitizeString(raw.prompt, 50_000);
    if (!name || !/^[\w.-]+$/.test(name) || description === undefined || !prompt) return null;
    const tools = Array.isArray(raw.tools)
        ? raw.tools.map(v => sanitizeString(v, 80)).filter((v): v is string => !!v).slice(0, 50)
        : undefined;
    return { name, description, prompt, tools };
}

function trimWebviewToolResult(result: string, maxChars = 3_500): string {
    if (!result || result.length <= maxChars) return result || '';
    const head = result.slice(0, Math.floor(maxChars * 0.7));
    const tail = result.slice(-Math.floor(maxChars * 0.25));
    return `${head}\n\n... output truncated for Webview responsiveness (${result.length} chars). Showing head and tail only. ...\n\n${tail}`;
}

function createReasoningPostQueue(post: (msg: any) => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let buffer = '';
    const MAX_BUFFER_CHARS = 6_000;

    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (!buffer) return;
        const token = buffer;
        buffer = '';
        post({ type: 'reasoning', token });
    };

    return {
        push(token: string) {
            if (!token) return;
            buffer += token;
            if (buffer.length > MAX_BUFFER_CHARS) {
                buffer = buffer.slice(-MAX_BUFFER_CHARS);
            }
            if (buffer.length >= 1_500) {
                flush();
                return;
            }
            if (!timer) {
                timer = setTimeout(flush, 900);
            }
        },
        flush,
        cancel() {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            buffer = '';
        },
    };
}

function createStreamingRenderQueue(post: (msg: any) => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastText = '';
    let lastRenderedText = '';

    const renderNow = (text: string) => {
        if (text === lastRenderedText) return;
        lastRenderedText = text;
        try {
            post({ type: 'streamHtml', html: renderStreamingMarkdown(text), lightweight: true });
        } catch (e: any) {
            post({ type: 'error', error: `Render failed: ${e?.message || String(e)}` });
        }
    };

    return {
        schedule(text: string) {
            lastText = text;
            if (timer) return;
            const delay = text.length > 30_000 ? 1800 : text.length > 12_000 ? 1000 : 500;
            timer = setTimeout(() => {
                timer = undefined;
                renderNow(lastText);
            }, delay);
        },
        flush(text?: string) {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            renderNow(text ?? lastText);
        },
        cancel() {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
        },
    };
}

function renderAssistantMarkdown(post: (msg: any) => void, type: 'assistantUpdate' | 'verificationUpdate' | 'finalAnswer', text: string): void {
    if (!text.trim()) return;
    try {
        post({ type, html: renderMarkdown(text) });
    } catch (e: any) {
        post({ type: 'error', error: `Render failed: ${e?.message || String(e)}` });
    }
}

interface TurnChangeFile {
    path: string;
    added: number;
    removed: number;
    action?: string;
    source?: 'tool';
    hasToolDiff?: boolean;
}

interface TurnFileSnapshot {
    path: string;
    existed: boolean;
    content?: string;
    skipped?: string;
}

interface TurnChangeTracker {
    files: Map<string, TurnChangeFile>;
    snapshots: Map<string, TurnFileSnapshot>;
}

interface PanelState {
    panel: vscode.WebviewPanel;
    convId: string;        // initial conversation ID (for init)
    convIds: string[];     // all conversation IDs belonging to this panel
    activeConvId: string;  // currently active conversation in THIS panel
    pendingInit?: { firstId: string; fresh: boolean };
    activeHandlers?: any;
    /** Message queue: messages sent while agent is running */
    messageQueue: Array<{ text: string; images?: Array<{ dataUrl: string; name: string; size: number }> }>;
    /** Voice input state -per-panel */
    voiceProcess?: ReturnType<typeof exec> | null;
    voiceResultFile?: string;
    voicePsFile?: string;
    /** Track whether initial restore has been done (avoid full replay on every visibility change) */
    restored?: boolean;
    /** Plan mode: per-panel plan file path and ID */
    planPath?: string;
    planId?: string;
    planContent?: string;
    /** User explicitly pressed Stop for the current turn */
    stopRequested?: boolean;
}

function isUserStoppedMessage(value: unknown): boolean {
    const text = String(value || '').trim();
    return text === '(stopped by user)' || /^aborted$/i.test(text) || /stopped by user|stopped manually|aborted by user/i.test(text);
}

interface SerializedChatPanelState {
    kind?: string;
    convIds?: string[];
    activeConvId?: string;
    uiLang?: 'en' | 'zh';
}

interface WorkspaceFilePickerEntry {
    name: string;
    relativePath: string;
    fullPath: string;
    kind: 'file' | 'directory';
    depth: number;
    parent: string;
}

type ReasoningEffort = 'turbo' | 'fast' | 'balanced' | 'deep' | 'max';

export class ChatViewProvider {
    private panels = new Map<string, PanelState>();
    private panel?: vscode.WebviewPanel;  // current/active panel reference
    private agent: MiMoAgent;
    private history: HistoryManager;
    private cssContent: string = '';
    private replaySeq = 0;
    private windowReasoningEffort: ReasoningEffort;
    private activeTurnTokens = new Map<string, string>();
    private workspaceFileCache?: { root: string; createdAt: number; entries: WorkspaceFilePickerEntry[] };
    private pendingHistorySaves = new Map<string, {
        title: string;
        messages: ChatMessage[];
        model: string;
        metadata: Partial<Pick<import('../history').HistoryConversation, 'mode' | 'personaId' | 'activeSkillPrompt' | 'inputHistory' | 'modelEndpointId'>>;
    }>();
    private historySaveTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly extensionUri: vscode.Uri,
        agent: MiMoAgent,
        private readonly readonlyPreviewProvider: ReadonlyPreviewProvider,
        private readonly windowSessionId?: string,
    ) {
        this.agent = agent;
        const initialConfig = loadConfig();
        this.windowReasoningEffort = initialConfig.reasoningEffort;
        this.history = new HistoryManager(initialConfig.workspace, windowSessionId);
        this.loadCss();
    }

    private queueHistorySave(
        id: string,
        title: string,
        messages: ChatMessage[],
        model: string,
        metadata: Partial<Pick<import('../history').HistoryConversation, 'mode' | 'personaId' | 'activeSkillPrompt' | 'inputHistory' | 'modelEndpointId'>> = {},
    ): void {
        this.pendingHistorySaves.set(id, { title, messages, model, metadata });
        if (this.historySaveTimer) return;
        this.historySaveTimer = setTimeout(() => {
            this.historySaveTimer = undefined;
            const saves = Array.from(this.pendingHistorySaves.entries());
            this.pendingHistorySaves.clear();
            setImmediate(() => {
                for (const [convId, save] of saves) {
                    try {
                        this.history.save(convId, save.title, save.messages, save.model, save.metadata);
                    } catch {
                        // Best effort; UI responsiveness matters more than history persistence.
                    }
                }
            });
        }, 1200);
    }

    private historyMetadata(conv: import('../agentTypes').ConversationState): Partial<Pick<import('../history').HistoryConversation, 'mode' | 'personaId' | 'activeSkillPrompt' | 'modelEndpointId'>> {
        return {
            mode: conv.mode,
            personaId: conv.personaId,
            activeSkillPrompt: conv.activeSkillPrompt,
            modelEndpointId: conv.modelEndpointId,
        };
    }

    private attachUiSnapshot(convId: string, snapshot: any): void {
        if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.assistantHtml !== 'string') return;
        if (snapshot.assistantHtml.length > 750_000) return;
        const messages = this.agent.getMessages(convId);
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                messages[i]._uiSnapshot = snapshot;
                return;
            }
        }
    }

    flushHistorySaves(): void {
        if (this.historySaveTimer) {
            clearTimeout(this.historySaveTimer);
            this.historySaveTimer = undefined;
        }
        const saves = Array.from(this.pendingHistorySaves.entries());
        this.pendingHistorySaves.clear();
        for (const [convId, save] of saves) {
            try {
                this.history.save(convId, save.title, save.messages, save.model, save.metadata);
            } catch {
                // Best effort during shutdown.
            }
        }
    }

    refreshModelLists(): void {
        const models = this.agent.getModelOptions();
        for (const st of this.panels.values()) {
            const panel = st.panel;
            const current = this.agent.getModelSelectionValue(st.activeConvId);
            panel.webview.postMessage({ type: 'modelList', models, current });
            panel.webview.postMessage({ type: 'modelCaps', caps: this.agent.getModelCapabilities(current) });
            panel.webview.postMessage({ type: 'settingsData', settings: this.getWindowSettingsPanel() });
        }
    }

    handleSettingsApplied(): void {
        this.windowReasoningEffort = loadConfig().reasoningEffort;
        this.refreshModelLists();
    }

    setModelForOpenPanels(model: string): void {
        for (const st of this.panels.values()) {
            if (st.activeConvId) this.agent.setModel(model, st.activeConvId);
        }
        this.refreshModelLists();
    }

    private modelListMessage(convId: string): { type: 'modelList'; models: any[]; current: string } {
        return {
            type: 'modelList',
            models: this.agent.getModelOptions(),
            current: this.agent.getModelSelectionValue(convId),
        };
    }

    private inputHistoryForConversation(convId: string): Array<{ text: string; images: Array<{ dataUrl: string; name: string; size: number }> | null }> {
        const conv = this.agent.getConversation(convId);
        return conv ? extractInputHistory(conv.messages) : [];
    }

    private postInputHistory(panel: vscode.WebviewPanel, convId: string): void {
        panel.webview.postMessage({
            type: 'restoreInputHistory',
            items: this.inputHistoryForConversation(convId),
        });
    }

    private getPreferredUiLang(): 'en' | 'zh' {
        const saved = readSettings()?.ui?.language;
        if (saved === 'en' || saved === 'zh') return saved;
        return vscode.env.language.startsWith('zh') ? 'zh' : 'en';
    }

    private getWindowSettingsPanel(): Record<string, any> {
        const settings = getSettingsPanel();
        return {
            ...settings,
            reasoning_effort: this.windowReasoningEffort,
            enable_thinking: this.windowReasoningEffort === 'deep' || this.windowReasoningEffort === 'max',
        };
    }

    private getWorkspaceFileEntries(root: string): WorkspaceFilePickerEntry[] {
        const now = Date.now();
        if (
            this.workspaceFileCache &&
            this.workspaceFileCache.root === root &&
            now - this.workspaceFileCache.createdAt < 3_000
        ) {
            return this.workspaceFileCache.entries;
        }

        const results: WorkspaceFilePickerEntry[] = [];
        const ignored = new Set(['.git', 'node_modules', 'out', 'dist', '.vscode', '__pycache__']);
        const ignoredFileExt = new Set(['.pyc', '.pyo', '.map']);
        const maxEntries = 2_500;
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
        const walk = (dir: string, depth: number): void => {
            if (depth > 8 || results.length >= maxEntries) return;
            try {
                const entries = sortEntries(fs.readdirSync(dir, { withFileTypes: true }));
                for (const entry of entries) {
                    if (results.length >= maxEntries) break;
                    if (entry.name.startsWith('.') || ignored.has(entry.name)) continue;
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        results.push(toEntry(fullPath, 'directory'));
                        walk(fullPath, depth + 1);
                    } else if (entry.isFile() && !ignoredFileExt.has(path.extname(entry.name).toLowerCase())) {
                        results.push(toEntry(fullPath, 'file'));
                    }
                }
            } catch { /* skip inaccessible dirs */ }
        };
        walk(root, 0);
        this.workspaceFileCache = { root, createdAt: now, entries: results };
        return results;
    }

    private searchWorkspaceFiles(query: string, maxResults: number): WorkspaceFilePickerEntry[] {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) return [];
        const root = workspaceFolders[0].uri.fsPath;
        const lowerQuery = query.trim().toLowerCase();
        const entries = this.getWorkspaceFileEntries(root);
        if (!lowerQuery) return entries.slice(0, maxResults);
        return entries
            .filter(entry => entry.kind === 'file')
            .filter(entry => entry.name.toLowerCase().includes(lowerQuery) || entry.relativePath.toLowerCase().includes(lowerQuery))
            .slice(0, maxResults);
    }

    private setWindowReasoningEffort(effort: ReasoningEffort): void {
        this.windowReasoningEffort = effort;
        this.agent.setReasoningEffort(effort);
    }

    private loadCss(): void {
        try {
            const cssPath = path.join(this.extensionUri.fsPath, 'out', 'webview', 'styles.css');
            this.cssContent = fs.readFileSync(cssPath, 'utf-8');
        } catch {
            try {
                const cssPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'styles.css');
                this.cssContent = fs.readFileSync(cssPath, 'utf-8');
            } catch {
                this.cssContent = '/* CSS not found */';
            }
        }
    }

    private async generateAiTitle(input: string): Promise<string | null> {
        const cfg = loadConfig();
        if (!cfg.apiKey || !cfg.baseUrl) {
            console.warn('[MiMo] AI title generation skipped: API key or base URL missing.');
            return null;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
            console.log(`[MiMo] Generating AI title with model ${cfg.model || 'mimo-v2.5-pro'}`);
            const api = new MiMoAPI(cfg.apiKey, cfg.baseUrl, cfg.apiEndpoint as ApiEndpointMode);
            const result = await api.chatCompletion({
                model: cfg.model || 'mimo-v2.5-pro',
                messages: [
                    {
                        role: 'system',
                        content: [
                            'You generate concise chat titles.',
                            'Return only one title, no quotes, no explanation.',
                            'Prefer the pattern: subject + core problem + action.',
                            'Chinese input: 8 to 18 Chinese characters.',
                            'English input: 3 to 6 words.',
                            'Do not copy filler like "help me", "can you", "what do you think", or screenshot labels.',
                            'Do not mention files unless they are the main topic.',
                        ].join(' '),
                    },
                    {
                        role: 'user',
                        content: `Create a concise title for this user request:\n\n${input.slice(0, 1800)}`,
                    },
                ],
                max_tokens: 32,
                temperature: 0.2,
                top_p: 0.8,
                stream_options: null,
                extra_body: { thinking: { type: 'disabled' } },
            }, controller.signal);
            const title = sanitizeAiTitle(result);
            console.log(`[MiMo] AI title result: ${title || '(empty)'}`);
            return title && title !== 'New Chat' ? title : null;
        } catch (e) {
            console.warn('[MiMo] AI title generation failed:', e);
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private shouldAutoTitleConversation(conv: import('../agentTypes').ConversationState): boolean {
        const userMessages = conv.messages.filter(msg => msg.role === 'user').length;
        const assistantMessages = conv.messages.filter(msg => msg.role === 'assistant').length;
        return userMessages === 0 && assistantMessages === 0;
    }

    private scheduleAiTitle(
        activeId: string,
        panel: vscode.WebviewPanel,
        text: string,
        pendingTitle: string,
    ): void {
        const startedAt = Date.now();
        const runWhenIdle = () => {
            const conv = this.agent.getConversation(activeId);
            if (!conv || conv.title !== pendingTitle) return;
            if (this.agent.isConvBusy(activeId) && Date.now() - startedAt < 120_000) {
                setTimeout(runWhenIdle, 1_500);
                return;
            }
            this.runAiTitleGeneration(activeId, panel, text, pendingTitle);
        };
        setTimeout(runWhenIdle, 2_500);
    }

    private runAiTitleGeneration(
        activeId: string,
        panel: vscode.WebviewPanel,
        text: string,
        pendingTitle: string,
    ): void {
        this.generateAiTitle(text).then((title) => {
            if (!title) {
                console.warn(`[MiMo] AI title generation produced no usable title for convId=${activeId}.`);
                return;
            }
            const conv = this.agent.getConversation(activeId);
            if (!conv || conv.title !== pendingTitle) {
                console.log(`[MiMo] AI title ignored for convId=${activeId}: conversation title changed before result.`);
                return;
            }
            conv.title = title;
            const st = this.findStateByPanel(panel);
            panel.webview.postMessage({ type: 'tabList', tabs: this.getTabList(st?.convIds, activeId), activeId });
            panel.title = title;
            panel.webview.postMessage({ type: 'convTitle', title, convId: activeId });
            try {
                const msgs = this.agent.getMessages(activeId);
                this.queueHistorySave(activeId, conv.title, msgs, conv.model, this.historyMetadata(conv));
            } catch { /* best effort only */ }
        });
    }

    /** Create a new MIMO panel (always creates fresh) */
    show(_forceNew = true) {
        // Always create new panel -each click = new window
        const splitEditor = this.panels.size === 0;
        this.createPanel(splitEditor);
    }

    restorePanel(panel: vscode.WebviewPanel, state: unknown): void {
        this.createPanel(false, panel, this.sanitizeSerializedPanelState(state));
    }

    private sanitizeSerializedPanelState(state: unknown): SerializedChatPanelState | undefined {
        if (!state || typeof state !== 'object') return undefined;
        const raw = state as Record<string, unknown>;
        const convIds = Array.isArray(raw.convIds)
            ? raw.convIds
                .map(id => sanitizeString(id, 120))
                .filter((id): id is string => !!id)
                .slice(0, 20)
            : [];
        const activeConvId = sanitizeString(raw.activeConvId, 120);
        const uiLang = raw.uiLang === 'en' ? 'en' : raw.uiLang === 'zh' ? 'zh' : undefined;
        if (convIds.length === 0 && !activeConvId) return undefined;
        return {
            kind: sanitizeString(raw.kind, 40),
            convIds,
            activeConvId,
            uiLang,
        };
    }

    private ensureRestoredConversation(id: string): boolean {
        if (!id) return false;
        if (this.agent.getConversation(id)) return true;
        const histConv = this.history.load(id);
        if (!histConv) return false;
        this.agent.loadConversation(id, histConv.title, histConv.messages, histConv.model, {
            mode: sanitizeMode(histConv.mode),
            personaId: histConv.personaId,
            activeSkillPrompt: histConv.activeSkillPrompt,
            modelEndpointId: histConv.modelEndpointId,
        });
        return true;
    }

    private resolveRestoredConversationIds(restored?: SerializedChatPanelState): { convIds: string[]; activeConvId: string; fresh: boolean } {
        const requested = Array.from(new Set([
            ...(restored?.convIds || []),
            restored?.activeConvId || '',
        ].filter(Boolean)));
        const convIds = requested.filter(id => this.ensureRestoredConversation(id));
        let activeConvId = restored?.activeConvId && convIds.includes(restored.activeConvId)
            ? restored.activeConvId
            : convIds[0];
        if (!activeConvId) {
            activeConvId = this.agent.createConversation();
            convIds.push(activeConvId);
            return { convIds, activeConvId, fresh: true };
        }
        return { convIds, activeConvId, fresh: false };
    }

    private createPanel(
        splitEditor = false,
        restoredPanel?: vscode.WebviewPanel,
        restoredState?: SerializedChatPanelState,
    ): string {
        const panelId = `mimo-${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const restored = this.resolveRestoredConversationIds(restoredState);
        const convId = restored.activeConvId;

        const column = splitEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
        const panel = restoredPanel || vscode.window.createWebviewPanel(
            'mimo-agent.chat',
            'MiMo Chat',
            { viewColumn: column, preserveFocus: false },
            {
                enableScripts: true,
                localResourceRoots: [this.extensionUri],
                retainContextWhenHidden: true,
            },
        );
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'mimo-agent-icon.svg');
        const activeConv = this.agent.getConversation(convId);
        if (activeConv) panel.title = activeConv.title;

        // Track this panel
        const state: PanelState = { panel, convId, convIds: restored.convIds, activeConvId: convId, messageQueue: [] };
        this.panels.set(panelId, state);

        // Update current panel references
        this.panel = panel;
        state.pendingInit = { firstId: convId, fresh: restored.fresh };

        // On panel close -remove from map
        panel.onDidDispose(() => {
            this.panels.delete(panelId);
            if (this.panel === panel) this.panel = undefined;
        }, null, []);

        panel.webview.html = this.getHtml(panel.webview);

        // Handle visibility changes -restore state when panel is shown again
        panel.onDidChangeViewState((e) => {
            if (e.webviewPanel.visible) {
                this.panel = e.webviewPanel;
                // restoreStateToWebview already posts busy/idle + history
                this.restoreStateToWebview(panel);
            }
        });

        // Handle messages from webview -capture panelId and convId in closure
        panel.webview.onDidReceiveMessage(async (msg) => {
            this.panel = panel;
            const post = (m: any) => panel.webview.postMessage(m);

            switch (msg.type) {
                case 'ready': {
                    const initialLang = restoredState?.uiLang || this.getPreferredUiLang();
                    post({ type: 'setLang', lang: initialLang });

                    // ALWAYS initialize -no dependency on pendingInit
                    const st = this.panels.get(panelId);
                    let myConvId = st?.activeConvId;
                    if (!myConvId) break;
                    this.agent.setUiLang(initialLang, myConvId);
                    console.log(`[MiMo] ready: panelId=${panelId}, myConvId=${myConvId}, convCount=${this.agent.getConversation(myConvId)?.messages.length ?? 'N/A'}`);

                    // 1. Verify conversation exists -if not, create fresh one
                    let initConv = this.agent.getConversation(myConvId);
                    if (!initConv && st) {
                        // Conversation was lost -create fresh one for this panel
                        const freshId = this.agent.createConversation();
                        st.convIds = [freshId];
                        st.activeConvId = freshId;
                        initConv = this.agent.getConversation(freshId);
                        myConvId = freshId;
                    }

                    // 2. Tab list + title
                    post({ type: 'tabList', tabs: this.getTabList(st?.convIds, myConvId), activeId: myConvId });
                    if (initConv) post({ type: 'convTitle', title: initConv.title, convId: myConvId });

                    // 2. API key check
                    if (!this.agent.hasApiKey()) {
                        post({ type: 'error', error: 'API key is not configured. Set mimo.apiKey in VS Code settings or api.api_key in ~/.mimo/settings.json.' });
                    }

                    // 3. Model info
                    const model = this.agent.getModelSelectionValue(myConvId);
                    post(this.modelListMessage(myConvId));
                    post({ type: 'modelCaps', caps: this.agent.getModelCapabilities(model) });
                    post({ type: 'settingsData', settings: this.getWindowSettingsPanel() });
                    post(this.contextUsageMessage(myConvId));

                    // 4. Skills
                    post({
                        type: 'skillList',
                        skills: this.agent.getSkills().map(s => ({
                            name: s.name,
                            description: s.description,
                            source: s.source,
                        })),
                    });

                    // 5. Restore conversation if it has messages (full replay with reasoning, tool cards, etc.)
                    if (initConv && initConv.messages.length > 0) {
                        post({ type: 'clearMessages' });
                        this.replayConversation(initConv.messages, panel);
                        post({ type: 'restoreMode', mode: initConv.mode, label: initConv.mode });
                    }
                    this.postInputHistory(panel, myConvId);

                    // 6. Consume pendingInit (cleanup)
                    if (st?.pendingInit && st.pendingInit.firstId === myConvId) {
                        st.pendingInit = undefined;
                    }

                    // 7. History list
                    post({ type: 'historyList', items: this.history.list() });
                    break;
                }
                case 'newChat': {
                    // Open a new editor panel with a fresh conversation
                    vscode.commands.executeCommand('mimo-agent.newChat');
                    break;
                }
                case 'switchChat': {
                    this.agent.switchConversation(msg.id);
                    const conv = this.agent.getConversation(msg.id);
                    const st2 = this.panels.get(panelId);
                    // Update this panel's active conversation
                    if (st2) st2.activeConvId = msg.id;
                    post({ type: 'tabList', tabs: this.getTabList(st2?.convIds), activeId: msg.id });
                    post({ type: 'clearMessages' });
                    if (conv) {
                        this.replayConversation(conv.messages, panel);
                        post(this.modelListMessage(msg.id));
                        post({ type: 'modelCaps', caps: this.agent.getModelCapabilities(this.agent.getModelSelectionValue(msg.id)) });
                        post({ type: 'restoreMode', mode: conv.mode, label: conv.mode });
                        post(this.contextUsageMessage(msg.id));
                        this.postInputHistory(panel, msg.id);
                        // Restore busy state for the full lifecycle, including outer-turn cleanup
                        // and recovery paths where the chat promise is still active.
                        post(this.agent.isConvBusy(msg.id) ? { type: 'busy' } : { type: 'idle' });
                    }
                    break;
                }
                case 'closeChat': {
                    // Don't delete -just switch to another conversation in THIS panel
                    const st3 = this.panels.get(panelId);
                    if (st3) {
                        // Remove from panel's conversation list
                        st3.convIds = st3.convIds.filter(id => id !== msg.id);
                        // Switch to remaining conversation or create new one
                        const nextId = st3.convIds.length > 0
                            ? st3.convIds[st3.convIds.length - 1]
                            : this.agent.createConversation();
                        if (!st3.convIds.includes(nextId)) st3.convIds.push(nextId);
                        st3.activeConvId = nextId;

                        post({ type: 'tabList', tabs: this.getTabList(st3.convIds), activeId: nextId });
                        const nextConv = this.agent.getConversation(nextId);
                        if (nextConv) {
                            post({ type: 'clearMessages' });
                            this.replayConversation(nextConv.messages, panel);
                            post(this.modelListMessage(nextId));
                            post({ type: 'modelCaps', caps: this.agent.getModelCapabilities(this.agent.getModelSelectionValue(nextId)) });
                            post({ type: 'restoreMode', mode: nextConv.mode, label: nextConv.mode });
                            post(this.contextUsageMessage(nextId));
                            this.postInputHistory(panel, nextId);
                        }
                    }
                    break;
                }
                case 'renameChat': {
                    this.agent.setTitle(msg.id, msg.title);
                    const st4 = this.panels.get(panelId);
                    post({ type: 'tabList', tabs: this.getTabList(st4?.convIds), activeId: st4?.activeConvId });
                    // Sync title to header input and panel tab
                    if (st4 && msg.id === st4.activeConvId) {
                        panel.title = msg.title;
                        panel.webview.postMessage({ type: 'convTitle', title: msg.title, convId: msg.id });
                    }
                    // Sync title to history
                    try {
                        const conv4 = this.agent.getConversation(msg.id);
                        if (conv4) {
                            this.queueHistorySave(msg.id, msg.title, conv4.messages, conv4.model, this.historyMetadata(conv4));
                        }
                    } catch { /* ignore */ }
                    break;
                }
                case 'send': {
                    const st = this.panels.get(panelId);
                    const sendConvId = st?.activeConvId || convId;
                    const text = sanitizeString(msg.text, 200_000) || '';
                    const images = sanitizeImages(msg.images);
                    if (!text && !images?.length) break;
                    if (st) st.stopRequested = false;
                    if (this.agent.isConvBusy(sendConvId)) {
                        post({ type: 'system', text: 'A message is already running. Wait for it to finish or press Stop before sending another message.' });
                        post({ type: 'clearQueue' });
                    } else {
                        await this.handleUserMessage(text, images, sendConvId, panel);
                    }
                    break;
                }
                case 'interruptAndSend': {
                    const st = this.panels.get(panelId);
                    const sendConvId = st?.activeConvId || convId;
                    const text = sanitizeString(msg.text, 200_000) || '';
                    const images = sanitizeImages(msg.images);
                    if (!text && !images?.length) break;
                    if (st) st.messageQueue = [];
                    if (st) st.stopRequested = false;

                    if (this.agent.isConvBusy(sendConvId)) {
                        post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '正在中断当前任务，并切换到选中的排队消息...' : 'Interrupting the current run and switching to the selected queued message...' });
                        this.agent.abort(sendConvId);
                        const idle = await this.waitForConversationIdle(sendConvId, 10_000);
                        if (!idle) {
                            post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '当前任务仍在收尾，稍后再试。' : 'The current run is still winding down. Try again shortly.' });
                            break;
                        }
                    }

                    await this.handleUserMessage(text, images, sendConvId, panel);
                    break;
                }
                case 'setUiLang': {
                    const stLang = this.panels.get(panelId);
                    const lang = msg.lang === 'en' ? 'en' : 'zh';
                    this.agent.setUiLang(lang, stLang?.activeConvId || convId);
                    saveSetting('ui.language', lang);
                    void vscode.commands.executeCommand('mimo-agent.refreshSettingsLanguage');
                    break;
                }
                case 'clear': {
                    const stClear = this.panels.get(panelId);
                    this.agent.reset(stClear?.activeConvId);
                    post({ type: 'clearMessages' });
                    post(this.contextUsageMessage(stClear?.activeConvId));
                    break;
                }
                case 'skill': {
                    const stSkill = this.panels.get(panelId);
                    await this.handleSkillInvocation(msg.skill, msg.text, stSkill?.activeConvId, panel);
                    break;
                }
                case 'searchFiles': {
                    const query = String(msg.query || '').trim();
                    const results = this.searchWorkspaceFiles(query, query ? 120 : 500);
                    post({ type: 'fileSearchResults', results });
                    break;
                }
                case 'setModel': {
                    const stModel = this.panels.get(panelId);
                    const modelConvId = stModel?.activeConvId;
                    this.agent.setModel(msg.model, modelConvId);
                    if (modelConvId) post(this.modelListMessage(modelConvId));
                    post({ type: 'modelCaps', caps: this.agent.getModelCapabilities(msg.model) });
                    post(this.contextUsageMessage(modelConvId));
                    break;
                }
                case 'setMode': {
                    const stMode = this.panels.get(panelId);
                    this.agent.setMode(msg.mode, stMode?.activeConvId);
                    post({ type: 'modeSwitched', mode: msg.mode });
                    break;
                }
                case 'stop': {
                    const stStop = this.panels.get(panelId);
                    // Immediately update UI -don't wait for agent to finish
                    post({ type: 'idle' });
                    // Clear message queue so queued messages don't auto-send
                    if (stStop) stStop.messageQueue = [];
                    if (stStop) stStop.stopRequested = true;
                    // Clear webview queue display too
                    post({ type: 'clearQueue' });
                    // Abort the agent -only if we have a valid convId
                    if (stStop?.activeConvId) {
                        this.agent.abort(stStop.activeConvId);
                    }
                    break;
                }
                case 'editConfirm':
                    this.agent.confirmEdit(msg.previewId, true);
                    break;
                case 'editReject':
                    this.agent.confirmEdit(msg.previewId, false);
                    break;
                case 'writeConfirm':
                    this.agent.confirmWrite(msg.previewId, true, msg.newPath);
                    break;
                case 'writeReject':
                    this.agent.confirmWrite(msg.previewId, false);
                    break;
                case 'askUserConfirm':
                    this.agent.confirmAskUser(msg.previewId, msg.answer);
                    break;
                case 'taskChangesUndo': {
                    console.log('[MiMo] taskChangesUndo: id=' + msg.id + ', patchLen=' + (msg.patch || '').length);
                    const result = await this.agent.undoWorkspaceChanges(String(msg.patch || ''));
                    console.log('[MiMo] taskChangesUndo: id=' + msg.id + ', patchLen=' + (msg.patch || '').length);
                    post({ type: 'taskChangesUndoResult', id: msg.id, filePath: sanitizeString(msg.filePath, 4096), ...result });
                    if (result.ok) {
                        const summary = await this.agent.getWorkspaceChangeSummary();
                        post({ type: 'taskChangesRefresh', summary });
                    }
                    break;
                }
                case 'historySnapshot': {
                    const stSnap = this.panels.get(panelId);
                    const snapConvId = stSnap?.activeConvId || convId;
                    const convSnap = this.agent.getConversation(snapConvId);
                    if (convSnap) {
                        this.attachUiSnapshot(snapConvId, msg.snapshot);
                        this.queueHistorySave(snapConvId, convSnap.title, convSnap.messages, convSnap.model, this.historyMetadata(convSnap));
                    }
                    break;
                }
                case 'planConfirm': {
                    const stPlan = this.panels.get(panelId);
                    this.agent.confirmPlan(true, stPlan?.activeConvId);
                    post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '计划已确认，开始执行...' : 'Plan confirmed. Starting execution...' });
                    const planRef = stPlan?.planPath
                        ? buildPlanExecutionMessage(stPlan.planPath)
                        : stPlan?.planContent
                            ? `Execute the confirmed plan below.\n\n[CONFIRMED PLAN]\n${sanitizePlanMarkdown(stPlan.planContent)}\n[END PLAN]`
                            : 'Execute the confirmed plan.';
                    await this.handleUserMessage(planRef, [], stPlan?.activeConvId || convId, panel);
                    break;
                }
                case 'planReject': {
                    const stReject = this.panels.get(panelId);
                    this.agent.confirmPlan(false, stReject?.activeConvId);
                    post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '计划已拒绝，请重新描述需求。' : 'Plan rejected. Please describe the requirement again.' });
                    break;
                }
                case 'planModify': {
                    const stMod = this.panels.get(panelId);
                    this.agent.confirmPlan(false, stMod?.activeConvId);
                    post({
                        type: 'system',
                        text: vscode.env.language.startsWith('zh')
                            ? `已请求修改计划：${msg.feedback}`
                            : `Plan modification requested: ${msg.feedback}`,
                    });
                    await this.handleUserMessage(
                        `Please revise the plan based on this feedback:\n\n${msg.feedback}\n\nAnalyze the requirement again and output the revised plan.`,
                        [], stMod?.activeConvId || convId, panel
                    );
                    break;
                }
                case 'historyList':
                    post({ type: 'historyList', items: this.history.list() });
                    break;
                case 'historyLoad': {
                    const histConv = this.history.load(msg.id);
                    if (histConv) {
                        const id = histConv.id;

                        // Check if this conversation is already open in any panel
                        let foundPanel: PanelState | null = null;
                        for (const [, st] of this.panels) {
                            if (st.convIds.includes(id)) {
                                foundPanel = st;
                                break;
                            }
                        }

                        if (foundPanel) {
                            // Already open -just reveal/focus that panel
                            foundPanel.panel.reveal(vscode.ViewColumn.Active, false);
                            this.agent.loadConversation(id, histConv.title, histConv.messages, histConv.model, {
                                mode: sanitizeMode(histConv.mode),
                                personaId: histConv.personaId,
                                activeSkillPrompt: histConv.activeSkillPrompt,
                                modelEndpointId: histConv.modelEndpointId,
                            });
                            foundPanel.activeConvId = id;
                            foundPanel.panel.title = histConv.title;
                            foundPanel.panel.webview.postMessage({ type: 'tabList', tabs: this.getTabList(foundPanel.convIds, foundPanel.activeConvId), activeId: id });
                            foundPanel.panel.webview.postMessage({ type: 'convTitle', title: histConv.title, convId: id });
                            foundPanel.panel.webview.postMessage({ type: 'clearMessages' });
                            this.replayConversation(histConv.messages, foundPanel.panel);
                            foundPanel.panel.webview.postMessage(this.modelListMessage(id));
                            foundPanel.panel.webview.postMessage({ type: 'modelCaps', caps: this.agent.getModelCapabilities(this.agent.getModelSelectionValue(id)) });
                            foundPanel.panel.webview.postMessage(this.contextUsageMessage(id));
                            foundPanel.panel.webview.postMessage({ type: 'restoreMode', mode: histConv.mode || 'auto', label: histConv.mode || 'auto' });
                            this.postInputHistory(foundPanel.panel, id);
                        } else {
                            // Not open -create a NEW panel (don't touch current one)
                            const newPanelId = this.createPanel(false);
                            const newState = this.panels.get(newPanelId)!;
                            this.agent.loadConversation(id, histConv.title, histConv.messages, histConv.model, {
                                mode: sanitizeMode(histConv.mode),
                                personaId: histConv.personaId,
                                activeSkillPrompt: histConv.activeSkillPrompt,
                                modelEndpointId: histConv.modelEndpointId,
                            });
                            newState.convIds.push(id);
                            newState.activeConvId = id;
                            newState.panel.title = histConv.title;
                            newState.panel.webview.postMessage({ type: 'tabList', tabs: this.getTabList(newState.convIds, newState.activeConvId), activeId: id });
                            newState.panel.webview.postMessage({ type: 'convTitle', title: histConv.title, convId: id });
                            newState.panel.webview.postMessage({ type: 'clearMessages' });
                            this.replayConversation(histConv.messages, newState.panel);
                            newState.panel.webview.postMessage(this.modelListMessage(id));
                            newState.panel.webview.postMessage({ type: 'modelCaps', caps: this.agent.getModelCapabilities(this.agent.getModelSelectionValue(id)) });
                            newState.panel.webview.postMessage(this.contextUsageMessage(id));
                            newState.panel.webview.postMessage({ type: 'restoreMode', mode: histConv.mode || 'auto', label: histConv.mode || 'auto' });
                            this.postInputHistory(newState.panel, id);
                        }
                    }
                    break;
                }
                case 'historyDelete':
                    this.history.delete(msg.id);
                    post({ type: 'historyList', items: this.history.list() });
                    break;
                case 'historySearch': {
                    const results = this.history.search(msg.query || '');
                    post({ type: 'historyList', items: results });
                    break;
                }
                case 'exportMarkdown': {
                    const conv = this.history.load(msg.id);
                    if (conv) {
                        const md = this.history.exportMarkdown(conv);
                        if (md) {
                            post({ type: 'exportResult', format: 'markdown', content: md, title: conv.title });
                        }
                    }
                    break;
                }
                case 'exportJson': {
                    const conv = this.history.load(msg.id);
                    if (conv) {
                        const json = this.history.exportJson(conv);
                        if (json) {
                            post({ type: 'exportResult', format: 'json', content: json, title: conv.title });
                        }
                    }
                    break;
                }
                case 'exportAllJson': {
                    const allJson = this.history.exportAllJson();
                    post({ type: 'exportResult', format: 'json', content: allJson, title: 'All_Conversations' });
                    break;
                }
                case 'getSettings':
                    post({ type: 'settingsData', settings: this.getWindowSettingsPanel() });
                    break;
                case 'setReasoningEffort': {
                    const effort = sanitizeSettings({ reasoning_effort: msg.reasoning_effort }).reasoning_effort as ReasoningEffort | undefined;
                    if (!effort) break;
                    this.setWindowReasoningEffort(effort);
                    post({ type: 'settingsData', settings: this.getWindowSettingsPanel() });
                    break;
                }
                case 'openSettings':
                    vscode.commands.executeCommand('mimo-agent.settings');
                    break;
                case 'saveSettings': {
                    const s = sanitizeSettings(msg.settings);
                    if (s.api_key !== undefined) saveSetting('api.api_key', s.api_key);
                    if (s.base_url !== undefined) saveSetting('api.base_url', s.base_url);
                    if (s.api_endpoint !== undefined) saveSetting('api.api_endpoint', s.api_endpoint);
                    if (s.model !== undefined) saveSetting('api.model', s.model);
                    if (s.models !== undefined) saveSetting('api.models', s.models);
                    if (s.active_provider_profile !== undefined) saveSetting('api.active_provider_profile', s.active_provider_profile);
                    if (s.active_route !== undefined) saveSetting('api.active_route', s.active_route);
                    if (s.provider_profiles !== undefined) saveSetting('api.provider_profiles', s.provider_profiles);
                    if (s.max_tokens !== undefined) saveSetting('agent.max_tokens', s.max_tokens);
                    if (s.temperature !== undefined) saveSetting('agent.temperature', s.temperature);
                    if (s.top_p !== undefined) saveSetting('agent.top_p', s.top_p);
                    if (s.reasoning_effort !== undefined) saveSetting('agent.reasoning_effort', s.reasoning_effort);
                    if (s.enable_thinking !== undefined) saveSetting('agent.enable_thinking', s.enable_thinking);
                    if (s.max_output_len !== undefined) saveSetting('safety.max_output_len', s.max_output_len);
                    if (s.command_timeout !== undefined) saveSetting('safety.command_timeout', s.command_timeout);
                    if (s.ui_completion_sound !== undefined) saveSetting('ui.completion_sound', s.ui_completion_sound);
                    if (s.ui_completion_sound_volume !== undefined) saveSetting('ui.completion_sound_volume', s.ui_completion_sound_volume);
                    if (s.sandbox_enabled !== undefined) saveSetting('sandbox.enabled', s.sandbox_enabled);
                    if (s.sandbox_mode !== undefined) saveSetting('sandbox.mode', s.sandbox_mode);
                    if (s.sandbox_image !== undefined) saveSetting('sandbox.image', s.sandbox_image);
                    if (s.sandbox_memory !== undefined) saveSetting('sandbox.memory_limit', s.sandbox_memory);
                    if (s.sandbox_cpu !== undefined) saveSetting('sandbox.cpu_limit', s.sandbox_cpu);
                    if (s.sandbox_git_snapshot !== undefined) saveSetting('sandbox.git_snapshot', s.sandbox_git_snapshot);
                    if (s.sandbox_logging !== undefined) saveSetting('sandbox.logging', s.sandbox_logging);
                    if (s.sandbox_network_disabled !== undefined) saveSetting('sandbox.network_disabled', s.sandbox_network_disabled);
                    if (s.dependency_install_enabled !== undefined) saveSetting('dependency_install.enabled', s.dependency_install_enabled);
                    if (s.dependency_install_project_mode !== undefined) saveSetting('dependency_install.project_mode', s.dependency_install_project_mode);
                    if (s.dependency_install_system_mode !== undefined) saveSetting('dependency_install.system_mode', s.dependency_install_system_mode);
                    if (s.dependency_install_long_timeout_sec !== undefined) saveSetting('dependency_install.long_timeout_sec', s.dependency_install_long_timeout_sec);
                    if (s.memory_enabled !== undefined) saveSetting('memory.enabled', s.memory_enabled);
                    if (s.memory_learn_from_explicit_preferences !== undefined) saveSetting('memory.learn_from_explicit_preferences', s.memory_learn_from_explicit_preferences);
                    if (s.memory_max_items !== undefined) saveSetting('memory.max_items', s.memory_max_items);
                    if (s.memory_max_injected !== undefined) saveSetting('memory.max_injected', s.memory_max_injected);
                    if (s.reasoning_effort !== undefined) {
                        this.windowReasoningEffort = s.reasoning_effort as ReasoningEffort;
                    }
                    // Hot-reload: re-read config and update agent in memory
                    const newConfig = loadConfig();
                    newConfig.reasoningEffort = this.windowReasoningEffort;
                    newConfig.enableThinking = this.windowReasoningEffort === 'deep' || this.windowReasoningEffort === 'max';
                    this.agent.updateConfig(newConfig);
                    this.refreshModelLists();
                    if (!msg.silent) {
                        post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '设置已保存并生效。' : 'Settings saved and applied.' });
                    }
                    post({ type: 'settingsData', settings: this.getWindowSettingsPanel() });
                    break;
                }
                case 'openUrl': {
                    // Open URL in default browser -only allow http(s) protocols
                    try {
                        const rawUrl = sanitizeString(msg.url, 2048);
                        if (!rawUrl) break;
                        const parsed = vscode.Uri.parse(rawUrl, true);
                        if (parsed.scheme === 'http' || parsed.scheme === 'https') {
                            await vscode.env.openExternal(parsed);
                        }
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`Cannot open URL: ${e.message}`);
                    }
                    break;
                }
                case 'openFile': {
                    // Open file in VSCode editor (optionally in split column)
                    try {
                        let filePath = sanitizeString(msg.path, 4096);
                        if (!filePath) break;
                        const line = sanitizeNumber(msg.line, 1, 1_000_000) || 1;
                        // Resolve relative paths against workspace
                        if (filePath && !filePath.match(/^[A-Z]:\\/i) && !filePath.startsWith('/')) {
                            const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                            if (workspace) {
                                filePath = path.join(workspace, filePath);
                            }
                        }
                        const uri = vscode.Uri.file(filePath);
                        const position = new vscode.Position(Math.max(0, line - 1), 0);
                        const range = new vscode.Range(position, position);
                        const column = msg.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
                        await vscode.window.showTextDocument(uri, { selection: range, viewColumn: column });
                        post({ type: 'fileOpenResult', path: msg.path, ok: true });
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`Cannot open file: ${e.message}`);
                        post({ type: 'fileOpenResult', path: msg.path, ok: false, error: e.message });
                    }
                    break;
                }
                case 'openMarkdownPreview': {
                    try {
                        let filePath = sanitizeString(msg.path, 4096);
                        if (!filePath) break;
                        if (filePath && !filePath.match(/^[A-Z]:\\/i) && !filePath.startsWith('/')) {
                            const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                            if (workspace) {
                                filePath = path.join(workspace, filePath);
                            }
                        }
                        const uri = vscode.Uri.file(filePath);
                        await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
                        post({ type: 'fileOpenResult', path: msg.path, ok: true });
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`Cannot open markdown preview: ${e.message}`);
                        post({ type: 'fileOpenResult', path: msg.path, ok: false, error: e.message });
                    }
                    break;
                }
                case 'openScratchDocument': {
                    try {
                        const title = sanitizeString(msg.title, 240) || 'MiMo Preview';
                        const content = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
                        const language = sanitizeString(msg.language, 40) || 'plaintext';
                        const uri = this.readonlyPreviewProvider.createUri(title, content, language);
                        const doc = await vscode.workspace.openTextDocument(uri);
                        const typedDoc = await vscode.languages.setTextDocumentLanguage(doc, language);
                        const column = msg.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
                        await vscode.window.showTextDocument(typedDoc, { preview: false, viewColumn: column });
                        post({ type: 'fileOpenResult', path: title, ok: true });
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`Cannot open preview document: ${e.message}`);
                        post({ type: 'fileOpenResult', path: msg.title, ok: false, error: e.message });
                    }
                    break;
                }
                case 'openReadonlyDiff': {
                    try {
                        const title = sanitizeString(msg.title, 240) || 'MiMo Diff';
                        const filePath = sanitizeString(msg.filePath, 4096) || 'changes.txt';
                        const before = typeof msg.before === 'string' ? msg.before : String(msg.before || '');
                        const after = typeof msg.after === 'string' ? msg.after : String(msg.after || '');
                        const language = sanitizeString(msg.language, 40) || 'plaintext';
                        const leftUri = this.readonlyPreviewProvider.createUri(`${title} (Before)`, before, language, filePath);
                        const rightUri = this.readonlyPreviewProvider.createUri(`${title} (After)`, after, language, filePath);
                        await vscode.commands.executeCommand(
                            'vscode.diff',
                            leftUri,
                            rightUri,
                            title,
                            { preview: false, viewColumn: msg.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active },
                        );
                        post({ type: 'fileOpenResult', path: filePath, ok: true });
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`Cannot open diff preview: ${e.message}`);
                        post({ type: 'fileOpenResult', path: msg.filePath, ok: false, error: e.message });
                    }
                    break;
                }
                case 'openDiffReview': {
                    try {
                        const title = sanitizeString(msg.title, 240) || 'MiMo Diff Review';
                        const rawItems = Array.isArray(msg.items) ? msg.items : [];
                        const items = rawItems
                            .map((item: any) => {
                                const filePath = sanitizeString(item?.filePath, 4096) || '';
                                const patch = typeof item?.patch === 'string' ? item.patch : String(item?.patch || '');
                                const before = typeof item?.before === 'string' ? item.before : String(item?.before || '');
                                const after = typeof item?.after === 'string' ? item.after : String(item?.after || '');
                                if (!filePath || !patch) return null;
                                return { filePath, patch, before, after };
                            })
                            .filter((item: { filePath: string; patch: string; before: string; after: string } | null): item is { filePath: string; patch: string; before: string; after: string } => !!item)
                            .slice(0, 200);
                        if (items.length === 0) break;
                        this.openDiffReviewPanel(title, items);
                        post({ type: 'fileOpenResult', path: title, ok: true });
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`Cannot open diff review: ${e.message}`);
                        post({ type: 'fileOpenResult', path: msg.title, ok: false, error: e.message });
                    }
                    break;
                }
                // 鈹€鈹€ Skill management 鈹€鈹€
                case 'skillList':
                    post({
                        type: 'skillList',
                        skills: this.agent.getSkills().map(s => ({
                            name: s.name,
                            description: s.description,
                            source: s.source,
                        })),
                    });
                    break;
                case 'skillSave': {
                    const skill = sanitizeSkill(msg.skill);
                    const ok = skill ? this.agent.saveSkill(skill) : false;
                    post({ type: 'system', text: ok ? `Skill "${skill!.name}" saved.` : 'Failed to save skill.' });
                    post({
                        type: 'skillList',
                        skills: this.agent.getSkills().map(s => ({
                            name: s.name,
                            description: s.description,
                            source: s.source,
                        })),
                    });
                    break;
                }
                case 'skillDelete': {
                    const name = sanitizeString(msg.name, 80);
                    const ok = !!name && this.agent.deleteSkill(name);
                    post({ type: 'system', text: ok ? `Skill "${name}" deleted.` : 'Failed to delete skill.' });
                    post({
                        type: 'skillList',
                        skills: this.agent.getSkills().map(s => ({
                            name: s.name,
                            description: s.description,
                            source: s.source,
                        })),
                    });
                    break;
                }
                case 'voiceInput': {
                    // Start continuous PowerShell speech recognition (manual stop)
                    const ps1 = path.join(os.tmpdir(), 'mimo_voice.ps1');
                    const resultFile = path.join(os.tmpdir(), 'mimo_voice_result.txt');
                    try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
                    // Escape single quotes for PowerShell string literal safety
                    const safeResultPath = resultFile.replace(/\\/g, '\\\\').replace(/'/g, "''");
                    fs.writeFileSync(ps1, `Add-Type -AssemblyName System.Speech
$rec = New-Object System.Speech.Recognition.SpeechRecognizer
$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Continuous)
$rec.add_FrameStateChanged({
    param($s,$e)
    if ($e.FrameState -eq [System.Speech.Recognition.SpeechRecognizerState]::Listening) {
        "Listening..." | Out-File -FilePath '${safeResultPath}' -Encoding utf8
    }
})
$rec.add_SpeechRecognized({
    param($s,$e)
    if ($e.Result.Text) {
        $e.Result.Text | Out-File -FilePath '${safeResultPath}' -Append -Encoding utf8
    }
})
while ($true) { Start-Sleep -Milliseconds 100 }
`);
                    const ps = exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { windowsHide: true });
                    const stVoice = this.panels.get(panelId);
                    if (stVoice) {
                        stVoice.voiceProcess = ps;
                        stVoice.voiceResultFile = resultFile;
                        stVoice.voicePsFile = ps1;
                    }
                    break;
                }
                case 'voiceStop': {
                    // Stop recording and return accumulated text
                    const stVoiceStop = this.panels.get(panelId);
                    if (stVoiceStop?.voiceProcess) {
                        try { stVoiceStop.voiceProcess.kill(); } catch { /* ignore */ }
                        stVoiceStop.voiceProcess = null;
                    }
                    let text = '';
                    try {
                        if (stVoiceStop?.voiceResultFile) {
                            const raw = fs.readFileSync(stVoiceStop.voiceResultFile, 'utf8');
                            // Filter out "Listening..." marker and join lines
                            text = raw.split('\n')
                                .map(l => l.trim())
                                .filter(l => l && l !== 'Listening...')
                                .join('');
                            try { fs.unlinkSync(stVoiceStop.voiceResultFile!); } catch { /* ignore */ }
                        }
                    } catch { /* no result file */ }
                    try { if (stVoiceStop?.voicePsFile) fs.unlinkSync(stVoiceStop.voicePsFile); } catch { /* ignore */ }
                    post({ type: 'voiceResult', text, error: '' });
                    break;
                }
            }
        });

        return panelId;
    }

    private getTabList(convIds?: string[], activeId?: string) {
        const all = this.agent.getAllConversations();
        const filtered = convIds ? all.filter(c => convIds.includes(c.id)) : all;
        return filtered.map(c => ({
            id: c.id,
            title: c.title,
            active: c.id === activeId,
        }));
    }

    private contextUsageMessage(
        convId?: string,
        pending?: { text?: string; images?: Array<{ dataUrl: string; name: string; size: number }> | null },
    ): any {
        if (!convId) return { type: 'contextUsage', usage: null };
        const conv = this.agent.getConversation(convId);
        if (!conv) return { type: 'contextUsage', usage: null };
        const messages = this.agent.getMessages(convId);
        if (pending && (pending.text || pending.images?.length)) {
            const parts: ContentPart[] = [];
            if (pending.text) parts.push({ type: 'text', text: pending.text });
            for (const image of pending.images || []) {
                parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
            }
            messages.push({
                role: 'user',
                content: parts.length > 1 ? parts : (pending.text || ''),
            } as ChatMessage);
        }
        const stats = getContextStats(messages, this.agent.getModel(convId));
        return {
            type: 'contextUsage',
            usage: {
                ...stats,
                usedLabel: formatContextTokenCount(stats.used),
                totalLabel: formatContextTokenCount(stats.total),
            },
        };
    }

    /** Find the PanelState that owns a given panel */
    private findStateByPanel(panel: vscode.WebviewPanel): PanelState | undefined {
        for (const [, st] of this.panels) {
            if (st.panel === panel) return st;
        }
        return undefined;
    }

    async handleUserMessage(text: string, images?: Array<{dataUrl: string; name: string; size: number}>, convId?: string, targetPanel?: vscode.WebviewPanel) {
        const panel = targetPanel || this.panel;
        if (!panel) return;
        const panelState = this.findStateByPanel(panel);
        // Local post function - always sends to THIS panel, no race condition.
        const rawPost = (msg: any) => panel.webview.postMessage(msg);
        // MUST have a valid convId -never fall back to global activeId
        if (!convId) return;
        const activeId = convId;
        console.log(`[MiMo] handleUserMessage: convId=${activeId}, msgCount=${this.agent.getConversation(activeId)?.messages.length ?? 'N/A'}`);
        const conv = this.agent.getConversation(activeId);
        if (!conv) return;
        if (this.activeTurnTokens.has(activeId) || this.agent.isConvBusy(activeId)) {
            rawPost({ type: 'system', text: 'This conversation is already running. Wait for completion or stop it first.' });
            return;
        }
        const turnToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.activeTurnTokens.set(activeId, turnToken);
        const isCurrentTurn = () => this.activeTurnTokens.get(activeId) === turnToken;
        const post = (msg: any) => {
            if (!isCurrentTurn()) return false;
            panel.webview.postMessage(msg);
            return true;
        };

        // Auto-title from the first user message. Use message state instead of
        // title text so restored placeholder/mojibake titles cannot skip AI naming.
        if (this.shouldAutoTitleConversation(conv)) {
            const pendingTitle = pendingAiTitle(text);
            console.log(`[MiMo] Scheduling AI title for convId=${activeId}; previousTitle="${conv.title || ''}"`);
            conv.title = pendingTitle;

            const st6 = this.findStateByPanel(panel);
            post({ type: 'tabList', tabs: this.getTabList(st6?.convIds, activeId), activeId });
            // Update the VSCode editor tab title + header input
            panel.title = conv.title;
            post({ type: 'convTitle', title: conv.title, convId: activeId });
            this.scheduleAiTitle(activeId, panel, text, pendingTitle);
        } else {
            console.log(`[MiMo] AI title not scheduled for convId=${activeId}; existingMessages=${conv.messages.length}; title="${conv.title || ''}"`);
        }

        // Show user message with optional images
        const turnStartedAt = Date.now();
        const baselineChanges = await this.agent.getWorkspaceChangeSummary();
        const baselinePatch = baselineChanges?.patch || '';
        const turnToolChanges: TurnChangeTracker = { files: new Map(), snapshots: new Map() };
        post({ type: 'userMessage', text, images: images || null });
        post(this.contextUsageMessage(activeId, { text, images: images || null }));
        post({ type: 'busy' });

        let responseText = '';
        let committedResponseText = '';
        let finalAnswerEmitted = false;
        let hasToolCalls = false;
        let totalToolCalls = 0;
        let turnHadError = false;
        let turnStoppedByUser = false;
        const wasStopRequested = () => this.findStateByPanel(panel)?.stopRequested === true;
        const startedAsPlanExecution = conv.mode === 'plan' && !!conv.planConfirmed;
        const pendingToolArgs: Array<{ name: string; args: Record<string, any> }> = [];
        const streamRender = createStreamingRenderQueue(post);
        const reasoningPost = createReasoningPostQueue(post);
        const commitAssistantUpdate = () => {
            streamRender.cancel();
            renderAssistantMarkdown(post, 'assistantUpdate', responseText);
            committedResponseText += responseText;
            responseText = '';
        };
        const emitFinalAnswer = (response: string) => {
            if (finalAnswerEmitted) return;
            const responseToEmit = (() => {
                if (!response) return responseText;
                if (!committedResponseText) return response;
                if (response.startsWith(committedResponseText)) {
                    return response.slice(committedResponseText.length);
                }
                if (committedResponseText.includes(response.trim())) return responseText;
                return responseText || response;
            })();
            if (responseToEmit.trim()) {
                renderAssistantMarkdown(post, 'finalAnswer', responseToEmit);
            }
            finalAnswerEmitted = true;
            responseText = '';
        };
        const finalizePartialAssistant = () => {
            reasoningPost.flush();
            streamRender.cancel();
            if (responseText.trim()) {
                commitAssistantUpdate();
            }
        };
        try {
        // Build event handlers -store for potential reconnection
        const handlers = {
                onToken: (token: string) => {
                    responseText += token;
                    streamRender.schedule(responseText);
                },
                onAssistantUpdate: (text: string) => {
                    streamRender.cancel();
                    renderAssistantMarkdown(post, 'assistantUpdate', text);
                    committedResponseText += text;
                    responseText = '';
                },
                onVerificationUpdate: (text: string, preservedDraft?: string) => {
                    streamRender.cancel();
                    if (responseText.trim()) {
                        renderAssistantMarkdown(post, 'finalAnswer', responseText);
                        committedResponseText += responseText;
                        responseText = '';
                    } else if (preservedDraft?.trim()) {
                        renderAssistantMarkdown(post, 'finalAnswer', preservedDraft);
                        committedResponseText += preservedDraft;
                    }
                    renderAssistantMarkdown(post, 'verificationUpdate', text);
                },
                onFinalAnswer: (text: string) => {
                    streamRender.cancel();
                    emitFinalAnswer(text);
                },
                onThoughtSummary: (text: string) => {
                    reasoningPost.push(text);
                },
                onReasoning: (token: string) => {
                    reasoningPost.push(token);
                },
                onToolCallStart: (name: string, args: Record<string, any>) => {
                    pendingToolArgs.push({ name, args });
                    this.snapshotTurnToolChange(turnToolChanges, name, args);
                    reasoningPost.flush();
                    if (responseText.trim()) {
                        commitAssistantUpdate();
                    }
                    hasToolCalls = true;
                    totalToolCalls++;
                    post({ type: 'toolCallStart', name, args });
                },
                onToolCallEnd: (name: string, result: string, isError: boolean, elapsed: number, gitDiff?: string) => {
                    const index = pendingToolArgs.findIndex(item => item.name === name);
                    const matched = index >= 0 ? pendingToolArgs.splice(index, 1)[0] : undefined;
                    this.recordTurnToolChange(turnToolChanges, name, matched?.args || {}, isError);
                    post({ type: 'toolCallEnd', name, result: trimWebviewToolResult(result), isError, elapsed, gitDiff });
                },
                onRoundStart: (round: number) => {
                    reasoningPost.flush();
                    hasToolCalls = false;
                    responseText = '';
                    post({ type: 'roundStart', round });
                },
                onRoundEnd: (_round: number) => {
                    reasoningPost.flush();
                    // Flush accumulated text at end of each round so interleaved
                    // text output (thinking → text → tools) renders in real time
                    // instead of being held until onDone.
                    if (responseText) {
                        commitAssistantUpdate();
                    }
                },
                onStatus: (status: string) => {
                    post({ type: 'status', text: status });
                },
                onModelSwitched: (model: string, reason?: 'chat' | 'image') => {
                    post({ type: 'modelSwitched', model, reason });
                },
                onTokenUsage: (usage: any) => {
                    post({ type: 'tokenUsage', usage });
                    post(this.contextUsageMessage(activeId));
                },
                onEditPreview: (previewId: string, path: string, oldText: string, newText: string, matchCount: number, lineStart?: number, lineEnd?: number) => {
                    post({ type: 'editPreview', previewId, path, oldText, newText, matchCount, lineStart, lineEnd });
                },
                onWritePreview: (previewId: string, filePath: string, content: string, isCreate: boolean, oldText?: string) => {
                    post({ type: 'writePreview', previewId, filePath, content, isCreate, oldText });
                },
                onAskUser: (previewId: string, question: string, options: string[]) => {
                    post({ type: 'askUser', previewId, question, options });
                },
                onStopGuard: (info: any) => {
                    post({ type: 'stopGuard', ...info });
                },
                onWorkflowStart: (totalPhases: number, totalTasks: number) => {
                    post({ type: 'workflowStart', totalPhases, totalTasks });
                },
                onWorkflowPhaseStart: (phaseIndex: number, title: string, mode: string, taskCount: number) => {
                    post({ type: 'workflowPhaseStart', phaseIndex, title, mode, taskCount });
                },
                onWorkflowTaskStart: (phaseIndex: number, taskIndex: number, label: string) => {
                    post({ type: 'workflowTaskStart', phaseIndex, taskIndex, label });
                },
                onWorkflowTaskEnd: (phaseIndex: number, taskIndex: number, result: any) => {
                    post({ type: 'workflowTaskEnd', phaseIndex, taskIndex, result });
                },
                onWorkflowPhaseEnd: (phaseIndex: number, result: any) => {
                    post({ type: 'workflowPhaseEnd', phaseIndex, result });
                },
                onWorkflowEnd: (result: any) => {
                    post({ type: 'workflowEnd', result });
                },
                onAdversarialTurn: (persona: string, name: string, icon: string, phase: string, content: string, iteration: number) => {
                    post({ type: 'adversarialTurn', persona, name, icon, phase, content, iteration });
                },
                onAdversarialToolStart: (persona: string, toolName: string, args: Record<string, any>) => {
                    post({ type: 'adversarialToolStart', persona, toolName, args });
                },
                onAdversarialToolEnd: (persona: string, toolName: string, result: string, isError: boolean, elapsed: number) => {
                    post({ type: 'adversarialToolEnd', persona, toolName, result, isError, elapsed });
                },
                onDone: (response: string) => {
                    reasoningPost.flush();
                    const elapsedSec = Math.max(0, (Date.now() - turnStartedAt) / 1000);
                    const stoppedByUser = response === '(stopped by user)' || (wasStopRequested() && isUserStoppedMessage(response));
                    turnStoppedByUser = stoppedByUser;
                    if (!stoppedByUser) {
                        streamRender.cancel();
                        emitFinalAnswer(response);
                    } else if (responseText.trim()) {
                        commitAssistantUpdate();
                    }
                    this.annotateLastAssistantElapsed(activeId, elapsedSec);
                    post({ type: 'done', response, elapsedSec });
                    // Send conversation-level usage summary
                    const convUsage = this.agent.getTokenTracker().getConversationUsage(activeId);
                    if (convUsage) {
                        post({ type: 'conversationUsage', usage: {
                            totalTokens: convUsage.totalTokens,
                            callCount: convUsage.callCount,
                        }});
                    }
                    // Auto-save to history
                    const msgs = this.agent.getMessages(activeId);
                    this.queueHistorySave(activeId, conv.title, msgs, conv.model, this.historyMetadata(conv));
                    post(this.contextUsageMessage(activeId));
                    this.postTaskChanges(post, baselinePatch, turnToolChanges);
                    if (stoppedByUser) {
                        post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '已手动停止当前任务。' : 'Stopped this task manually.' });
                    }
                    // Plan mode: auto-save plan text to ~/.mimo/plans/, show confirm buttons
                    // Skip if response is a greeting/direct reply (not an actual plan)
                    const _hasPlanMarkers = looksLikePlanResponse(response);
                    if (conv.mode === 'plan' && !startedAsPlanExecution && response && _hasPlanMarkers) {
                        try {
                            const cleanedPlan = sanitizePlanMarkdown(response);
                            // Use user home ~/.mimo/plans/ (not workspace .mimo)
                            const mimoPlansDir = getMimoPlansDir();
                            fs.mkdirSync(mimoPlansDir, { recursive: true });
                            // Unique filename: plan-{convId}-{timestamp}.md
                            const planId = `plan-${activeId}-${Date.now()}`;
                            const planFilename = `${planId}.md`;
                            const planPath = path.join(mimoPlansDir, planFilename);
                            fs.writeFileSync(planPath, cleanedPlan, 'utf-8');
                            // Store plan path in per-panel state
                            const stPlan2 = this.findStateByPanel(panel);
                            if (stPlan2) {
                                stPlan2.planPath = planPath;
                                stPlan2.planId = planId;
                                stPlan2.planContent = cleanedPlan;
                            }
                            // Auto-clean old plan files
                            cleanOldPlans(mimoPlansDir);
                        } catch { /* ignore save errors */ }
                        post({ type: 'planReady', planContent: this.findStateByPanel(panel)?.planContent, planPath: this.findStateByPanel(panel)?.planPath });
                    }
                },
                onError: (error: string) => {
                    if (turnStoppedByUser || (wasStopRequested() && isUserStoppedMessage(error)) || String(error || '').trim() === '(stopped by user)') {
                        turnStoppedByUser = true;
                        return;
                    }
                    turnHadError = true;
                    this.agent.releaseConversation(activeId);
                    finalizePartialAssistant();
                    reasoningPost.flush();
                    this.saveRecoverySnapshot(activeId, conv);
                    const stErr = this.findStateByPanel(panel);
                    if (stErr) stErr.messageQueue = [];
                    post({ type: 'systemI18n', key: 'recovery.snapshot.saved' });
                    post({ type: 'clearQueue' });
                    post({ type: 'error', error });
                    post(this.contextUsageMessage(activeId));
                },
            };

            await this.agent.chat(text, handlers, images, activeId);
        } catch (e: any) {
            if (turnStoppedByUser || (wasStopRequested() && isUserStoppedMessage(e?.message || e)) || String(e?.message || e || '').trim() === '(stopped by user)') {
                turnStoppedByUser = true;
            } else {
                turnHadError = true;
                this.agent.releaseConversation(activeId);
                finalizePartialAssistant();
                const stErr = this.findStateByPanel(panel);
                if (stErr) stErr.messageQueue = [];
                post({ type: 'clearQueue' });
                post({ type: 'error', error: e.message });
                post(this.contextUsageMessage(activeId));
            }
        } finally {
            if (panelState) panelState.stopRequested = false;
            reasoningPost.cancel();
            streamRender.cancel();
            if (turnHadError) this.agent.releaseConversation(activeId);

            const finishUiTurn = () => {
                if (!isCurrentTurn()) return;
                if (this.agent.isConvBusy(activeId)) {
                    setTimeout(finishUiTurn, 120);
                    return;
                }
                this.activeTurnTokens.delete(activeId);
                rawPost(this.contextUsageMessage(activeId));
                rawPost({ type: 'idle' });

                // Process next queued message only after successful completion.
                // Failed provider/model calls should unlock the UI and wait for the user
                // to adjust model or generation settings before retrying.
                if (!turnHadError) {
                    this.processNextQueued(panel, convId);
                }
            };
            finishUiTurn();
        }
    }

    private async waitForConversationIdle(convId: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!this.agent.isConvBusy(convId)) return true;
            await new Promise(resolve => setTimeout(resolve, 120));
        }
        return !this.agent.isConvBusy(convId);
    }

    private processNextQueued(panel: vscode.WebviewPanel, convId?: string): void {
        // Find the panel's queue
        for (const [, st] of this.panels) {
            if (st.panel === panel && st.messageQueue.length > 0) {
                const next = st.messageQueue.shift()!;
                panel.webview.postMessage({ type: 'queueProcessed', remaining: st.messageQueue.length });
                // Process the queued message
                this.handleUserMessage(next.text, next.images, convId, panel).catch(e => {
                    console.error('[MiMo] Queued message handling failed:', e);
                });
                return;
            }
        }
    }

    private saveRecoverySnapshot(activeId: string, conv: any): void {
        try {
            const msgs = this.agent.getMessages(activeId);
            this.queueHistorySave(activeId, conv.title, msgs, conv.model, this.historyMetadata(conv));
        } catch {
            // Best-effort recovery only.
        }
    }

    private annotateLastAssistantElapsed(convId: string, elapsedSec: number): void {
        const messages = this.agent.getMessages(convId);
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                messages[i]._elapsedSec = Number(elapsedSec.toFixed(1));
                return;
            }
        }
    }

    private normalizeTurnChangePath(filePath: string): string {
        return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    }

    private lineCount(text: string): number {
        if (!text) return 0;
        return text.split(/\r\n|\r|\n/).length;
    }

    private countPatchChanges(patch: string): { added: number; removed: number } {
        const text = String(patch || '');
        if (!text.trim()) return { added: 0, removed: 0 };
        let added = 0;
        let removed = 0;
        for (const line of text.split(/\r?\n/)) {
            if (!line) continue;
            if (
                line.startsWith('diff --git') ||
                line.startsWith('index ') ||
                line.startsWith('---') ||
                line.startsWith('+++') ||
                line.startsWith('@@')
            ) {
                continue;
            }
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
        }
        return { added, removed };
    }

    private estimateEditCounts(args: Record<string, any>): { added: number; removed: number } {
        if (typeof args.old_text === 'string' || typeof args.new_text === 'string') {
            return {
                added: this.lineCount(String(args.new_text || '')),
                removed: this.lineCount(String(args.old_text || '')),
            };
        }
        if (typeof args.line_start === 'number' && typeof args.line_end === 'number') {
            const removed = Math.max(0, Math.floor(args.line_end) - Math.floor(args.line_start) + 1);
            return { added: this.lineCount(String(args.new_text || '')), removed };
        }
        return { added: 0, removed: 0 };
    }

    private getWorkspaceRoot(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    }

    private resolveTurnToolPath(filePath: string): { fullPath: string; relativePath: string } | null {
        const workspace = this.getWorkspaceRoot();
        if (!workspace || !filePath) return null;
        const fullPath = path.isAbsolute(filePath)
            ? path.resolve(filePath)
            : path.resolve(workspace, filePath);
        if (!isPathInside(workspace, fullPath)) return null;
        const relativePath = path.relative(workspace, fullPath).replace(/\\/g, '/');
        if (!relativePath || relativePath.startsWith('..')) return null;
        return { fullPath, relativePath };
    }

    private turnMutationPaths(name: string, args: Record<string, any>): string[] {
        if (name === 'move_file') {
            return [
                String(args.source || args.src || args.from || ''),
                String(args.destination || args.dest || args.to || ''),
            ].filter(Boolean);
        }
        if (name === 'copy_file') {
            return [String(args.destination || args.dest || args.to || '')].filter(Boolean);
        }
        if (['write_file', 'edit_file', 'delete_file'].includes(name)) {
            return [String(args.path || args.filePath || args.file || '')].filter(Boolean);
        }
        return [];
    }

    private snapshotTurnToolChange(tracker: TurnChangeTracker, name: string, args: Record<string, any>): void {
        const mutationTools = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'copy_file']);
        if (!mutationTools.has(name)) return;
        for (const rawPath of this.turnMutationPaths(name, args)) {
            const resolved = this.resolveTurnToolPath(rawPath);
            if (!resolved) continue;
            const key = this.normalizeTurnChangePath(resolved.relativePath);
            if (tracker.snapshots.has(key)) continue;
            try {
                if (!fs.existsSync(resolved.fullPath)) {
                    tracker.snapshots.set(key, { path: resolved.relativePath, existed: false });
                    continue;
                }
                const stat = fs.statSync(resolved.fullPath);
                if (!stat.isFile()) {
                    tracker.snapshots.set(key, { path: resolved.relativePath, existed: true, skipped: 'not a regular file' });
                    continue;
                }
                if (stat.size > 1024 * 1024) {
                    tracker.snapshots.set(key, { path: resolved.relativePath, existed: true, skipped: 'file is larger than 1MB' });
                    continue;
                }
                const buffer = fs.readFileSync(resolved.fullPath);
                if (!this.isTextBufferForTurnPatch(buffer)) {
                    tracker.snapshots.set(key, { path: resolved.relativePath, existed: true, skipped: 'binary file' });
                    continue;
                }
                tracker.snapshots.set(key, {
                    path: resolved.relativePath,
                    existed: true,
                    content: buffer.toString('utf8'),
                });
            } catch (e: any) {
                tracker.snapshots.set(key, {
                    path: resolved.relativePath,
                    existed: true,
                    skipped: String(e?.message || e || 'snapshot failed').slice(0, 120),
                });
            }
        }
    }

    private isTextBufferForTurnPatch(buffer: Buffer): boolean {
        if (buffer.length === 0) return true;
        const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
        let nul = 0;
        for (const byte of sample) {
            if (byte === 0) nul++;
        }
        return nul <= sample.length * 0.05;
    }

    private readCurrentTurnFile(relativePath: string): { existed: boolean; content?: string; skipped?: string } {
        const resolved = this.resolveTurnToolPath(relativePath);
        if (!resolved) return { existed: false, skipped: 'path is outside workspace' };
        try {
            if (!fs.existsSync(resolved.fullPath)) return { existed: false };
            const stat = fs.statSync(resolved.fullPath);
            if (!stat.isFile()) return { existed: true, skipped: 'not a regular file' };
            if (stat.size > 1024 * 1024) return { existed: true, skipped: 'file is larger than 1MB' };
            const buffer = fs.readFileSync(resolved.fullPath);
            if (!this.isTextBufferForTurnPatch(buffer)) return { existed: true, skipped: 'binary file' };
            return { existed: true, content: buffer.toString('utf8') };
        } catch (e: any) {
            return { existed: false, skipped: String(e?.message || e || 'read failed').slice(0, 120) };
        }
    }

    private patchLineParts(content: string): { lines: string[]; hasFinalNewline: boolean } {
        const normalized = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (!normalized) return { lines: [], hasFinalNewline: true };
        const hasFinalNewline = normalized.endsWith('\n');
        const lines = hasFinalNewline ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
        return { lines, hasFinalNewline };
    }

    private patchRange(content: string, existed: boolean): string {
        if (!existed || !content) return '0,0';
        const count = this.patchLineParts(content).lines.length;
        return count > 0 ? `1,${count}` : '0,0';
    }

    private appendPatchLines(prefix: '+' | '-', content: string): string[] {
        const parts = this.patchLineParts(content);
        const out = parts.lines.map(line => `${prefix}${line}`);
        if (!parts.hasFinalNewline && out.length > 0) {
            out.push('\\ No newline at end of file');
        }
        return out;
    }

    private escapeTurnPatchPath(filePath: string): string {
        return filePath.replace(/\\/g, '/').replace(/\t/g, ' ');
    }

    private computeSnapshotLineDiff(
        oldLines: string[],
        newLines: string[],
    ): Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> {
        const m = oldLines.length;
        const n = newLines.length;
        if (m * n > 250_000) {
            return this.computeAnchoredSnapshotLineDiff(oldLines, newLines);
        }

        return this.computeLcsSnapshotLineDiff(oldLines, newLines);
    }

    private computeLcsSnapshotLineDiff(
        oldLines: string[],
        newLines: string[],
    ): Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> {
        const m = oldLines.length;
        const n = newLines.length;
        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = oldLines[i - 1] === newLines[j - 1]
                    ? dp[i - 1][j - 1] + 1
                    : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }

        const reversed: Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> = [];
        let i = m;
        let j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                reversed.push({ type: 'ctx', text: oldLines[i - 1], oldLn: i, newLn: j });
                i--;
                j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                reversed.push({ type: 'add', text: newLines[j - 1], newLn: j });
                j--;
            } else {
                reversed.push({ type: 'del', text: oldLines[i - 1], oldLn: i });
                i--;
            }
        }
        return reversed.reverse();
    }

    private computeAnchoredSnapshotLineDiff(
        oldLines: string[],
        newLines: string[],
    ): Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> {
        const lineInfo = new Map<string, { oldCount: number; newCount: number; oldIndex: number; newIndex: number }>();
        oldLines.forEach((line, index) => {
            const info = lineInfo.get(line) || { oldCount: 0, newCount: 0, oldIndex: index, newIndex: -1 };
            info.oldCount++;
            info.oldIndex = index;
            lineInfo.set(line, info);
        });
        newLines.forEach((line, index) => {
            const info = lineInfo.get(line) || { oldCount: 0, newCount: 0, oldIndex: -1, newIndex: index };
            info.newCount++;
            info.newIndex = index;
            lineInfo.set(line, info);
        });

        const anchors = Array.from(lineInfo.values())
            .filter(info => info.oldCount === 1 && info.newCount === 1 && info.oldIndex >= 0 && info.newIndex >= 0)
            .map(info => ({ oldIndex: info.oldIndex, newIndex: info.newIndex }))
            .sort((a, b) => a.oldIndex - b.oldIndex);
        const orderedAnchors = this.selectOrderedSnapshotAnchors(anchors);
        if (orderedAnchors.length === 0) {
            return this.computeCompactSnapshotLineDiff(oldLines, newLines);
        }

        const out: Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> = [];
        let oldCursor = 0;
        let newCursor = 0;
        for (const anchor of orderedAnchors) {
            if (anchor.oldIndex < oldCursor || anchor.newIndex < newCursor) continue;
            this.appendSnapshotSegmentDiff(out, oldLines, newLines, oldCursor, anchor.oldIndex, newCursor, anchor.newIndex);
            out.push({
                type: 'ctx',
                text: oldLines[anchor.oldIndex],
                oldLn: anchor.oldIndex + 1,
                newLn: anchor.newIndex + 1,
            });
            oldCursor = anchor.oldIndex + 1;
            newCursor = anchor.newIndex + 1;
        }
        this.appendSnapshotSegmentDiff(out, oldLines, newLines, oldCursor, oldLines.length, newCursor, newLines.length);
        return out;
    }

    private selectOrderedSnapshotAnchors(anchors: Array<{ oldIndex: number; newIndex: number }>): Array<{ oldIndex: number; newIndex: number }> {
        if (anchors.length <= 1) return anchors;
        const predecessors = new Array<number>(anchors.length).fill(-1);
        const pileTops: number[] = [];
        for (let i = 0; i < anchors.length; i++) {
            let lo = 0;
            let hi = pileTops.length;
            while (lo < hi) {
                const mid = Math.floor((lo + hi) / 2);
                if (anchors[pileTops[mid]].newIndex < anchors[i].newIndex) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            if (lo > 0) {
                predecessors[i] = pileTops[lo - 1];
            }
            pileTops[lo] = i;
        }

        const ordered: Array<{ oldIndex: number; newIndex: number }> = [];
        let cursor = pileTops[pileTops.length - 1];
        while (cursor >= 0) {
            ordered.push(anchors[cursor]);
            cursor = predecessors[cursor];
        }
        return ordered.reverse();
    }

    private appendSnapshotSegmentDiff(
        out: Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }>,
        oldLines: string[],
        newLines: string[],
        oldStart: number,
        oldEnd: number,
        newStart: number,
        newEnd: number,
    ): void {
        if (oldStart >= oldEnd && newStart >= newEnd) return;
        const oldSegment = oldLines.slice(oldStart, oldEnd);
        const newSegment = newLines.slice(newStart, newEnd);
        const segmentDiff = oldSegment.length * newSegment.length <= 250_000
            ? this.computeLcsSnapshotLineDiff(oldSegment, newSegment)
            : this.computeCompactSnapshotLineDiff(oldSegment, newSegment);
        for (const line of segmentDiff) {
            out.push({
                type: line.type,
                text: line.text,
                oldLn: typeof line.oldLn === 'number' ? line.oldLn + oldStart : undefined,
                newLn: typeof line.newLn === 'number' ? line.newLn + newStart : undefined,
            });
        }
    }

    private computeCompactSnapshotLineDiff(
        oldLines: string[],
        newLines: string[],
    ): Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> {
        const out: Array<{ type: 'ctx' | 'del' | 'add'; text: string; oldLn?: number; newLn?: number }> = [];
        let prefix = 0;
        while (
            prefix < oldLines.length &&
            prefix < newLines.length &&
            oldLines[prefix] === newLines[prefix]
        ) {
            prefix++;
        }

        let suffix = 0;
        while (
            suffix < oldLines.length - prefix &&
            suffix < newLines.length - prefix &&
            oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
        ) {
            suffix++;
        }

        if (prefix === oldLines.length && prefix === newLines.length) {
            return [];
        }

        if (oldLines.length === newLines.length) {
            for (let index = 0; index < oldLines.length; index++) {
                if (oldLines[index] === newLines[index]) {
                    out.push({ type: 'ctx', text: oldLines[index], oldLn: index + 1, newLn: index + 1 });
                } else {
                    out.push({ type: 'del', text: oldLines[index], oldLn: index + 1 });
                    out.push({ type: 'add', text: newLines[index], newLn: index + 1 });
                }
            }
            return out;
        }

        for (let index = 0; index < prefix; index++) {
            out.push({ type: 'ctx', text: oldLines[index], oldLn: index + 1, newLn: index + 1 });
        }

        const oldChangeEnd = oldLines.length - suffix;
        const newChangeEnd = newLines.length - suffix;
        for (let index = prefix; index < oldChangeEnd; index++) {
            out.push({ type: 'del', text: oldLines[index], oldLn: index + 1 });
        }
        for (let index = prefix; index < newChangeEnd; index++) {
            out.push({ type: 'add', text: newLines[index], newLn: index + 1 });
        }

        for (let offset = suffix; offset > 0; offset--) {
            const oldIndex = oldLines.length - offset;
            const newIndex = newLines.length - offset;
            out.push({ type: 'ctx', text: oldLines[oldIndex], oldLn: oldIndex + 1, newLn: newIndex + 1 });
        }

        return out;
    }

    private formatHunkRange(start: number, count: number): string {
        if (count === 1) return String(start);
        return `${start},${count}`;
    }

    private buildCompactModificationPatch(filePath: string, beforeContent: string, afterContent: string): string {
        const before = this.patchLineParts(beforeContent);
        const after = this.patchLineParts(afterContent);
        const diff = this.computeSnapshotLineDiff(before.lines, after.lines);
        const changedIndexes = diff
            .map((line, index) => line.type === 'add' || line.type === 'del' ? index : -1)
            .filter(index => index >= 0);
        if (changedIndexes.length === 0) return '';

        const context = 3;
        const ranges: Array<{ start: number; end: number }> = [];
        for (const index of changedIndexes) {
            const start = Math.max(0, index - context);
            const end = Math.min(diff.length - 1, index + context);
            const last = ranges[ranges.length - 1];
            if (last && start <= last.end + 1) {
                last.end = Math.max(last.end, end);
            } else {
                ranges.push({ start, end });
            }
        }

        const safePath = this.escapeTurnPatchPath(filePath);
        const out = [
            `diff --git a/${safePath} b/${safePath}`,
            `--- a/${safePath}`,
            `+++ b/${safePath}`,
        ];

        for (const range of ranges) {
            const hunk = diff.slice(range.start, range.end + 1);
            const oldCount = hunk.filter(line => line.type === 'ctx' || line.type === 'del').length;
            const newCount = hunk.filter(line => line.type === 'ctx' || line.type === 'add').length;
            const firstOld = hunk.find(line => typeof line.oldLn === 'number')?.oldLn;
            const firstNew = hunk.find(line => typeof line.newLn === 'number')?.newLn;
            const oldStart = firstOld ?? Math.max(0, (firstNew ?? 1) - 1);
            const newStart = firstNew ?? Math.max(0, (firstOld ?? 1) - 1);
            out.push(`@@ -${this.formatHunkRange(oldStart, oldCount)} +${this.formatHunkRange(newStart, newCount)} @@`);

            for (const line of hunk) {
                if (line.type === 'ctx') {
                    out.push(` ${line.text}`);
                } else if (line.type === 'del') {
                    out.push(`-${line.text}`);
                    if (!before.hasFinalNewline && line.oldLn === before.lines.length) {
                        out.push('\\ No newline at end of file');
                    }
                } else {
                    out.push(`+${line.text}`);
                    if (!after.hasFinalNewline && line.newLn === after.lines.length) {
                        out.push('\\ No newline at end of file');
                    }
                }
            }
        }

        return out.join('\n') + '\n';
    }

    private buildFullFileTurnPatch(filePath: string, before: TurnFileSnapshot, after: { existed: boolean; content?: string }): string {
        const safePath = this.escapeTurnPatchPath(filePath);
        const beforeContent = before.existed ? String(before.content || '') : '';
        const afterContent = after.existed ? String(after.content || '') : '';
        if (before.existed && after.existed) {
            return this.buildCompactModificationPatch(filePath, beforeContent, afterContent);
        }
        const oldRange = this.patchRange(beforeContent, before.existed);
        const newRange = this.patchRange(afterContent, after.existed);
        const header = [
            `diff --git a/${safePath} b/${safePath}`,
            before.existed && !after.existed ? 'deleted file mode 100644' : '',
            !before.existed && after.existed ? 'new file mode 100644' : '',
            before.existed ? `--- a/${safePath}` : '--- /dev/null',
            after.existed ? `+++ b/${safePath}` : '+++ /dev/null',
            `@@ -${oldRange} +${newRange} @@`,
        ].filter(Boolean);
        return [
            ...header,
            ...this.appendPatchLines('-', beforeContent),
            ...this.appendPatchLines('+', afterContent),
        ].join('\n') + '\n';
    }

    private buildSnapshotTurnSummary(tracker: TurnChangeTracker): any | null {
        const files: TurnChangeFile[] = [];
        const patches: string[] = [];
        const warnings: string[] = [];
        const seen = new Set<string>();

        for (const snapshot of tracker.snapshots.values()) {
            const key = this.normalizeTurnChangePath(snapshot.path);
            if (seen.has(key)) continue;
            seen.add(key);
            const current = this.readCurrentTurnFile(snapshot.path);
            const skipped = snapshot.skipped || current.skipped;
            const beforeContent = snapshot.existed ? String(snapshot.content || '') : '';
            const afterContent = current.existed ? String(current.content || '') : '';
            if (!snapshot.existed && !current.existed) continue;
            if (!skipped && snapshot.existed === current.existed && beforeContent === afterContent) continue;

            const beforeLines = snapshot.existed ? this.lineCount(beforeContent) : 0;
            const afterLines = current.existed ? this.lineCount(afterContent) : 0;
            const tracked = Array.from(tracker.files.values()).find(file => this.fileKeysMatch(file.path, snapshot.path));
            const filePatch = !skipped ? this.buildFullFileTurnPatch(snapshot.path, snapshot, current) : '';
            const patchCounts = this.countPatchChanges(filePatch);
            files.push({
                path: snapshot.path,
                added: patchCounts.added || tracked?.added || Math.max(0, afterLines - beforeLines),
                removed: patchCounts.removed || tracked?.removed || Math.max(0, beforeLines - afterLines),
                action: tracked?.action || (!snapshot.existed ? 'write' : !current.existed ? 'delete' : 'edit'),
                source: 'tool',
                hasToolDiff: tracked?.hasToolDiff,
                binary: !!skipped,
                toolDiff: filePatch || undefined,
            } as any);
            if (skipped) {
                warnings.push(`${snapshot.path}: ${skipped}`);
                continue;
            }
            if (filePatch) patches.push(filePatch);
        }

        if (files.length === 0) return null;
        const patch = patches.join('\n');
        const totals = this.countPatchChanges(patch);
        const warning = warnings.length > 0
            ? `部分文件无法生成本轮快照 patch，已禁用自动撤销：${warnings.slice(0, 3).join('；')}${warnings.length > 3 ? '；...' : ''}`
            : undefined;
        return {
            id: `turn_changes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            files: files.sort((a, b) => a.path.localeCompare(b.path)),
            totalAdded: totals.added,
            totalRemoved: totals.removed,
            patch,
            createdAt: Date.now(),
            canUndo: !!patch && warnings.length === 0,
            warning,
        };
    }

    private recordTurnToolChange(
        tracker: TurnChangeTracker,
        name: string,
        args: Record<string, any>,
        isError: boolean,
    ): void {
        if (isError) return;
        const mutationTools = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'copy_file']);
        if (!mutationTools.has(name)) return;

        const pathArg = name === 'move_file' || name === 'copy_file'
            ? String(args.destination || args.dest || args.to || '')
            : String(args.path || args.filePath || args.file || '');
        if (!pathArg) return;

        let added = 0;
        let removed = 0;
        let action = 'edit';
        let hasToolDiff = false;
        if (name === 'write_file') {
            added = this.lineCount(String(args.content || ''));
            action = args.isCreate === false ? 'write' : 'write';
            hasToolDiff = true;
        } else if (name === 'edit_file') {
            const counts = this.estimateEditCounts(args);
            added = counts.added;
            removed = counts.removed;
            action = 'edit';
            hasToolDiff = typeof args.old_text === 'string' || typeof args.new_text === 'string';
        } else if (name === 'delete_file') {
            action = 'delete';
            removed = 1;
        } else if (name === 'move_file') {
            action = 'move';
            added = 1;
            removed = 1;
        } else if (name === 'copy_file') {
            action = 'copy';
            added = 1;
        }

        const key = this.normalizeTurnChangePath(pathArg);
        const existing = tracker.files.get(key);
        if (existing) {
            existing.added += added;
            existing.removed += removed;
            existing.hasToolDiff = existing.hasToolDiff || hasToolDiff;
            if (existing.action !== action) existing.action = 'edit';
            return;
        }
        tracker.files.set(key, {
            path: pathArg,
            added,
            removed,
            action,
            source: 'tool',
            hasToolDiff,
        });
    }

    private fileKeysMatch(a: string, b: string): boolean {
        const left = this.normalizeTurnChangePath(a);
        const right = this.normalizeTurnChangePath(b);
        if (!left || !right) return false;
        return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
    }

    private filterSummaryToTurnChanges(summary: any, tracker: TurnChangeTracker): any | null {
        const turnFiles = Array.from(tracker.files.values());
        if (turnFiles.length === 0) return null;
        if (!summary || !Array.isArray(summary.files)) return null;

        const filtered = summary.files.filter((file: any) =>
            turnFiles.some(turnFile => this.fileKeysMatch(turnFile.path, file.path || '')),
        );
        if (filtered.length === 0) return null;
        const patch = this.filterPatchToTurnChanges(String(summary.patch || ''), tracker);
        const totals = this.countPatchChanges(patch);
        return {
            ...summary,
            files: filtered,
            totalAdded: totals.added,
            totalRemoved: totals.removed,
            patch,
            canUndo: patch ? summary.canUndo : false,
            warning: patch ? summary.warning : (summary.warning || '本轮文件已记录，但没有可安全隔离的 Git patch；可查看工具记录，自动撤销不可用。'),
        };
    }

    private filterPatchToTurnChanges(patch: string, tracker: TurnChangeTracker): string {
        const text = String(patch || '').trimEnd();
        if (!text) return '';
        const turnFiles = Array.from(tracker.files.values());
        const blocks = text
            .split(/(?=^diff --git\s+)/m)
            .map(block => block.trimEnd())
            .filter(Boolean);
        const kept = blocks.filter(block => {
            const firstLine = block.split(/\r?\n/, 1)[0] || '';
            const match = firstLine.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
            if (!match) return false;
            const left = match[1] || '';
            const right = match[2] || '';
            return turnFiles.some(file =>
                this.fileKeysMatch(file.path, left) || this.fileKeysMatch(file.path, right),
            );
        });
        return kept.length ? kept.join('\n') + '\n' : '';
    }

    private buildToolOnlyTurnSummary(tracker: TurnChangeTracker, warning?: string): any | null {
        const files = Array.from(tracker.files.values()).sort((a, b) => a.path.localeCompare(b.path));
        if (files.length === 0) return null;
        return {
            id: `turn_changes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            files,
            totalAdded: files.reduce((sum, file) => sum + (file.added || 0), 0),
            totalRemoved: files.reduce((sum, file) => sum + (file.removed || 0), 0),
            patch: '',
            createdAt: Date.now(),
            canUndo: false,
            warning: warning || '本卡片只汇总本轮对话中由 MiMo 工具修改的文件；未使用 Git diff，因此可查看记录但不能自动撤销。',
        };
    }

    private async handleSkillInvocation(skillName: string, text: string, convId?: string, targetPanel?: vscode.WebviewPanel) {
        const panel = targetPanel || this.panel;
        if (!panel) return;
        const panelState = this.findStateByPanel(panel);
        const rawPost = (msg: any) => panel.webview.postMessage(msg);
        if (!convId) return;
        const activeId = convId;
        const conv = this.agent.getConversation(activeId);
        if (!conv) return;
        if (this.activeTurnTokens.has(activeId) || this.agent.isConvBusy(activeId)) {
            rawPost({ type: 'system', text: 'This conversation is already running. Wait for completion or stop it first.' });
            return;
        }
        const turnToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        this.activeTurnTokens.set(activeId, turnToken);
        const isCurrentTurn = () => this.activeTurnTokens.get(activeId) === turnToken;
        const post = (msg: any) => {
            if (!isCurrentTurn()) return false;
            panel.webview.postMessage(msg);
            return true;
        };

        post({ type: 'userMessage', text: `[${skillName}] ${text}` });
        post(this.contextUsageMessage(activeId, { text: `[${skillName}] ${text}` }));
        const turnStartedAt = Date.now();
        const baselineChanges = await this.agent.getWorkspaceChangeSummary();
        const baselinePatch = baselineChanges?.patch || '';
        const turnToolChanges: TurnChangeTracker = { files: new Map(), snapshots: new Map() };
        post({ type: 'busy' });

        let responseText = '';
        let committedResponseText = '';
        let finalAnswerEmitted = false;
        let hasToolCalls = false;
        let totalToolCalls = 0;
        let turnStoppedByUser = false;
        const wasStopRequested = () => this.findStateByPanel(panel)?.stopRequested === true;
        const pendingToolArgs: Array<{ name: string; args: Record<string, any> }> = [];
        const streamRender = createStreamingRenderQueue(post);
        const reasoningPost = createReasoningPostQueue(post);
        const commitAssistantUpdate = () => {
            streamRender.cancel();
            renderAssistantMarkdown(post, 'assistantUpdate', responseText);
            committedResponseText += responseText;
            responseText = '';
        };
        const emitFinalAnswer = (response: string) => {
            if (finalAnswerEmitted) return;
            const responseToEmit = (() => {
                if (!response) return responseText;
                if (!committedResponseText) return response;
                if (response.startsWith(committedResponseText)) {
                    return response.slice(committedResponseText.length);
                }
                if (committedResponseText.includes(response.trim())) return responseText;
                return responseText || response;
            })();
            if (responseToEmit.trim()) {
                renderAssistantMarkdown(post, 'finalAnswer', responseToEmit);
            }
            finalAnswerEmitted = true;
            responseText = '';
        };
        const finalizePartialAssistant = () => {
            reasoningPost.flush();
            streamRender.cancel();
            if (responseText.trim()) {
                commitAssistantUpdate();
            }
        };
        try {
            await this.agent.chatWithSkill(skillName, text, {
                onToken: (token) => {
                    responseText += token;
                    streamRender.schedule(responseText);
                },
                onAssistantUpdate: (text: string) => {
                    streamRender.cancel();
                    renderAssistantMarkdown(post, 'assistantUpdate', text);
                    committedResponseText += text;
                    responseText = '';
                },
                onVerificationUpdate: (text: string, preservedDraft?: string) => {
                    streamRender.cancel();
                    if (responseText.trim()) {
                        renderAssistantMarkdown(post, 'finalAnswer', responseText);
                        committedResponseText += responseText;
                        responseText = '';
                    } else if (preservedDraft?.trim()) {
                        renderAssistantMarkdown(post, 'finalAnswer', preservedDraft);
                        committedResponseText += preservedDraft;
                    }
                    renderAssistantMarkdown(post, 'verificationUpdate', text);
                },
                onFinalAnswer: (text: string) => {
                    streamRender.cancel();
                    emitFinalAnswer(text);
                },
                onThoughtSummary: (text: string) => reasoningPost.push(text),
                onReasoning: (token) => reasoningPost.push(token),
                onToolCallStart: (name, args) => {
                    pendingToolArgs.push({ name, args });
                    this.snapshotTurnToolChange(turnToolChanges, name, args);
                    reasoningPost.flush();
                    if (responseText.trim()) {
                        commitAssistantUpdate();
                    }
                    hasToolCalls = true;
                    totalToolCalls++;
                    post({ type: 'toolCallStart', name, args });
                },
                onToolCallEnd: (name, result, isError, elapsed, gitDiff) => {
                    const index = pendingToolArgs.findIndex(item => item.name === name);
                    const matched = index >= 0 ? pendingToolArgs.splice(index, 1)[0] : undefined;
                    this.recordTurnToolChange(turnToolChanges, name, matched?.args || {}, isError);
                    post({ type: 'toolCallEnd', name, result: trimWebviewToolResult(result), isError, elapsed, gitDiff });
                },
                onRoundStart: (round) => {
                    reasoningPost.flush();
                    hasToolCalls = false;
                    responseText = '';
                    post({ type: 'roundStart', round });
                },
                onRoundEnd: (_round: number) => {
                    reasoningPost.flush();
                    if (responseText) {
                        commitAssistantUpdate();
                    }
                },
                onStatus: (status) => post({ type: 'status', text: status }),
                onModelSwitched: (model, reason) => post({ type: 'modelSwitched', model, reason }),
                onTokenUsage: (usage) => {
                    post({ type: 'tokenUsage', usage });
                    post(this.contextUsageMessage(activeId));
                },
                onEditPreview: (previewId: string, path: string, oldText: string, newText: string, matchCount: number, lineStart?: number, lineEnd?: number) => {
                    post({ type: 'editPreview', previewId, path, oldText, newText, matchCount, lineStart, lineEnd });
                },
                onWritePreview: (previewId: string, filePath: string, content: string, isCreate: boolean, oldText?: string) => {
                    post({ type: 'writePreview', previewId, filePath, content, isCreate, oldText });
                },
                onAskUser: (previewId: string, question: string, options: string[]) => {
                    post({ type: 'askUser', previewId, question, options });
                },
                onStopGuard: (info: any) => {
                    post({ type: 'stopGuard', ...info });
                },
                onWorkflowStart: (totalPhases: number, totalTasks: number) => {
                    post({ type: 'workflowStart', totalPhases, totalTasks });
                },
                onWorkflowPhaseStart: (phaseIndex: number, title: string, mode: string, taskCount: number) => {
                    post({ type: 'workflowPhaseStart', phaseIndex, title, mode, taskCount });
                },
                onWorkflowTaskStart: (phaseIndex: number, taskIndex: number, label: string) => {
                    post({ type: 'workflowTaskStart', phaseIndex, taskIndex, label });
                },
                onWorkflowTaskEnd: (phaseIndex: number, taskIndex: number, result: any) => {
                    post({ type: 'workflowTaskEnd', phaseIndex, taskIndex, result });
                },
                onWorkflowPhaseEnd: (phaseIndex: number, result: any) => {
                    post({ type: 'workflowPhaseEnd', phaseIndex, result });
                },
                onWorkflowEnd: (result: any) => {
                    post({ type: 'workflowEnd', result });
                },
                onAdversarialTurn: (persona: string, name: string, icon: string, phase: string, content: string, iteration: number) => {
                    post({ type: 'adversarialTurn', persona, name, icon, phase, content, iteration });
                },
                onAdversarialToolStart: (persona: string, toolName: string, args: Record<string, any>) => {
                    post({ type: 'adversarialToolStart', persona, toolName, args });
                },
                onAdversarialToolEnd: (persona: string, toolName: string, result: string, isError: boolean, elapsed: number) => {
                    post({ type: 'adversarialToolEnd', persona, toolName, result, isError, elapsed });
                },
                onDone: (response: string) => {
                    reasoningPost.flush();
                    const elapsedSec = Math.max(0, (Date.now() - turnStartedAt) / 1000);
                    const stoppedByUser = response === '(stopped by user)' || (wasStopRequested() && isUserStoppedMessage(response));
                    turnStoppedByUser = stoppedByUser;
                    streamRender.cancel();
                    if (stoppedByUser && responseText.trim()) {
                        commitAssistantUpdate();
                    } else {
                        emitFinalAnswer(response);
                    }
                    this.annotateLastAssistantElapsed(activeId, elapsedSec);
                    post({ type: 'done', response, elapsedSec });
                    const convUsage = this.agent.getTokenTracker().getConversationUsage(activeId);
                    if (convUsage) {
                        post({ type: 'conversationUsage', usage: {
                            totalTokens: convUsage.totalTokens,
                            callCount: convUsage.callCount,
                        }});
                    }
                    const msgs = this.agent.getMessages(activeId);
                    this.queueHistorySave(activeId, conv.title, msgs, conv.model, this.historyMetadata(conv));
                    post(this.contextUsageMessage(activeId));
                    this.postTaskChanges(post, baselinePatch, turnToolChanges);
                    if (stoppedByUser) {
                        post({ type: 'system', text: vscode.env.language.startsWith('zh') ? '已手动停止当前任务。' : 'Stopped this task manually.' });
                    }
                },
                onError: (error) => {
                    if (turnStoppedByUser || (wasStopRequested() && isUserStoppedMessage(error)) || String(error || '').trim() === '(stopped by user)') {
                        turnStoppedByUser = true;
                        return;
                    }
                    finalizePartialAssistant();
                    reasoningPost.flush();
                    this.saveRecoverySnapshot(activeId, conv);
                    post({ type: 'systemI18n', key: 'recovery.snapshot.saved' });
                    post({ type: 'error', error });
                    post(this.contextUsageMessage(activeId));
                },
            });
        } catch (e: any) {
            if (turnStoppedByUser || (wasStopRequested() && isUserStoppedMessage(e?.message || e)) || String(e?.message || e || '').trim() === '(stopped by user)') {
                turnStoppedByUser = true;
            } else {
                finalizePartialAssistant();
                post({ type: 'error', error: e.message });
                post(this.contextUsageMessage(activeId));
            }
        } finally {
            if (panelState) panelState.stopRequested = false;
            reasoningPost.cancel();
            streamRender.cancel();
            const finishUiTurn = () => {
                if (!isCurrentTurn()) return;
                if (this.agent.isConvBusy(activeId)) {
                    setTimeout(finishUiTurn, 120);
                    return;
                }
                this.activeTurnTokens.delete(activeId);
                rawPost(this.contextUsageMessage(activeId));
                rawPost({ type: 'idle' });
                this.processNextQueued(panel, convId);
            };
            finishUiTurn();
        }
    }

    private postTaskChanges(post: (msg: any) => void, _baselinePatch = '', turnToolChanges?: TurnChangeTracker): void {
        if (!turnToolChanges || turnToolChanges.files.size === 0) return;
        const snapshotSummary = this.buildSnapshotTurnSummary(turnToolChanges);
        if (snapshotSummary) {
            post({ type: 'taskChanges', summary: snapshotSummary });
            return;
        }
        const toolOnly = this.buildToolOnlyTurnSummary(
            turnToolChanges,
            '本轮文件已由工具记录，但无法生成独立的本轮快照 patch；为避免混入任务开始前已有的工作区改动，自动撤销不可用。',
        );
        if (toolOnly) post({ type: 'taskChanges', summary: toolOnly });
    }

    /**
     * Restore conversation state to webview after panel re-resolution.
     * Called when the sidebar panel becomes visible again after being hidden.
     */
    private restoreStateToWebview(targetPanel?: vscode.WebviewPanel): void {
        // Use THIS panel's active conversation, not the global one
        const p = targetPanel || this.panel;
        const st7 = p ? this.findStateByPanel(p) : undefined;
        const convId = st7?.activeConvId;
        if (!convId) return;
        const conv = this.agent.getConversation(convId);
        if (!conv) return;

        // Always sync lightweight state (tabs, title, model, busy)
        this.postToWebview({ type: 'tabList', tabs: this.getTabList(st7?.convIds, convId), activeId: convId }, p);
        this.postToWebview({ type: 'convTitle', title: conv.title, convId }, p);
        if (p) p.title = conv.title;

        const model = this.agent.getModelSelectionValue(convId);
        this.postToWebview(this.modelListMessage(convId), p);
        this.postToWebview({ type: 'modelCaps', caps: this.agent.getModelCapabilities(model) }, p);
        this.postToWebview(this.contextUsageMessage(convId), p);
        this.postToWebview({ type: 'restoreMode', mode: conv.mode, label: conv.mode }, p);
        if (p) this.postInputHistory(p, convId);
        this.postToWebview(this.agent.isConvBusy(convId) ? { type: 'busy' } : { type: 'idle' }, p);

        // Refresh history list
        this.postToWebview({ type: 'historyList', items: this.history.list() }, p);

        // Only restore messages on FIRST restore (retainContextWhenHidden preserves DOM).
        if (st7?.restored) return;

        // Fresh conversation with no messages -keep welcome page
        if (conv.messages.length === 0) {
            if (st7) st7.restored = true;
            return;
        }

        // Render a lightweight history transcript instead of replaying live events.
        this.postToWebview({ type: 'clearMessages' }, p);
        this.replayConversation(conv.messages, p);
        if (st7) st7.restored = true;
    }

    /**
     * Build a lightweight transcript snapshot for history viewing.
     * History must not replay live tool/reasoning events: that caused duplicate
     * "Processed" drawers, delayed rendering, and a frozen-feeling webview.
     */
    private buildHistoryTurns(messages: ChatMessage[]): any[] {
        const turns: any[] = [];
        let current: {
            user: { text: string; images: any[] | null };
            assistantTexts: string[];
            hasDetails: boolean;
            details: Array<{ type: 'reasoning' | 'tool'; title: string; body: string; elapsedSec?: number; isError?: boolean }>;
            elapsedSec: number;
            estimatedTokens: number;
            snapshot?: any;
        } | null = null;

        const flush = () => {
            if (!current) return;
            const visibleText = current.assistantTexts.map(s => s.trim()).filter(Boolean).pop() || '';
            const assistantHtml = visibleText ? renderMarkdown(visibleText) : '';
            const tokens = current.estimatedTokens || (visibleText ? Math.ceil(visibleText.length / 3) : 0);
            if (current.user.text || current.user.images?.length || assistantHtml) {
                turns.push({
                    user: current.user,
                    assistantHtml,
                    meta: {
                        hasDetails: current.hasDetails,
                        details: current.details,
                        elapsedSec: current.elapsedSec > 0 ? Number(current.elapsedSec.toFixed(1)) : 0,
                        tokens,
                    },
                    snapshot: current.snapshot,
                });
            }
            current = null;
        };

        for (const m of messages) {
            if (m.role === 'user') {
                flush();
                let images: any[] | null = null;
                if (Array.isArray(m.content)) {
                    const imgParts = m.content.filter((p: any) => p.type === 'image_url');
                    if (imgParts.length > 0) {
                        images = imgParts.map((p: any) => ({
                            name: 'image',
                            dataUrl: p.image_url?.url || '',
                        }));
                    }
                }
                current = {
                    user: { text: extractText(m.content), images },
                    assistantTexts: [],
                    hasDetails: false,
                    details: [],
                    elapsedSec: 0,
                    estimatedTokens: 0,
                    snapshot: undefined,
                };
                continue;
            }

            if (!current) continue;

            if (m.role === 'assistant') {
                const text = extractText(m.content);
                if (text.trim()) {
                    current.assistantTexts.push(text);
                    current.estimatedTokens += Math.ceil(text.length / 3);
                }
                if (typeof m._elapsedSec === 'number' && m._elapsedSec > 0) {
                    current.elapsedSec = m._elapsedSec;
                }
                if (m._uiSnapshot && typeof m._uiSnapshot === 'object') {
                    current.snapshot = m._uiSnapshot;
                }
                if (m.reasoning_content) {
                    current.hasDetails = true;
                    const reasoning = String(m.reasoning_content);
                    current.details.push({
                        type: 'reasoning',
                        title: 'reasoning',
                        body: reasoning,
                    });
                    current.estimatedTokens += Math.ceil(reasoning.length / 3);
                }
                if (m.tool_calls && m.tool_calls.length > 0) {
                    current.hasDetails = true;
                }
            } else if (m.role === 'tool') {
                current.hasDetails = true;
                const toolText = extractText(m.content);
                current.details.push({
                    type: 'tool',
                    title: m._toolName || 'tool',
                    body: toolText,
                    elapsedSec: Number(m._toolElapsed || 0),
                    isError: /^(Safety:|Tool error:|Unknown tool|Blocked by)/.test(toolText),
                });
                if (current.elapsedSec <= 0) {
                    current.elapsedSec += Number(m._toolElapsed || 0);
                }
            }
        }
        flush();
        return turns;
    }

    private replayConversation(messages: ChatMessage[], targetPanel?: vscode.WebviewPanel): void {
        const replayId = ++this.replaySeq;
        this.postToWebview({ type: 'historyReplayStart', replayId, totalMessages: messages.length }, targetPanel);
        const turns = this.buildHistoryTurns(messages);
        this.postToWebview({ type: 'historyRender', replayId, turns }, targetPanel);
    }

    private postToWebview(msg: any, targetPanel?: vscode.WebviewPanel) {
        const p = targetPanel || this.panel;
        if (p) p.webview.postMessage(msg);
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'app.js')
        );
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net;
             font-src https://fonts.gstatic.com https://cdn.jsdelivr.net;
             script-src 'nonce-${nonce}';
             img-src 'self' data: blob:;">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>${this.cssContent}</style>
</head>
<body>
<div id="header">
    <input type="text" id="conv-title" class="conv-title-input" value="New Chat" spellcheck="false">
    <span id="context-usage" class="context-usage context-low" data-tooltip="" aria-label="Context usage" style="display:none">0%</span>
    <div id="header-actions">
        <button class="tb-icon" id="btn-lang" title="Language"></button>
        <button class="tb-icon" id="btn-history" title="History"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></button>
        <button class="btn-new-flat" id="btn-new" title="New Chat">+</button>
        <button class="tb-icon" id="btn-settings" title="Settings"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    </div>
</div>

<div id="history-panel" class="panel hidden">
    <div class="panel-header"><span>History</span><button class="panel-close" id="close-history">&times;</button></div>
    <div style="padding:6px 12px;border-bottom:1px solid var(--vscode-editorWidget-border)">
        <input type="text" id="history-search" placeholder="Search history..." style="width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;font-size:11px;font-family:var(--vscode-font-family);outline:none">
    </div>
    <div class="panel-body" id="history-list"><div class="panel-empty">No history yet</div></div>
    <div style="padding:6px 12px;border-top:1px solid var(--vscode-editorWidget-border);display:flex;gap:4px">
        <button class="save-btn" id="export-md" style="flex:1;font-size:10px;padding:4px 8px">Export MD</button>
        <button class="save-btn" id="export-json" style="flex:1;font-size:10px;padding:4px 8px">Export JSON</button>
    </div>
</div>
<div id="settings-panel" class="panel hidden">
    <div class="panel-header"><span>Settings</span><button class="panel-close" id="close-settings">&times;</button></div>
    <div class="panel-body">
        <div class="setting-group"><label>API Key</label><input type="password" id="set-apikey" placeholder="sk-..."></div>
        <div class="setting-group"><label>Base URL</label><input type="text" id="set-baseurl"></div>
        <div class="setting-group"><label>Model</label><input type="text" id="set-model"></div>
        <div class="setting-group"><label>Active Profile ID</label><input type="text" id="set-active-provider-profile" placeholder="mimo"></div>
        <div class="setting-group"><label>Provider Profiles JSON</label><textarea id="set-provider-profiles" spellcheck="false" style="min-height:74px" placeholder='[{"id":"deepseek","base_url":"https://api.deepseek.com/v1","model":"deepseek-chat"}]'></textarea></div>
        <div class="setting-group"><label>Temperature</label><input type="number" id="set-temperature" min="0" max="2" step="0.1"></div>
        <div class="setting-group"><label>Max Tokens</label><input type="number" id="set-maxtokens" min="256" max="65536"></div>
        <div class="setting-group"><label>Command Timeout (s)</label><input type="number" id="set-command-timeout" min="5" max="3600"></div>
        <div class="setting-group"><label>Max Tool Output</label><input type="number" id="set-max-output-len" min="1000" max="200000"></div>
        <div class="setting-group"><label><input type="checkbox" id="set-thinking"> Enable thinking mode</label></div>
        <div class="setting-group"><label><input type="checkbox" id="set-completion-sound" checked> <span data-i18n="settings.completion.sound">Play sound when a task completes</span></label></div>
        <div class="setting-group"><label><span data-i18n="settings.completion.volume">Completion sound volume</span> <span id="set-completion-sound-volume-value">70%</span></label><input type="range" id="set-completion-sound-volume" min="0" max="100" step="5"></div>
        <div class="setting-group" style="margin-top:12px;padding-top:8px;border-top:1px solid var(--vscode-editorWidget-border)">
            <label style="font-weight:600;color:var(--vscode-foreground)">Memory</label>
        </div>
        <div class="setting-group"><label><input type="checkbox" id="set-memory-enabled" checked> Enable local long-term memory</label></div>
        <div class="setting-group"><label><input type="checkbox" id="set-memory-learn" checked> Learn explicit preferences from chat</label></div>
        <div class="setting-group"><label>Max Memory Items</label><input type="number" id="set-memory-max-items" min="10" max="500" step="10"></div>
        <div class="setting-group"><label>Memories Injected Per Turn</label><input type="number" id="set-memory-max-injected" min="0" max="20" step="1"></div>
        <div class="setting-group" style="margin-top:12px;padding-top:8px;border-top:1px solid var(--vscode-editorWidget-border)">
            <label style="font-weight:600;color:var(--vscode-foreground)">Safety</label>
        </div>
        <div class="setting-group"><label><input type="checkbox" id="set-sandbox-git" checked> Create Git snapshot before risky commands</label></div>
        <div class="setting-group"><label><input type="checkbox" id="set-sandbox-logging" checked> Record command execution logs</label></div>
        <div class="setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--vscode-editorWidget-border)">
            <label style="font-weight:600;color:var(--vscode-foreground)">Docker Sandbox</label>
        </div>
        <div class="setting-group"><label><input type="checkbox" id="set-sandbox"> Enable Docker sandbox (requires Docker Desktop)</label></div>
        <div class="setting-group"><label>Docker Image</label><input type="text" id="set-sandbox-image" placeholder="node:20-alpine"></div>
        <div class="setting-group"><label>Memory Limit</label><input type="text" id="set-sandbox-memory" placeholder="512m"></div>
        <div class="setting-group"><label>CPU Limit</label><input type="number" id="set-sandbox-cpu" min="1" max="8" step="1"></div>
        <div class="setting-group" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--vscode-editorWidget-border)">
            <label style="font-weight:600;color:var(--vscode-foreground)" data-i18n="settings.dependency.title">Dependency Install Policy</label>
        </div>
        <div class="setting-group"><label><input type="checkbox" id="set-dependency-install-enabled" checked> <span data-i18n="settings.dependency.enabled">Enable dependency install policy</span></label></div>
        <div class="setting-group"><label data-i18n="settings.dependency.project.mode">Project Dependency Installs</label><select id="set-dependency-project-mode"><option value="auto" data-i18n="settings.dependency.project.auto">Auto install project dependencies</option><option value="confirm" data-i18n="settings.dependency.project.confirm">Ask before project dependency installs</option><option value="disabled" data-i18n="settings.dependency.project.disabled">Disable project dependency installs</option></select></div>
        <div class="setting-group"><label data-i18n="settings.dependency.system.mode">System Software Installs</label><select id="set-dependency-system-mode"><option value="confirm" data-i18n="settings.dependency.system.confirm">Always ask before system installs</option><option value="disabled" data-i18n="settings.dependency.system.disabled">Disable system installs</option></select></div>
        <div class="setting-group"><label data-i18n="settings.dependency.long.timeout">Long Install Timeout (s)</label><input type="number" id="set-dependency-long-timeout" min="60" max="3600" step="30"></div>
        <button class="save-btn" id="save-settings">Save Settings</button>
    </div>
</div>

<div id="toolbar" style="display:none"></div>

<div id="messages">
    <div class="msg msg-welcome">
        <div class="welcome-icon">
            <svg viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="8" y="12" width="112" height="104" rx="18" ry="18" stroke="#FF6900" stroke-width="12"/>
                <path d="M34 96 V38 L64 58 L94 38 V96" stroke="#FF6900" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
        <p class="welcome-desc"></p>
        <p class="welcome-hint"></p>
    </div>
</div>

<div id="status-bar"><span class="status-dot"></span><span id="status-text"></span><span id="token-counter" class="token-counter" style="display:none;margin-left:auto;font-size:10px;opacity:0.7"></span></div>
<div id="input-area">
    <div id="cmd-palette"></div>
    <div id="input-wrapper" class="mode-auto">
        <div id="image-preview"></div>
        <div class="input-text-shell">
            <div id="input-render" aria-hidden="true"></div>
            <textarea id="input" data-i18n="paste.hint" placeholder="输入消息... (Ctrl+V 粘贴图片)" rows="1"></textarea>
        </div>
        <div id="input-bottom">
            <button id="add-file-btn" class="add-file-btn" title="Attach file" type="button">+</button>
            <div style="position:relative">
                <button class="mode-trigger" id="mode-trigger">
                    <span class="mode-label" id="mode-label" data-i18n="auto">Auto</span>
                    <span class="select-chevron" aria-hidden="true"></span>
                </button>
                <div id="mode-popup">
                    <div class="mode-option active" data-mode="auto">
                        <span class="mode-option-icon">A</span>
                        <div class="mode-option-info">
                            <span class="mode-option-name" data-i18n="auto">Auto</span>
                            <span class="mode-option-desc" data-i18n="auto.desc">AI decides when to use tools</span>
                        </div>
                    </div>
                    <div class="mode-option" data-mode="polling">
                        <span class="mode-option-icon">P</span>
                        <div class="mode-option-info">
                            <span class="mode-option-name" data-i18n="polling">Polling</span>
                            <span class="mode-option-desc" data-i18n="polling.desc">Auto-continue until task complete</span>
                        </div>
                    </div>
                    <div class="mode-option" data-mode="plan">
                        <span class="mode-option-icon">L</span>
                        <div class="mode-option-info">
                            <span class="mode-option-name" data-i18n="plan">Plan</span>
                            <span class="mode-option-desc" data-i18n="plan.desc">Text-only planning, no tools</span>
                        </div>
                    </div>
                    <div class="mode-option" data-mode="adversarial">
                        <span class="mode-option-icon">D</span>
                        <div class="mode-option-info">
                            <span class="mode-option-name" data-i18n="adversarial">Duel</span>
                            <span class="mode-option-desc" data-i18n="adversarial.desc">CrazyCoder vs SuperPM</span>
                        </div>
                    </div>
                    <div class="mode-option" data-mode="infinite">
                        <span class="mode-option-icon">I</span>
                        <div class="mode-option-info">
                            <span class="mode-option-name" data-i18n="infinite">Infinite</span>
                            <span class="mode-option-desc" data-i18n="infinite.desc">High-budget multi-pass refinement loop</span>
                        </div>
                    </div>
                </div>
            </div>
            <button id="reasoning-effort-btn" class="reasoning-effort-btn" title="Reasoning effort">推理: 均衡</button>
            <input type="file" id="file-input" accept="image/*" multiple style="display:none">
            <button class="tb-icon voice-btn" id="voice-btn" title="Voice input" style="display:none">Mic</button>
            <div style="flex:1"></div>
            <span class="model-select-wrap">
                <select id="model-select" aria-hidden="true" tabindex="-1"></select>
                <button class="model-picker-trigger" id="model-picker-trigger" title="Model">
                    <span id="model-picker-label">Model</span>
                    <span class="select-chevron" aria-hidden="true"></span>
                </button>
                <div id="model-picker-popup" class="model-picker-popup" role="listbox"></div>
            </span>
            <button id="send" title="Send"><svg class="send-icon send-icon-plane" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.5 12 19.5 5.5 13 20 10.6 13.4 4.5 12Z"/><path d="M10.6 13.4 19.5 5.5"/></svg></button>
        </div>
    </div>
</div>

<div id="img-overlay"><img id="overlay-img"></div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private openDiffReviewPanel(
        title: string,
        items: Array<{ filePath: string; patch: string; before: string; after: string }>,
    ): void {
        const panel = vscode.window.createWebviewPanel(
            'mimo-agent.diffReview',
            title,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'assets', 'mimo-agent-icon.svg');
        panel.webview.html = this.getDiffReviewHtml(panel.webview, title, items);
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.type !== 'openReadonlyDiff') return;
            try {
                const reviewTitle = sanitizeString(msg.title, 240) || 'MiMo Diff';
                const filePath = sanitizeString(msg.filePath, 4096) || 'changes.txt';
                const before = typeof msg.before === 'string' ? msg.before : String(msg.before || '');
                const after = typeof msg.after === 'string' ? msg.after : String(msg.after || '');
                const language = sanitizeString(msg.language, 40) || 'plaintext';
                const leftUri = this.readonlyPreviewProvider.createUri(`${reviewTitle} (Before)`, before, language, filePath);
                const rightUri = this.readonlyPreviewProvider.createUri(`${reviewTitle} (After)`, after, language, filePath);
                await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, reviewTitle, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.Beside,
                });
            } catch (e: any) {
                vscode.window.showWarningMessage(`Cannot open diff preview: ${e.message}`);
            }
        });
    }

    private getDiffReviewHtml(
        webview: vscode.Webview,
        title: string,
        items: Array<{ filePath: string; patch: string; before: string; after: string }>,
    ): string {
        const nonce = getNonce();
        const payload = JSON.stringify(items).replace(/</g, '\\u003c');
        const countPatch = (patch: string) => this.countPatchChanges(patch);
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'unsafe-inline';
             script-src 'nonce-${nonce}';">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#111315;color:#e6e6e6;font-family:Consolas,'Microsoft YaHei UI',monospace}
.layout{display:grid;grid-template-columns:280px 1fr;height:100vh}
.sidebar{border-right:1px solid rgba(255,255,255,.08);background:#0d0f11;overflow:auto}
.main{display:flex;flex-direction:column;min-width:0}
.header{padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:center;background:#15181b}
.title{font-size:14px;font-weight:700}
.meta{font-size:12px;color:#9aa4af}
.file-btn{display:block;width:100%;padding:12px 14px;border:0;border-bottom:1px solid rgba(255,255,255,.05);background:transparent;color:inherit;text-align:left;cursor:pointer;position:relative}
.file-btn:hover,.file-btn.active{background:#1b2127}
.file-btn.active::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:999px;background:#ff7a1a}
.file-name{display:block;font-size:13px;word-break:break-all}
.file-stats{display:block;margin-top:4px;font-size:11px;color:#9aa4af}
.viewer{padding:0;overflow:auto}
.toolbar{display:flex;gap:10px;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);background:#121518;position:sticky;top:0;z-index:2;flex-wrap:wrap}
.native-btn{border:1px solid rgba(255,255,255,.18);background:#1d232a;color:#f2f4f7;border-radius:8px;padding:6px 12px;cursor:pointer}
.native-btn:hover{background:#262d35}
.nav-btn{border:1px solid rgba(255,255,255,.12);background:#151a1f;color:#dce3ea;border-radius:8px;padding:6px 10px;cursor:pointer}
.nav-btn:hover{background:#20262d}
.nav-btn:disabled{opacity:.45;cursor:default}
.file-chip{display:inline-flex;align-items:center;gap:8px;border:1px solid rgba(255,255,255,.08);background:#161a1e;color:#dbe2e9;border-radius:999px;padding:5px 10px;font-size:11px}
.file-progress{color:#8a949f;font-size:11px}
.patch{padding:14px 16px;overflow:auto;font-size:12px;line-height:1.55}
.line{display:grid;grid-template-columns:56px 56px minmax(0,1fr);align-items:start}
.line.add{background:rgba(52,208,88,.08);color:#9ee6b0}
.line.del{background:rgba(255,69,58,.08);color:#ffb0aa}
.line.ctx{color:#b8c0c8}
.line.meta{color:#6cb6ff}
.line.hunk{color:#d2a8ff;background:rgba(210,168,255,.07)}
.ln{padding:0 10px 0 0;text-align:right;color:#6f7a85;user-select:none}
.ln.blank{color:transparent}
.code{white-space:pre;overflow-x:auto}
.code.full{grid-column:1 / -1}
.legend{display:flex;gap:8px;align-items:center;margin-left:auto;flex-wrap:wrap}
.legend span{font-size:11px;color:#8f98a3}
.legend em{font-style:normal;padding:2px 6px;border-radius:999px}
.legend .add{background:rgba(52,208,88,.12);color:#9ee6b0}
.legend .del{background:rgba(255,69,58,.12);color:#ffb0aa}
@media (max-width: 900px){
  .layout{grid-template-columns:1fr}
  .sidebar{max-height:32vh;border-right:0;border-bottom:1px solid rgba(255,255,255,.08)}
  .legend{margin-left:0}
}
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    ${items.map((item, index) => {
            const { added, removed } = countPatch(item.patch);
            return `<button class="file-btn${index === 0 ? ' active' : ''}" data-index="${index}">
              <span class="file-name">${escapeHtml(item.filePath)}</span>
              <span class="file-stats">+${added} / -${removed}</span>
            </button>`;
        }).join('')}
  </aside>
  <main class="main">
    <div class="header">
      <div class="title">${escapeHtml(title)}</div>
      <div class="meta">${items.length} files</div>
    </div>
    <div class="toolbar">
      <button id="prev-file" class="nav-btn">上一个</button>
      <button id="next-file" class="nav-btn">下一个</button>
      <span id="current-file" class="file-chip"></span>
      <span id="file-progress" class="file-progress"></span>
      <button id="open-native" class="native-btn">打开原生 Diff</button>
      <div class="legend"><span><em class="add">+</em> Added</span><span><em class="del">-</em> Removed</span></div>
    </div>
    <div class="viewer">
      <div id="patch" class="patch"></div>
    </div>
  </main>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const items = ${payload};
const patchEl = document.getElementById('patch');
const fileEl = document.getElementById('current-file');
const progressEl = document.getElementById('file-progress');
const nativeBtn = document.getElementById('open-native');
const prevBtn = document.getElementById('prev-file');
const nextBtn = document.getElementById('next-file');
let activeIndex = 0;
function detectLanguage(filePath){
  const ext = (String(filePath||'').match(/\\.([A-Za-z0-9_-]+)$/)?.[1] || '').toLowerCase();
  if(ext === 'svg') return 'xml';
  if(ext === 'md') return 'markdown';
  if(['ts','tsx','js','jsx','json','css','html','svg','py'].includes(ext)) return ext;
  return 'plaintext';
}
function renderPatch(patch){
  let oldLine = 0;
  let newLine = 0;
  patchEl.innerHTML = String(patch||'').split(/\\r?\\n/).map(line => {
    let cls = 'ctx';
    let left = '';
    let right = '';
    let full = false;
    if(line.startsWith('diff --git') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ')){
      cls = 'meta';
      full = true;
    } else if(line.startsWith('@@')) {
      cls = 'hunk';
      full = true;
      const match = line.match(/^@@\\s+-(\\d+)(?:,(\\d+))?\\s+\\+(\\d+)(?:,(\\d+))?\\s+@@/);
      if(match){
        oldLine = Math.max(0, Number(match[1] || '0') - 1);
        newLine = Math.max(0, Number(match[3] || '0') - 1);
      }
    } else if(line.startsWith('+') && !line.startsWith('+++')) {
      cls = 'add';
      newLine += 1;
      right = String(newLine);
    } else if(line.startsWith('-') && !line.startsWith('---')) {
      cls = 'del';
      oldLine += 1;
      left = String(oldLine);
    } else {
      oldLine += 1;
      newLine += 1;
      left = String(oldLine);
      right = String(newLine);
    }
    const safe = line.replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[ch]));
    if(full){
      return '<span class="line '+cls+'"><span class="code full">'+safe+'</span></span>';
    }
    return '<span class="line '+cls+'"><span class="ln'+(left ? '' : ' blank')+'">'+left+'</span><span class="ln'+(right ? '' : ' blank')+'">'+right+'</span><span class="code">'+safe+'</span></span>';
  }).join('');
}
function setActive(index){
  if(index < 0 || index >= items.length) return;
  activeIndex = index;
  document.querySelectorAll('.file-btn').forEach((btn, idx) => btn.classList.toggle('active', idx === index));
  const item = items[index];
  const patchLines = String(item.patch || '').split(/\\r?\\n/);
  const added = patchLines.filter(line => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = patchLines.filter(line => line.startsWith('-') && !line.startsWith('---')).length;
  fileEl.textContent = item.filePath + '  +' + added + ' / -' + removed;
  progressEl.textContent = '文件 ' + (index + 1) + ' / ' + items.length;
  prevBtn.disabled = index <= 0;
  nextBtn.disabled = index >= items.length - 1;
  renderPatch(item.patch);
  document.querySelector('.file-btn.active')?.scrollIntoView({ block: 'nearest' });
}
document.querySelectorAll('.file-btn').forEach(btn => {
  btn.addEventListener('click', () => setActive(Number(btn.dataset.index || '0')));
});
prevBtn.addEventListener('click', () => setActive(activeIndex - 1));
nextBtn.addEventListener('click', () => setActive(activeIndex + 1));
nativeBtn.addEventListener('click', () => {
  const item = items[activeIndex];
  vscode.postMessage({
    type: 'openReadonlyDiff',
    title: 'MiMo Diff - ' + item.filePath,
    filePath: item.filePath,
    before: item.before,
    after: item.after,
    language: detectLanguage(item.filePath),
  });
});
window.addEventListener('keydown', (e) => {
  if(e.key === 'ArrowUp' || e.key === 'ArrowLeft'){ e.preventDefault(); setActive(activeIndex - 1); }
  if(e.key === 'ArrowDown' || e.key === 'ArrowRight'){ e.preventDefault(); setActive(activeIndex + 1); }
  if(e.key.toLowerCase() === 'o'){ e.preventDefault(); nativeBtn.click(); }
});
setActive(0);
</script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
