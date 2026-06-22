import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { URL } from 'url';
const yauzl: typeof import('yauzl') = require('yauzl');

type JsonRpcMessage = {
    jsonrpc: '2.0';
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
    error?: { code: number; message: string; data?: any };
};

type ToolSpec = {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
    handler: (args: Record<string, any>) => Promise<string>;
};

type ApiEndpointMode = 'chat_completions' | 'responses';
type OfficeDocumentKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'doc' | 'ppt' | 'xls' | 'rtf' | 'odt' | 'odp' | 'ods' | 'unknown';

type OfficeArchiveInspection = {
    kind: OfficeDocumentKind;
    text: string;
    formulas: string[];
    mediaPaths: string[];
    mediaEntryNames: string[];
};

type ZipCapableDocumentKind = OfficeDocumentKind | 'epub' | 'zip' | 'jar' | 'apk' | 'cbz' | 'unknown';

type ArchiveEntryInfo = {
    name: string;
    size: number;
    compressedSize: number;
};

type EpubInspection = {
    text: string;
    mediaPaths: string[];
    mediaEntryNames: string[];
    chapterCount: number;
};

type TabularPreview = {
    kind: 'csv' | 'tsv' | 'xlsx';
    delimiter?: string;
    rowCount: number;
    columnCount: number;
    headers: string[];
    rows: string[][];
    sheets?: Array<{
        name: string;
        rowCount: number;
        columnCount: number;
        rows: string[][];
    }>;
};

type MathBackend = {
    command: string;
    scriptFlag: string;
};

const DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const DEFAULT_OMNI_MODEL = 'mimo-v2.5';
const DEFAULT_TTS_MODEL = 'mimo-v2.5-tts';
const DEFAULT_ASR_MODEL = 'mimo-v2.5-asr';
const MAX_LOCAL_BYTES = 80 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 24 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;
const OFFICE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff']);
const ZIP_CAPABLE_EXTENSIONS = new Set(['.zip', '.epub', '.docx', '.pptx', '.xlsx', '.odt', '.odp', '.ods', '.jar', '.apk', '.cbz']);

function env(name: string): string {
    return process.env[name] || '';
}

function hiddenArg(args: Record<string, any>, name: string): string {
    return String(args?.[name] || '').trim();
}

export function normalizeApiEndpointMode(value: unknown): ApiEndpointMode {
    return value === 'responses' ? 'responses' : 'chat_completions';
}

function apiKey(args: Record<string, any>): string {
    return hiddenArg(args, '_mimo_api_key') || env('MIMO_API_KEY') || env('MIMO_TP_API_KEY') || env('OPENAI_API_KEY');
}

function baseUrl(args: Record<string, any>): string {
    return (hiddenArg(args, '_mimo_base_url') || env('MIMO_MULTIMODAL_BASE_URL') || env('MIMO_BASE_URL') || env('OPENAI_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function apiEndpointMode(args: Record<string, any>): ApiEndpointMode {
    return normalizeApiEndpointMode(hiddenArg(args, '_mimo_api_endpoint') || env('MIMO_API_ENDPOINT'));
}

function omniModel(args: Record<string, any>): string {
    return hiddenArg(args, '_mimo_multimodal_model') || env('MIMO_OMNI_MODEL') || env('MIMO_MULTIMODAL_MODEL') || DEFAULT_OMNI_MODEL;
}

function ttsModel(args: Record<string, any>): string {
    return hiddenArg(args, '_mimo_tts_model') || env('MIMO_TTS_MODEL') || DEFAULT_TTS_MODEL;
}

function asrModel(args: Record<string, any>): string {
    return hiddenArg(args, '_mimo_asr_model') || env('MIMO_ASR_MODEL') || DEFAULT_ASR_MODEL;
}

function workspaceRoot(): string {
    return env('MIMO_WORKSPACE') || process.cwd();
}

function outputDir(): string {
    return env('MIMO_MULTIMODAL_OUTPUT_DIR') || path.join(workspaceRoot(), '.mimo', 'multimodal');
}

function ensureDir(dirPath: string): string {
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

function looksLikeDirectoryTarget(value: string): boolean {
    if (!value) return false;
    if (value.endsWith(path.sep) || /[\\/]$/.test(value)) return true;
    const ext = path.extname(value);
    return !ext;
}

function sanitizeBasename(name: string): string {
    return String(name || 'artifact')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'artifact';
}

function chooseRelatedOutputDir(sourcePath?: string, preferredOutput?: string): string {
    const preferred = String(preferredOutput || '').trim();
    if (preferred) {
        const resolved = resolveWorkspacePath(preferred);
        if (looksLikeDirectoryTarget(resolved)) return ensureDir(resolved);
        return ensureDir(path.dirname(resolved));
    }
    const source = String(sourcePath || '').trim();
    if (source) {
        const resolvedSource = resolveWorkspacePath(source);
        try {
            const stat = fs.statSync(resolvedSource);
            if (stat.isDirectory()) {
                return ensureDir(path.join(resolvedSource, '.mimo', 'multimodal'));
            }
            return ensureDir(path.join(path.dirname(resolvedSource), '.mimo'));
        } catch {
            return ensureDir(path.join(path.dirname(resolvedSource), '.mimo'));
        }
    }
    return ensureDir(outputDir());
}

function resolveWorkspacePath(input: string): string {
    if (!input || typeof input !== 'string') throw new Error('file_path is required');
    return path.isAbsolute(input) ? input : path.resolve(workspaceRoot(), input);
}

function isUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function isDataUrl(value: string): boolean {
    return /^data:[^;,]+(?:;base64)?,/i.test(value);
}

function mimeFromPath(filePath: string, fallback = 'application/octet-stream'): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.mpeg': 'video/mpeg',
        '.mpga': 'audio/mpeg',
        '.aac': 'audio/aac',
        '.ogg': 'audio/ogg',
        '.flac': 'audio/flac',
    };
    return map[ext] || fallback;
}

function readLocalAsDataUrl(filePath: string): string {
    const resolved = resolveWorkspacePath(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
    if (stat.size > MAX_LOCAL_BYTES) {
        throw new Error(`File is too large for inline upload (${stat.size} bytes, max ${MAX_LOCAL_BYTES}). Use a URL instead.`);
    }
    const data = fs.readFileSync(resolved).toString('base64');
    return `data:${mimeFromPath(resolved)};base64,${data}`;
}

function mediaData(args: Record<string, any>): string {
    const url = String(args.url || '').trim();
    if (url) return url;
    const data = String(args.data || args.data_url || '').trim();
    if (data) return data;
    const filePath = String(args.file_path || '').trim();
    if (filePath) return readLocalAsDataUrl(filePath);
    throw new Error('Provide url, data/data_url, or file_path');
}

function outputPath(prefix: string, format: string): string {
    fs.mkdirSync(outputDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(outputDir(), `${prefix}-${stamp}.${format}`);
}

export function buildSmartOutputPath(prefix: string, format: string, sourcePath?: string, preferredOutput?: string): string {
    const preferred = String(preferredOutput || '').trim();
    if (preferred) {
        const resolved = resolveWorkspacePath(preferred);
        if (!looksLikeDirectoryTarget(resolved)) {
            ensureDir(path.dirname(resolved));
            return resolved;
        }
    }
    const dir = chooseRelatedOutputDir(sourcePath, preferredOutput);
    const sourceBase = sourcePath ? sanitizeBasename(path.basename(sourcePath, path.extname(sourcePath))) : prefix;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `${prefix}-${sourceBase}-${stamp}.${format}`);
}

function buildChatBody(model: string, content: any[], maxTokens: number): Record<string, any> {
    return {
        model,
        messages: [
            {
                role: 'system',
                content: 'You are a concise multimodal analysis helper. Return factual, text-only results for a downstream reasoning model.',
            },
            {
                role: 'user',
                content,
            },
        ],
        max_completion_tokens: maxTokens,
    };
}

function buildResponsesBody(model: string, content: any[], maxTokens: number): Record<string, any> {
    return {
        model,
        input: content,
        max_output_tokens: maxTokens,
    };
}

async function postJson(pathname: string, body: Record<string, any>, args: Record<string, any>, timeoutMs = 120_000): Promise<any> {
    const key = apiKey(args);
    if (!key) throw new Error('Missing API key. Set MIMO_API_KEY, MIMO_TP_API_KEY, or OPENAI_API_KEY.');

    const url = `${baseUrl(args)}${pathname}`;
    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = transport.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: `${parsed.pathname}${parsed.search}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length,
                    Authorization: `Bearer ${key}`,
                    'api-key': key,
                    Accept: 'application/json',
                },
                timeout: timeoutMs,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk: Buffer) => (data += chunk.toString('utf-8')));
                res.on('end', () => {
                    if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
                        reject(new Error(`API error ${res.statusCode}: ${data.slice(0, 1000)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        reject(new Error(`Failed to parse API response: ${data.slice(0, 500)}`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('API request timeout'));
        });
        req.write(payload);
        req.end();
    });
}

function appendUsage(text: string, usage: any): string {
    const trimmed = String(text || '').trim();
    const suffix = usage ? `\n\nUsage: ${JSON.stringify(usage)}` : '';
    return `${trimmed}${suffix}`.trim();
}

function extractChatText(json: any): string {
    const message = json?.choices?.[0]?.message || {};
    return String(message.content || message.reasoning_content || json?.choices?.[0]?.text || '').trim();
}

export function extractResponsesText(json: any): string {
    const outputText = typeof json?.output_text === 'string' ? json.output_text.trim() : '';
    if (outputText) return outputText;

    const parts: string[] = [];
    for (const item of Array.isArray(json?.output) ? json.output : []) {
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item.content)) {
            for (const part of item.content) {
                const text = typeof part?.text === 'string' ? part.text.trim() : '';
                if (text) parts.push(text);
            }
        }
    }
    return parts.join('').trim();
}

function extractText(json: any): string {
    const text = extractChatText(json) || extractResponsesText(json);
    return appendUsage(text, json?.usage) || JSON.stringify(json);
}

function buildResponsesAnalyzeInput(kind: 'image', prompt: string, data: string): any[] {
    const system = 'You are a concise multimodal analysis helper. Return factual, text-only results for a downstream reasoning model.';
    const mediaPart = {
        type: 'input_image',
        image_url: data,
    };
    return [
        {
            role: 'system',
            content: [{ type: 'input_text', text: system }],
        },
        {
            role: 'user',
            content: [
                { type: 'input_text', text: prompt },
                mediaPart,
            ],
        },
    ];
}

export function canUseResponsesForAnalyze(kind: 'image' | 'audio' | 'video', args: Record<string, any>): boolean {
    return apiEndpointMode(args) === 'responses' && kind === 'image';
}

async function analyzeViaResponses(kind: 'image', args: Record<string, any>, model: string, prompt: string, data: string, maxTokens: number): Promise<string> {
    const json = await postJson('/responses', buildResponsesBody(model, buildResponsesAnalyzeInput(kind, prompt, data), maxTokens), args);
    return extractText(json);
}

async function analyzeMedia(kind: 'image' | 'audio' | 'video', args: Record<string, any>): Promise<string> {
    const prompt = String(args.prompt || defaultPrompt(kind));
    const maxTokens = Math.max(128, Math.min(8192, Number(args.max_tokens || 2048)));
    const model = String(args.model || omniModel(args));
    const data = mediaData(args);

    if (canUseResponsesForAnalyze(kind, args)) {
        try {
            return await analyzeViaResponses('image', args, model, prompt, data, maxTokens);
        } catch {
            // Fall through to chat/completions for provider compatibility.
        }
    }

    let mediaPart: Record<string, any>;

    if (kind === 'image') {
        mediaPart = { type: 'image_url', image_url: { url: data } };
    } else if (kind === 'audio') {
        mediaPart = { type: 'input_audio', input_audio: { data } };
    } else {
        mediaPart = { type: 'video_url', video_url: { url: data } };
    }

    const json = await postJson('/chat/completions', buildChatBody(model, [mediaPart, { type: 'text', text: prompt }], maxTokens), args);
    return extractText(json);
}

function defaultPrompt(kind: 'image' | 'audio' | 'video'): string {
    if (kind === 'image') return 'Describe the image and extract any visible text, UI state, errors, or code.';
    if (kind === 'audio') return 'Transcribe the audio if speech is present, then summarize important sounds and context.';
    return 'Describe the video, summarize visible actions, extract on-screen text, and note any audio/speech if available.';
}

async function transcribeAudio(args: Record<string, any>): Promise<string> {
    const prompt = String(args.prompt || 'Transcribe this audio accurately. Include timestamps if you can infer them.');
    const model = String(args.model || asrModel(args));
    const maxTokens = Math.max(128, Math.min(8192, Number(args.max_tokens || 4096)));
    const data = mediaData(args);
    const attempts = [
        { model, part: { type: 'input_audio', input_audio: { data } } },
        { model: omniModel(args), part: { type: 'input_audio', input_audio: { data } } },
    ];

    let lastError = '';
    for (const attempt of attempts) {
        try {
            const json = await postJson('/chat/completions', buildChatBody(attempt.model, [attempt.part, { type: 'text', text: prompt }], maxTokens), args);
            return extractText(json);
        } catch (e: any) {
            lastError = e?.message || String(e);
        }
    }
    throw new Error(lastError || 'ASR failed');
}

async function synthesizeSpeech(args: Record<string, any>): Promise<string> {
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required');
    const voice = String(args.voice || 'Chloe');
    const format = String(args.format || 'wav').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'wav';
    const style = String(args.style || 'Natural, clear, friendly delivery.');
    const model = String(args.model || ttsModel(args));
    const target = args.output_path
        ? resolveWorkspacePath(String(args.output_path))
        : outputPath('tts', format === 'pcm16' ? 'pcm' : format);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const json = await postJson('/chat/completions', {
        model,
        messages: [
            { role: 'user', content: style },
            { role: 'assistant', content: text },
        ],
        audio: { format, voice },
    }, args, 180_000);

    const data = json?.choices?.[0]?.message?.audio?.data;
    if (!data || typeof data !== 'string') {
        throw new Error(`TTS response did not include audio.data: ${JSON.stringify(json).slice(0, 1000)}`);
    }
    const bytes = Buffer.from(data, 'base64');
    fs.writeFileSync(target, bytes);
    const usage = json?.usage ? `\nUsage: ${JSON.stringify(json.usage)}` : '';
    return `Speech synthesized.\nPath: ${target}\nFormat: ${format}\nVoice: ${voice}\nBytes: ${bytes.length}${usage}`;
}

export function detectOfficeDocumentKind(filePath: string): OfficeDocumentKind {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    switch (ext) {
        case '.pdf': return 'pdf';
        case '.docx': return 'docx';
        case '.pptx': return 'pptx';
        case '.xlsx': return 'xlsx';
        case '.doc': return 'doc';
        case '.ppt': return 'ppt';
        case '.xls': return 'xls';
        case '.rtf': return 'rtf';
        case '.odt': return 'odt';
        case '.odp': return 'odp';
        case '.ods': return 'ods';
        default: return 'unknown';
    }
}

export function detectZipCapableDocumentKind(filePath: string): ZipCapableDocumentKind {
    const officeKind = detectOfficeDocumentKind(filePath);
    if (officeKind !== 'unknown') return officeKind;
    const ext = path.extname(String(filePath || '')).toLowerCase();
    switch (ext) {
        case '.epub': return 'epub';
        case '.zip': return 'zip';
        case '.jar': return 'jar';
        case '.apk': return 'apk';
        case '.cbz': return 'cbz';
        default: return 'unknown';
    }
}

function supportsArchiveInspection(kind: OfficeDocumentKind): boolean {
    return ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'].includes(kind);
}

function supportsZipArchiveInspection(kind: ZipCapableDocumentKind): boolean {
    return kind !== 'unknown';
}

function decodeXmlEntities(text: string): string {
    return String(text || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num) || 0))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16) || 0));
}

export function extractVisibleTextFromOfficeXml(xml: string): string {
    return decodeXmlEntities(String(xml || ''))
        .replace(/<w:tab\b[^>]*\/>/gi, ' ')
        .replace(/<w:br\b[^>]*\/>/gi, '\n')
        .replace(/<a:br\b[^>]*\/>/gi, '\n')
        .replace(/<\/(?:w:p|a:p|text:p|text:h|m:oMathPara)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+\n/g, '\n')
        .trim();
}

export function extractFormulaTextFromOfficeXml(xml: string): string[] {
    const formulas: string[] = [];
    const source = String(xml || '');
    const blocks = source.match(/<m:oMath(?:Para)?\b[\s\S]*?<\/m:oMath(?:Para)?>/gi) || [];
    for (const block of blocks) {
        const terms = Array.from(block.matchAll(/<m:t\b[^>]*>([\s\S]*?)<\/m:t>/gi))
            .map(match => decodeXmlEntities(match[1]))
            .map(text => text.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        if (terms.length) formulas.push(terms.join(' '));
    }
    return formulas;
}

function normalizeZipEntryName(name: string): string {
    return String(name || '').replace(/\\/g, '/');
}

function isRelevantOfficeXmlEntry(entryName: string): boolean {
    const normalized = normalizeZipEntryName(entryName);
    if (!/\.xml$/i.test(normalized)) return false;
    if (/^\[content_types\]\.xml$/i.test(normalized)) return false;
    if (/^(?:_rels|docprops)\//i.test(normalized)) return false;
    if (/\/_rels\//i.test(normalized)) return false;
    return true;
}

function isOfficeMediaEntry(entryName: string): boolean {
    const normalized = normalizeZipEntryName(entryName);
    const ext = path.extname(normalized).toLowerCase();
    if (!OFFICE_IMAGE_EXTENSIONS.has(ext)) return false;
    return /(?:^|\/)(?:media|pictures)\//i.test(normalized);
}

function buildExtractedMediaPath(sourcePath: string, entryName: string, preferredOutput?: string): string {
    const dir = chooseRelatedOutputDir(sourcePath, preferredOutput);
    const mediaDir = ensureDir(path.join(dir, `${sanitizeBasename(path.basename(sourcePath, path.extname(sourcePath)))}-media`));
    const ext = path.extname(entryName).toLowerCase() || '.bin';
    const base = sanitizeBasename(path.basename(entryName, ext));
    return path.join(mediaDir, `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
}

async function readSelectedZipEntries(
    archivePath: string,
    shouldRead: (entryName: string) => boolean,
    onEntry: (entryName: string, data: Buffer) => void | Promise<void>,
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        yauzl.open(archivePath, { lazyEntries: true }, (openError: Error | null, zipfile: any) => {
            if (openError || !zipfile) {
                reject(openError || new Error(`Failed to open archive: ${archivePath}`));
                return;
            }

            let finished = false;
            let totalBytes = 0;
            const fail = (error: Error): void => {
                if (finished) return;
                finished = true;
                try { zipfile.close(); } catch {}
                reject(error);
            };
            const next = (): void => {
                if (finished) return;
                try {
                    zipfile.readEntry();
                } catch (error: any) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            };

            zipfile.on('error', (error: Error) => fail(error));
            zipfile.on('end', () => {
                if (finished) return;
                finished = true;
                resolve();
            });
            zipfile.on('entry', (entry: any) => {
                const entryName = normalizeZipEntryName(entry.fileName || '');
                if (!entryName || /\/$/.test(entryName) || !shouldRead(entryName)) {
                    next();
                    return;
                }
                const entryBytes = Number(entry.uncompressedSize || 0);
                totalBytes += entryBytes;
                if (entryBytes > MAX_ARCHIVE_ENTRY_BYTES) {
                    fail(new Error(`Archive entry is too large to inspect safely: ${entryName}`));
                    return;
                }
                if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
                    fail(new Error(`Archive is too large to inspect safely: ${archivePath}`));
                    return;
                }
                zipfile.openReadStream(entry, (streamError: Error | null, stream: any) => {
                    if (streamError || !stream) {
                        fail(streamError || new Error(`Failed to read archive entry: ${entryName}`));
                        return;
                    }
                    const chunks: Buffer[] = [];
                    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                    stream.on('error', (error: Error) => fail(error));
                    stream.on('end', () => {
                        Promise.resolve(onEntry(entryName, Buffer.concat(chunks)))
                            .then(() => next())
                            .catch((error: any) => fail(error instanceof Error ? error : new Error(String(error))));
                    });
                });
            });

            next();
        });
    });
}

async function inspectOfficeArchive(sourcePath: string, preferredOutput?: string): Promise<OfficeArchiveInspection> {
    const kind = detectOfficeDocumentKind(sourcePath);
    if (!supportsArchiveInspection(kind)) {
        throw new Error(`Archive inspection is only supported for OOXML/OpenDocument files, not ${kind}.`);
    }

    const textParts: string[] = [];
    const formulas: string[] = [];
    const mediaPaths: string[] = [];
    const mediaEntryNames: string[] = [];

    await readSelectedZipEntries(
        sourcePath,
        (entryName) => isRelevantOfficeXmlEntry(entryName) || isOfficeMediaEntry(entryName),
        async (entryName, data) => {
            if (isRelevantOfficeXmlEntry(entryName)) {
                const xml = data.toString('utf-8');
                const text = extractVisibleTextFromOfficeXml(xml);
                if (text) textParts.push(text);
                for (const formula of extractFormulaTextFromOfficeXml(xml)) {
                    if (formula) formulas.push(formula);
                }
                return;
            }

            if (isOfficeMediaEntry(entryName)) {
                const target = buildExtractedMediaPath(sourcePath, entryName, preferredOutput);
                fs.writeFileSync(target, data);
                mediaPaths.push(target);
                mediaEntryNames.push(entryName);
            }
        },
    );

    const uniqueText = Array.from(new Set(textParts.map(part => part.trim()).filter(Boolean))).join('\n\n').trim();
    const uniqueFormulas = Array.from(new Set(formulas.map(item => item.trim()).filter(Boolean)));
    return {
        kind,
        text: uniqueText,
        formulas: uniqueFormulas,
        mediaPaths,
        mediaEntryNames,
    };
}

function looksLikeMarkupDocument(entryName: string): boolean {
    return /\.(?:xhtml|html|htm|xml|opf|ncx)$/i.test(entryName);
}

function isEpubMediaEntry(entryName: string): boolean {
    const ext = path.extname(entryName).toLowerCase();
    return OFFICE_IMAGE_EXTENSIONS.has(ext) && /(?:^|\/)(?:images?|media|illustrations?)\//i.test(entryName);
}

function extractVisibleTextFromMarkup(markup: string): string {
    return decodeXmlEntities(String(markup || ''))
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\b[^>]*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|section|article|h1|h2|h3|h4|h5|h6|li|tr|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+\n/g, '\n')
        .trim();
}

async function listArchiveEntries(sourcePath: string): Promise<ArchiveEntryInfo[]> {
    const entries: ArchiveEntryInfo[] = [];
    await new Promise<void>((resolve, reject) => {
        yauzl.open(sourcePath, { lazyEntries: true }, (openError: Error | null, zipfile: any) => {
            if (openError || !zipfile) {
                reject(openError || new Error(`Failed to open archive: ${sourcePath}`));
                return;
            }
            let finished = false;
            const fail = (error: Error): void => {
                if (finished) return;
                finished = true;
                try { zipfile.close(); } catch {}
                reject(error);
            };
            const next = (): void => {
                if (finished) return;
                try {
                    zipfile.readEntry();
                } catch (error: any) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            };
            zipfile.on('error', (error: Error) => fail(error));
            zipfile.on('end', () => {
                if (finished) return;
                finished = true;
                resolve();
            });
            zipfile.on('entry', (entry: any) => {
                const name = normalizeZipEntryName(entry.fileName || '');
                if (name && !/\/$/.test(name)) {
                    entries.push({
                        name,
                        size: Number(entry.uncompressedSize || 0),
                        compressedSize: Number(entry.compressedSize || 0),
                    });
                }
                next();
            });
            next();
        });
    });
    return entries;
}

function summarizeArchiveEntries(sourcePath: string, kind: ZipCapableDocumentKind, entries: ArchiveEntryInfo[], limit = 120): string {
    const listed = entries
        .slice(0, limit)
        .map(entry => `- ${entry.name} (${entry.size} bytes${entry.compressedSize ? `, compressed ${entry.compressedSize}` : ''})`)
        .join('\n');
    const suffix = entries.length > limit ? `\n... ${entries.length - limit} more entries` : '';
    return [
        'Archive preview',
        `Source: ${sourcePath}`,
        `Kind: ${kind}`,
        `Entries: ${entries.length}`,
        listed || '- (empty)',
    ].join('\n') + suffix;
}

async function inspectEpub(sourcePath: string, preferredOutput?: string): Promise<EpubInspection> {
    const textParts: string[] = [];
    const mediaPaths: string[] = [];
    const mediaEntryNames: string[] = [];
    let chapterCount = 0;

    await readSelectedZipEntries(
        sourcePath,
        (entryName) => looksLikeMarkupDocument(entryName) || isEpubMediaEntry(entryName),
        async (entryName, data) => {
            if (looksLikeMarkupDocument(entryName)) {
                const text = extractVisibleTextFromMarkup(data.toString('utf-8'));
                if (text) {
                    textParts.push(text);
                    if (/\.(?:xhtml|html|htm)$/i.test(entryName)) chapterCount++;
                }
                return;
            }
            if (isEpubMediaEntry(entryName)) {
                const target = buildExtractedMediaPath(sourcePath, entryName, preferredOutput);
                fs.writeFileSync(target, data);
                mediaPaths.push(target);
                mediaEntryNames.push(entryName);
            }
        },
    );

    return {
        text: Array.from(new Set(textParts.map(part => part.trim()).filter(Boolean))).join('\n\n').trim(),
        mediaPaths,
        mediaEntryNames,
        chapterCount,
    };
}

function summarizeEpubInspection(sourcePath: string, inspection: EpubInspection): string {
    const textPreview = inspection.text
        ? inspection.text.slice(0, 3000) + (inspection.text.length > 3000 ? '\n...[truncated]' : '')
        : '(none)';
    const media = inspection.mediaPaths.length
        ? inspection.mediaPaths.map((filePath, index) => `- ${inspection.mediaEntryNames[index] || path.basename(filePath)} -> ${filePath}`).join('\n')
        : '- (none)';
    return [
        'EPUB inspection',
        `Source: ${sourcePath}`,
        `Chapters with extracted text: ${inspection.chapterCount}`,
        'Extracted text preview:',
        textPreview,
        'Extracted images:',
        media,
    ].join('\n');
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === delimiter && !inQuotes) {
            cells.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    cells.push(current);
    return cells.map(cell => cell.trim());
}

function guessDelimiter(sample: string): string {
    const line = sample.split(/\r?\n/).find(part => part.trim()) || '';
    const scores = [
        { delimiter: ',', count: (line.match(/,/g) || []).length },
        { delimiter: '\t', count: (line.match(/\t/g) || []).length },
        { delimiter: ';', count: (line.match(/;/g) || []).length },
        { delimiter: '|', count: (line.match(/\|/g) || []).length },
    ].sort((a, b) => b.count - a.count);
    return scores[0]?.count ? scores[0].delimiter : ',';
}

function previewDelimitedTable(sourcePath: string, maxRows = 20): TabularPreview {
    const raw = fs.readFileSync(sourcePath, 'utf-8').replace(/^\uFEFF/, '');
    const delimiter = guessDelimiter(raw);
    const lines = raw.split(/\r?\n/).filter(line => line.trim());
    const rows = lines.map(line => splitDelimitedLine(line, delimiter));
    const headers = rows[0] || [];
    const previewRows = rows.slice(1, 1 + Math.max(1, maxRows));
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    return {
        kind: delimiter === '\t' ? 'tsv' : 'csv',
        delimiter,
        rowCount: Math.max(0, rows.length - 1),
        columnCount,
        headers,
        rows: previewRows,
    };
}

function excelColumnNameToIndex(name: string): number {
    let result = 0;
    for (const ch of name.toUpperCase()) {
        if (ch < 'A' || ch > 'Z') continue;
        result = result * 26 + (ch.charCodeAt(0) - 64);
    }
    return Math.max(0, result - 1);
}

async function previewXlsxTable(sourcePath: string, maxRows = 20): Promise<TabularPreview> {
    const sharedStrings: string[] = [];
    const sheets = new Map<string, string>();
    const sheetNames: string[] = [];

    await readSelectedZipEntries(
        sourcePath,
        (entryName) => /xl\/sharedStrings\.xml$/i.test(entryName) || /xl\/workbook\.xml$/i.test(entryName) || /xl\/worksheets\/sheet\d+\.xml$/i.test(entryName),
        async (entryName, data) => {
            const xml = data.toString('utf-8');
            if (/xl\/sharedStrings\.xml$/i.test(entryName)) {
                const matches = Array.from(xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gi));
                for (const match of matches) {
                    sharedStrings.push(decodeXmlEntities(match[1]).replace(/\s+/g, ' ').trim());
                }
                return;
            }
            if (/xl\/workbook\.xml$/i.test(entryName)) {
                const matches = Array.from(xml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*sheetId="(\d+)"/gi));
                for (const match of matches) {
                    sheetNames[Number(match[2]) - 1] = decodeXmlEntities(match[1]);
                }
                return;
            }
            if (/xl\/worksheets\/sheet\d+\.xml$/i.test(entryName)) {
                sheets.set(entryName, xml);
            }
        },
    );

    const parsedSheets = Array.from(sheets.entries())
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([entryName, xml], index) => {
            const rows: string[][] = [];
            const rowBlocks = xml.match(/<row\b[\s\S]*?<\/row>/gi) || [];
            for (const rowBlock of rowBlocks.slice(0, maxRows + 1)) {
                const row: string[] = [];
                const cellMatches = Array.from(rowBlock.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi));
                for (const cell of cellMatches) {
                    const attrs = cell[1] || '';
                    const body = cell[2] || '';
                    const refMatch = attrs.match(/\br="([A-Z]+)\d+"/i);
                    const typeMatch = attrs.match(/\bt="([^"]+)"/i);
                    const rawValue = body.match(/<v>([\s\S]*?)<\/v>/i)?.[1] || body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/i)?.[1] || '';
                    const value = decodeXmlEntities(rawValue).trim();
                    let resolved = value;
                    if ((typeMatch?.[1] || '').toLowerCase() === 's') {
                        resolved = sharedStrings[Number(value) || 0] || '';
                    }
                    const colIndex = refMatch ? excelColumnNameToIndex(refMatch[1]) : row.length;
                    while (row.length < colIndex) row.push('');
                    row[colIndex] = resolved;
                }
                rows.push(row);
            }
            const effectiveRows = rows.filter(row => row.some(cell => cell && cell.trim()));
            const columnCount = effectiveRows.reduce((max, row) => Math.max(max, row.length), 0);
            return {
                name: sheetNames[index] || path.basename(entryName, '.xml'),
                rowCount: Math.max(0, effectiveRows.length - 1),
                columnCount,
                rows: effectiveRows,
            };
        });

    const firstSheet = parsedSheets[0] || { name: 'sheet1', rowCount: 0, columnCount: 0, rows: [] as string[][] };
    return {
        kind: 'xlsx',
        rowCount: firstSheet.rowCount,
        columnCount: firstSheet.columnCount,
        headers: firstSheet.rows[0] || [],
        rows: firstSheet.rows.slice(1),
        sheets: parsedSheets.map(sheet => ({
            name: sheet.name,
            rowCount: sheet.rowCount,
            columnCount: sheet.columnCount,
            rows: sheet.rows.slice(0, maxRows + 1),
        })),
    };
}

function summarizeTabularPreview(sourcePath: string, preview: TabularPreview): string {
    const headerLine = preview.headers.length ? preview.headers.join(' | ') : '(no headers)';
    const rowLines = preview.rows.slice(0, 20).map(row => `- ${row.join(' | ')}`);
    const sheetSummary = preview.sheets?.length
        ? `\nSheets:\n${preview.sheets.map(sheet => `- ${sheet.name}: ${sheet.rowCount} rows, ${sheet.columnCount} columns`).join('\n')}`
        : '';
    return [
        'Tabular preview',
        `Source: ${sourcePath}`,
        `Kind: ${preview.kind}${preview.delimiter ? ` (${JSON.stringify(preview.delimiter)})` : ''}`,
        `Rows: ${preview.rowCount}`,
        `Columns: ${preview.columnCount}`,
        `Headers: ${headerLine}`,
        'Sample rows:',
        rowLines.join('\n') || '- (none)',
    ].join('\n') + sheetSummary;
}

function normalizeMathExpr(expr: string): string {
    return String(expr || '')
        .replace(/\r/g, ' ')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\\cdot/g, '*')
        .replace(/\\times/g, '*')
        .replace(/\\div/g, '/')
        .replace(/\\left/g, '')
        .replace(/\\right/g, '')
        .replace(/\\,/g, '')
        .replace(/\^/g, '**')
        .trim();
}

function normalizeMathExplain(text: string): string {
    return String(text || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .trim();
}

function findPythonMathBackend(): MathBackend | null {
    if (hasCommand('python', ['--version'], /Python/i)) {
        return { command: 'python', scriptFlag: '-c' };
    }
    if (hasCommand('py', ['-3', '--version'], /Python/i)) {
        return { command: 'py', scriptFlag: '-3 -c' };
    }
    return null;
}

function runPythonMathScript(script: string): string {
    const backend = findPythonMathBackend();
    if (!backend) {
        throw new Error('Python is not available. Install Python with SymPy to enable math tools.');
    }
    const args = backend.command === 'py'
        ? ['-3', '-c', script]
        : ['-c', script];
    const result = spawnSync(backend.command, args, {
        encoding: 'utf8',
        shell: true,
    });
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    if (result.status !== 0) {
        if (/No module named ['"]sympy['"]|ModuleNotFoundError:.*sympy/i.test(stderr)) {
            throw new Error('SymPy is not installed for the available Python runtime. Install `sympy` to enable math tools.');
        }
        throw new Error(stderr || stdout || `Python math script failed with exit code ${result.status}`);
    }
    return stdout;
}

function buildSympyJsonScript(payload: Record<string, any>): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    return [
        'import base64, json, sys',
        'from sympy import *',
        'from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication_application, convert_xor',
        'payload = json.loads(base64.b64decode("' + encoded + '").decode("utf-8"))',
        'transformations = standard_transformations + (implicit_multiplication_application, convert_xor)',
        'locals_map = {',
        '  "Matrix": Matrix, "Symbol": Symbol, "symbols": symbols, "Eq": Eq, "pi": pi, "E": E, "I": I, "oo": oo,',
        '  "sin": sin, "cos": cos, "tan": tan, "asin": asin, "acos": acos, "atan": atan, "sinh": sinh, "cosh": cosh, "tanh": tanh,',
        '  "exp": exp, "log": log, "ln": log, "sqrt": sqrt, "Abs": Abs, "Integral": Integral, "Derivative": Derivative,',
        '  "summation": summation, "Sum": Sum, "factorial": factorial, "gamma": gamma, "diff": diff, "integrate": integrate,',
        '  "limit": limit, "simplify": simplify, "factor": factor, "expand": expand, "det": det, "trace": trace, "transpose": transpose',
        '}',
        'def parse_math(text):',
        '    return parse_expr(text, transformations=transformations, local_dict=locals_map, evaluate=False)',
        'def parse_equation(text):',
        '    if "=" in text:',
        '        left, right = text.split("=", 1)',
        '        return Eq(parse_math(left.strip()), parse_math(right.strip()))',
        '    return parse_math(text)',
        'op = payload.get("op")',
        'result = {}',
        'if op == "simplify":',
        '    expr = parse_math(payload["expr"])',
        '    simplified = simplify(expr)',
        '    result = {"input": str(expr), "result": str(simplified), "latex": latex(simplified)}',
        'elif op == "solve":',
        '    target = parse_equation(payload["expr"])',
        '    symbol_names = payload.get("symbols") or []',
        '    sym_list = [Symbol(name) for name in symbol_names] if symbol_names else sorted(list(target.free_symbols), key=lambda s: s.name)',
        '    solved = solve(target, *sym_list, dict=True) if sym_list else solve(target, dict=True)',
        '    result = {',
        '      "equation": str(target),',
        '      "symbols": [str(s) for s in sym_list],',
        '      "solutions": [{str(k): str(v) for k, v in item.items()} for item in solved] if isinstance(solved, list) else str(solved)',
        '    }',
        'elif op == "matrix":',
        '    matrix_data = payload.get("matrix") or []',
        '    mat = Matrix(matrix_data)',
        '    action = payload.get("action") or "summary"',
        '    result = {"shape": [mat.rows, mat.cols], "matrix": str(mat)}',
        '    if action == "determinant": result["determinant"] = str(mat.det())',
        '    elif action == "inverse": result["inverse"] = str(mat.inv())',
        '    elif action == "rank": result["rank"] = int(mat.rank())',
        '    elif action == "eigenvalues": result["eigenvalues"] = {str(k): int(v) for k, v in mat.eigenvals().items()}',
        '    else:',
        '        result["determinant"] = str(mat.det()) if mat.rows == mat.cols else None',
        '        result["rank"] = int(mat.rank())',
        'elif op == "check_steps":',
        '    steps = payload.get("steps") or []',
        '    parsed = [parse_math(step) for step in steps]',
        '    comparisons = []',
        '    all_equivalent = True',
        '    for idx in range(len(parsed) - 1):',
        '        diff_expr = simplify(parsed[idx] - parsed[idx + 1])',
        '        ok = bool(diff_expr == 0)',
        '        all_equivalent = all_equivalent and ok',
        '        comparisons.append({"from": steps[idx], "to": steps[idx + 1], "equivalent": ok, "difference": str(diff_expr)})',
        '    result = {"all_equivalent": all_equivalent, "comparisons": comparisons}',
        'else:',
        '    raise ValueError("Unsupported math op: %s" % op)',
        'print(json.dumps(result, ensure_ascii=False))',
    ].join('\n');
}

function runSympyJson(payload: Record<string, any>): any {
    const output = runPythonMathScript(buildSympyJsonScript(payload));
    try {
        return JSON.parse(output);
    } catch {
        throw new Error(`Failed to parse SymPy output: ${output.slice(0, 1000)}`);
    }
}

async function sympySimplify(args: Record<string, any>): Promise<string> {
    const expr = normalizeMathExpr(String(args.expression || args.expr || '').trim());
    if (!expr) throw new Error('expression is required');
    const result = runSympyJson({ op: 'simplify', expr });
    return [
        'SymPy simplify',
        `Input: ${result.input || expr}`,
        `Result: ${result.result || ''}`,
        `LaTeX: ${result.latex || ''}`,
    ].join('\n');
}

async function sympySolve(args: Record<string, any>): Promise<string> {
    const expr = normalizeMathExpr(String(args.equation || args.expression || args.expr || '').trim());
    if (!expr) throw new Error('equation is required');
    const symbolsInput = String(args.symbols || '').trim();
    const symbols = symbolsInput ? symbolsInput.split(/[,\s]+/).map(item => item.trim()).filter(Boolean) : [];
    const result = runSympyJson({ op: 'solve', expr, symbols });
    const solutions = Array.isArray(result.solutions)
        ? result.solutions.map((item: Record<string, string>, index: number) => `- Solution ${index + 1}: ${Object.entries(item).map(([k, v]) => `${k} = ${v}`).join(', ') || '(empty)'}`).join('\n')
        : String(result.solutions || '(none)');
    return [
        'SymPy solve',
        `Equation: ${result.equation || expr}`,
        `Symbols: ${(result.symbols || symbols).join(', ') || '(auto)'}`,
        'Solutions:',
        solutions || '- (none)',
    ].join('\n');
}

async function matrixCalculator(args: Record<string, any>): Promise<string> {
    const matrix = args.matrix;
    if (!Array.isArray(matrix) || matrix.length === 0) throw new Error('matrix must be a non-empty 2D array');
    const action = String(args.action || 'summary').trim() || 'summary';
    const result = runSympyJson({ op: 'matrix', matrix, action });
    const lines = [
        'Matrix calculator',
        `Shape: ${(result.shape || []).join(' x ')}`,
        `Matrix: ${result.matrix || ''}`,
    ];
    if (result.determinant !== undefined) lines.push(`Determinant: ${result.determinant}`);
    if (result.rank !== undefined) lines.push(`Rank: ${result.rank}`);
    if (result.inverse !== undefined) lines.push(`Inverse: ${result.inverse}`);
    if (result.eigenvalues !== undefined) lines.push(`Eigenvalues: ${JSON.stringify(result.eigenvalues)}`);
    return lines.join('\n');
}

async function equationDerivationChecker(args: Record<string, any>): Promise<string> {
    const rawSteps = Array.isArray(args.steps)
        ? args.steps
        : String(args.steps || '')
            .split(/\r?\n+/)
            .map(line => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
            .filter(Boolean);
    const steps = rawSteps.map(item => normalizeMathExpr(String(item))).filter(Boolean);
    if (steps.length < 2) throw new Error('Provide at least two derivation steps.');
    const result = runSympyJson({ op: 'check_steps', steps });
    const details = Array.isArray(result.comparisons)
        ? result.comparisons.map((item: any, index: number) => `${index + 1}. ${item.equivalent ? 'OK' : 'Mismatch'}: ${item.from} -> ${item.to}${item.equivalent ? '' : ` | difference: ${item.difference}`}`).join('\n')
        : '';
    return [
        'Equation derivation checker',
        `All equivalent: ${result.all_equivalent ? 'yes' : 'no'}`,
        'Comparisons:',
        details || '- (none)',
    ].join('\n');
}

async function mathReasoningMode(args: Record<string, any>): Promise<string> {
    const problem = normalizeMathExplain(String(args.problem || args.prompt || '').trim());
    if (!problem) throw new Error('problem is required');
    const strategy = String(args.strategy || 'strict-step-by-step').trim() || 'strict-step-by-step';
    return [
        'Math reasoning mode',
        `Strategy: ${strategy}`,
        'Use this structure:',
        '1. 已知 / Given',
        '2. 目标 / Goal',
        '3. 推导步骤 / Derivation steps',
        '4. 结果 / Result',
        '5. 自检 / Self-check',
        '',
        'Problem:',
        problem,
        '',
        'If symbolic transformation, equation solving, or matrix verification is needed, call the SymPy-based math MCP tools first instead of relying on unaided reasoning.',
    ].join('\n');
}

function summarizeOfficeInspection(sourcePath: string, inspection: OfficeArchiveInspection): string {
    const textPreview = inspection.text
        ? inspection.text.slice(0, 2500) + (inspection.text.length > 2500 ? '\n...[truncated]' : '')
        : '(none)';
    const formulas = inspection.formulas.length
        ? inspection.formulas.slice(0, 20).map(item => `- ${item}`).join('\n')
        : '- (none)';
    const media = inspection.mediaPaths.length
        ? inspection.mediaPaths.map((filePath, index) => `- ${inspection.mediaEntryNames[index] || path.basename(filePath)} -> ${filePath}`).join('\n')
        : '- (none)';

    return [
        `Office archive inspection`,
        `Source: ${sourcePath}`,
        `Kind: ${inspection.kind}`,
        `Extracted text preview:`,
        textPreview,
        `Formulas:`,
        formulas,
        `Extracted embedded images:`,
        media,
    ].join('\n');
}

function hasCommand(command: string, versionArgs: string[] = ['--version'], pattern?: RegExp): boolean {
    const result = spawnSync(command, versionArgs, { encoding: 'utf8', shell: true });
    if (result.status === 0) return true;
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return pattern ? pattern.test(output) : false;
}

function findOfficeConverter(): { command: string; argsFor: (sourcePath: string, outputDirPath: string) => string[] } | null {
    if (hasCommand('soffice', ['--version'], /LibreOffice|soffice/i)) {
        return {
            command: 'soffice',
            argsFor: (sourcePath, outputDirPath) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDirPath, sourcePath],
        };
    }
    if (hasCommand('libreoffice', ['--version'], /LibreOffice/i)) {
        return {
            command: 'libreoffice',
            argsFor: (sourcePath, outputDirPath) => ['--headless', '--convert-to', 'pdf', '--outdir', outputDirPath, sourcePath],
        };
    }
    return null;
}

function buildOfficePdfTarget(sourcePath: string, outputPathHint?: string): string {
    const preferred = String(outputPathHint || '').trim();
    if (preferred) {
        const resolved = resolveWorkspacePath(preferred);
        if (!looksLikeDirectoryTarget(resolved) && /\.pdf$/i.test(resolved)) {
            ensureDir(path.dirname(resolved));
            return resolved;
        }
    }
    return buildSmartOutputPath('office-preview', 'pdf', sourcePath, outputPathHint);
}

function convertOfficeViaSoffice(converter: { command: string; argsFor: (sourcePath: string, outputDirPath: string) => string[] }, sourcePath: string, targetPdfPath: string): string {
    const outDirPath = ensureDir(path.dirname(targetPdfPath));
    const expectedPdf = path.join(outDirPath, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
    const result = spawnSync(converter.command, converter.argsFor(sourcePath, outDirPath), {
        encoding: 'utf8',
        shell: true,
    });
    if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || '').trim() || `exit code ${result.status}`);
    }
    const actualPdf = fs.existsSync(expectedPdf) ? expectedPdf : targetPdfPath;
    if (!fs.existsSync(actualPdf)) {
        throw new Error(`Converter did not produce a PDF in ${outDirPath}`);
    }
    if (actualPdf !== targetPdfPath) {
        fs.copyFileSync(actualPdf, targetPdfPath);
    }
    return targetPdfPath;
}

function convertOfficeViaWindowsCom(kind: OfficeDocumentKind, sourcePath: string, targetPdfPath: string): string {
    if (process.platform !== 'win32') {
        throw new Error('Windows Office automation is only available on Windows.');
    }

    const scriptByKind: Record<string, string> = {
        doc: `
$word = New-Object -ComObject Word.Application
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($src, $false, $true)
  try {
    $doc.SaveAs([ref]$dst, [ref]17)
  } finally {
    $doc.Close()
  }
} finally {
  $word.Quit()
}
`,
        docx: `
$word = New-Object -ComObject Word.Application
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($src, $false, $true)
  try {
    $doc.SaveAs([ref]$dst, [ref]17)
  } finally {
    $doc.Close()
  }
} finally {
  $word.Quit()
}
`,
        ppt: `
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $presentation = $ppt.Presentations.Open($src, $true, $false, $false)
  try {
    $presentation.SaveAs($dst, 32)
  } finally {
    $presentation.Close()
  }
} finally {
  $ppt.Quit()
}
`,
        pptx: `
$ppt = New-Object -ComObject PowerPoint.Application
try {
  $presentation = $ppt.Presentations.Open($src, $true, $false, $false)
  try {
    $presentation.SaveAs($dst, 32)
  } finally {
    $presentation.Close()
  }
} finally {
  $ppt.Quit()
}
`,
        xls: `
$excel = New-Object -ComObject Excel.Application
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $book = $excel.Workbooks.Open($src, 3, $true)
  try {
    $book.ExportAsFixedFormat(0, $dst)
  } finally {
    $book.Close($false)
  }
} finally {
  $excel.Quit()
}
`,
        xlsx: `
$excel = New-Object -ComObject Excel.Application
try {
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $book = $excel.Workbooks.Open($src, 3, $true)
  try {
    $book.ExportAsFixedFormat(0, $dst)
  } finally {
    $book.Close($false)
  }
} finally {
  $excel.Quit()
}
`,
    };

    const script = scriptByKind[kind];
    if (!script) {
        throw new Error(`No Windows Office automation path for ${kind}.`);
    }
    ensureDir(path.dirname(targetPdfPath));
    const result = spawnSync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$src = $args[0]; $dst = $args[1]; ${script}`,
        sourcePath,
        targetPdfPath,
    ], {
        encoding: 'utf8',
        shell: true,
    });
    if (result.status !== 0 || !fs.existsSync(targetPdfPath)) {
        throw new Error((result.stderr || result.stdout || '').trim() || `exit code ${result.status}`);
    }
    return targetPdfPath;
}

function convertOfficeDocumentToPdf(sourcePath: string, outputPathHint?: string): string {
    const kind = detectOfficeDocumentKind(sourcePath);
    if (kind === 'pdf') return sourcePath;

    const targetPdfPath = buildOfficePdfTarget(sourcePath, outputPathHint);
    const failures: string[] = [];

    const converter = findOfficeConverter();
    if (converter) {
        try {
            return convertOfficeViaSoffice(converter, sourcePath, targetPdfPath);
        } catch (error: any) {
            failures.push(`LibreOffice/soffice: ${error?.message || String(error)}`);
        }
    } else {
        failures.push('LibreOffice/soffice: not installed');
    }

    if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(kind)) {
        try {
            return convertOfficeViaWindowsCom(kind, sourcePath, targetPdfPath);
        } catch (error: any) {
            failures.push(`Microsoft Office automation: ${error?.message || String(error)}`);
        }
    }

    throw new Error(`No office-to-PDF conversion path succeeded for ${sourcePath}. ${failures.join(' | ')}`);
}

function findPdfRasterizer(): { command: string; argsFor: (pdfPath: string, targetPrefix: string, page: number) => string[] } | null {
    if (hasCommand('pdftoppm', ['-h'], /pdftoppm/i)) {
        return {
            command: 'pdftoppm',
            argsFor: (pdfPath, targetPrefix, page) => ['-png', '-f', String(page), '-singlefile', pdfPath, targetPrefix],
        };
    }
    if (hasCommand('mutool', ['-h'], /mutool/i)) {
        return {
            command: 'mutool',
            argsFor: (pdfPath, targetPrefix, page) => ['draw', '-F', 'png', '-o', `${targetPrefix}.png`, pdfPath, String(page)],
        };
    }
    return null;
}

function renderPdfPageToImage(pdfPath: string, page: number, outputPathHint?: string): string {
    const rasterizer = findPdfRasterizer();
    if (!rasterizer) {
        throw new Error('No PDF rasterizer found. Install pdftoppm (Poppler) or mutool.');
    }
    const target = buildSmartOutputPath('pdf-page', 'png', pdfPath, outputPathHint);
    const prefix = target.replace(/\.png$/i, '');
    const result = spawnSync(rasterizer.command, rasterizer.argsFor(pdfPath, prefix, page), {
        encoding: 'utf8',
        shell: true,
    });
    if (result.status !== 0) {
        throw new Error(`PDF render failed: ${(result.stderr || result.stdout || '').trim() || `exit code ${result.status}`}`);
    }
    const finalPath = fs.existsSync(target) ? target : `${prefix}.png`;
    if (!fs.existsSync(finalPath)) {
        throw new Error(`PDF render did not produce an image: ${finalPath}`);
    }
    return finalPath;
}

async function renderPdfPages(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolvedPdf = resolveWorkspacePath(sourcePath);
    const page = Math.max(1, Number(args.page || 1));
    const count = Math.max(1, Math.min(8, Number(args.count || 1)));
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    const rendered: string[] = [];
    for (let i = 0; i < count; i++) {
        rendered.push(renderPdfPageToImage(resolvedPdf, page + i, outputPathHint));
    }
    return `Rendered PDF pages.\nPDF: ${resolvedPdf}\nPages: ${page}-${page + count - 1}\nImages:\n${rendered.map(p => `- ${p}`).join('\n')}`;
}

async function analyzePdf(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolvedPdf = resolveWorkspacePath(sourcePath);
    const page = Math.max(1, Number(args.page || 1));
    const count = Math.max(1, Math.min(4, Number(args.count || 1)));
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    const promptBase = String(args.prompt || 'Analyze this PDF page faithfully. Extract visible text, formulas, figures, tables, headings, and layout clues.');
    const analyses: string[] = [];
    for (let i = 0; i < count; i++) {
        const pageNo = page + i;
        const imagePath = renderPdfPageToImage(resolvedPdf, pageNo, outputPathHint);
        const text = await analyzeMedia('image', {
            ...args,
            file_path: imagePath,
            prompt: `${promptBase}\nPDF: ${path.basename(resolvedPdf)}\nPage: ${pageNo}`,
        });
        analyses.push(`Page ${pageNo}\nImage: ${imagePath}\n${text}`.trim());
    }
    return analyses.join('\n\n');
}

async function inspectOfficeArchiveTool(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    return summarizeOfficeInspection(resolved, await inspectOfficeArchive(resolved, outputPathHint));
}

async function renderOfficePages(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    const page = Math.max(1, Number(args.page || 1));
    const count = Math.max(1, Math.min(8, Number(args.count || 1)));
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    const pdfPath = convertOfficeDocumentToPdf(resolved, outputPathHint);
    const rendered: string[] = [];
    for (let i = 0; i < count; i++) {
        rendered.push(renderPdfPageToImage(pdfPath, page + i, outputPathHint));
    }
    return `Rendered office document pages.\nSource: ${resolved}\nPDF preview: ${pdfPath}\nPages: ${page}-${page + count - 1}\nImages:\n${rendered.map(p => `- ${p}`).join('\n')}`;
}

async function analyzeOfficeDocument(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    const kind = detectOfficeDocumentKind(resolved);
    const page = Math.max(1, Number(args.page || 1));
    const count = Math.max(1, Math.min(4, Number(args.count || 1)));
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    const promptBase = String(args.prompt || 'Analyze this document faithfully. Extract visible text, formulas, figures, tables, headings, layout clues, and any important embedded images.');
    const sections: string[] = [];

    if (kind === 'pdf') {
        return analyzePdf(args);
    }

    try {
        const pdfPath = convertOfficeDocumentToPdf(resolved, outputPathHint);
        const pdfAnalysis = await analyzePdf({
            ...args,
            file_path: pdfPath,
            page,
            count,
            output_path: outputPathHint,
            prompt: `${promptBase}\nOriginal office source: ${path.basename(resolved)}`,
        });
        sections.push(`PDF-based page analysis\nSource: ${resolved}\nPreview PDF: ${pdfPath}\n${pdfAnalysis}`.trim());
    } catch (error: any) {
        sections.push(`PDF-based page analysis unavailable\nSource: ${resolved}\nReason: ${error?.message || String(error)}`);
    }

    if (supportsArchiveInspection(kind)) {
        const inspection = await inspectOfficeArchive(resolved, outputPathHint);
        sections.push(summarizeOfficeInspection(resolved, inspection));

        if (inspection.mediaPaths.length > 0) {
            const mediaAnalyses: string[] = [];
            const mediaLimit = Math.min(inspection.mediaPaths.length, 6);
            for (let i = 0; i < mediaLimit; i++) {
                const imagePath = inspection.mediaPaths[i];
                const imageText = await analyzeMedia('image', {
                    ...args,
                    file_path: imagePath,
                    prompt: `${promptBase}\nEmbedded document image ${i + 1}/${mediaLimit} from ${path.basename(resolved)}.`,
                });
                mediaAnalyses.push(`Embedded image ${i + 1}\nPath: ${imagePath}\n${imageText}`.trim());
            }
            sections.push(`Embedded image analysis\n${mediaAnalyses.join('\n\n')}`.trim());
        }
    }

    return sections.join('\n\n');
}

async function previewArchiveTool(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    const kind = detectZipCapableDocumentKind(resolved);
    if (!supportsZipArchiveInspection(kind)) {
        throw new Error(`Archive preview supports zip-like formats only. Got: ${path.extname(resolved) || '(no extension)'}`);
    }
    const entries = await listArchiveEntries(resolved);
    return summarizeArchiveEntries(resolved, kind, entries, Math.max(20, Math.min(300, Number(args.limit || 120))));
}

async function inspectEpubTool(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    if (detectZipCapableDocumentKind(resolved) !== 'epub') {
        throw new Error('inspect_epub expects an .epub file.');
    }
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    return summarizeEpubInspection(resolved, await inspectEpub(resolved, outputPathHint));
}

async function analyzeEpub(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    if (detectZipCapableDocumentKind(resolved) !== 'epub') {
        throw new Error('analyze_epub expects an .epub file.');
    }
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    const promptBase = String(args.prompt || 'Analyze this EPUB faithfully. Summarize chapters, headings, figures, equations, and any important embedded illustrations.');
    const inspection = await inspectEpub(resolved, outputPathHint);
    const sections = [summarizeEpubInspection(resolved, inspection)];
    if (inspection.mediaPaths.length > 0) {
        const mediaAnalyses: string[] = [];
        const mediaLimit = Math.min(inspection.mediaPaths.length, 6);
        for (let i = 0; i < mediaLimit; i++) {
            const imagePath = inspection.mediaPaths[i];
            const imageText = await analyzeMedia('image', {
                ...args,
                file_path: imagePath,
                prompt: `${promptBase}\nEmbedded EPUB illustration ${i + 1}/${mediaLimit} from ${path.basename(resolved)}.`,
            });
            mediaAnalyses.push(`Embedded image ${i + 1}\nPath: ${imagePath}\n${imageText}`.trim());
        }
        sections.push(`Embedded image analysis\n${mediaAnalyses.join('\n\n')}`.trim());
    }
    return sections.join('\n\n');
}

async function previewTabularDataTool(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    const ext = path.extname(resolved).toLowerCase();
    const maxRows = Math.max(1, Math.min(50, Number(args.max_rows || 20)));
    let preview: TabularPreview;
    if (ext === '.xlsx') {
        preview = await previewXlsxTable(resolved, maxRows);
    } else if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
        preview = previewDelimitedTable(resolved, maxRows);
    } else {
        throw new Error(`Unsupported tabular file type: ${ext || '(no extension)'}`);
    }
    return summarizeTabularPreview(resolved, preview);
}

async function extractDocumentImagesTool(args: Record<string, any>): Promise<string> {
    const sourcePath = String(args.file_path || '').trim();
    if (!sourcePath) throw new Error('file_path is required');
    const resolved = resolveWorkspacePath(sourcePath);
    const kind = detectZipCapableDocumentKind(resolved);
    const outputPathHint = String(args.output_path || args.output_dir || '').trim();
    if (supportsArchiveInspection(detectOfficeDocumentKind(resolved))) {
        const inspection = await inspectOfficeArchive(resolved, outputPathHint);
        return [
            'Extracted document images',
            `Source: ${resolved}`,
            `Kind: ${inspection.kind}`,
            `Images: ${inspection.mediaPaths.length}`,
            ...inspection.mediaPaths.map((filePath, index) => `- ${inspection.mediaEntryNames[index] || path.basename(filePath)} -> ${filePath}`),
        ].join('\n');
    }
    if (kind === 'epub') {
        const inspection = await inspectEpub(resolved, outputPathHint);
        return [
            'Extracted document images',
            `Source: ${resolved}`,
            'Kind: epub',
            `Images: ${inspection.mediaPaths.length}`,
            ...inspection.mediaPaths.map((filePath, index) => `- ${inspection.mediaEntryNames[index] || path.basename(filePath)} -> ${filePath}`),
        ].join('\n');
    }
    throw new Error('extract_document_images currently supports office archives and EPUB files.');
}

const commonMediaProperties = {
    file_path: { type: 'string', description: 'Local media file path. Relative paths resolve against the workspace.' },
    url: { type: 'string', description: 'HTTP(S) media URL.' },
    data_url: { type: 'string', description: 'data: URL or provider-accepted base64 payload.' },
    prompt: { type: 'string', description: 'Question or analysis instruction.' },
    model: { type: 'string', description: 'Override model, e.g. mimo-v2.5 or mimo-v2-omni.' },
    max_tokens: { type: 'number', description: 'Maximum output tokens.' },
};

const tools: ToolSpec[] = [
    {
        name: 'analyze_image',
        description: 'Use MiMo multimodal/Omni model to inspect an image or screenshot and return text for the main agent.',
        inputSchema: { type: 'object', properties: commonMediaProperties },
        handler: (args) => analyzeMedia('image', args),
    },
    {
        name: 'analyze_audio',
        description: 'Use MiMo multimodal/Omni model to understand audio, including speech and non-speech content.',
        inputSchema: { type: 'object', properties: commonMediaProperties },
        handler: (args) => analyzeMedia('audio', args),
    },
    {
        name: 'analyze_video',
        description: 'Use MiMo multimodal/Omni model to understand a video and return a text summary.',
        inputSchema: { type: 'object', properties: commonMediaProperties },
        handler: (args) => analyzeMedia('video', args),
    },
    {
        name: 'transcribe_audio',
        description: 'Transcribe speech audio with MiMo ASR when available, falling back to the multimodal model.',
        inputSchema: { type: 'object', properties: commonMediaProperties },
        handler: transcribeAudio,
    },
    {
        name: 'synthesize_speech',
        description: 'Generate speech audio with MiMo TTS and save it to a local output file.',
        inputSchema: {
            type: 'object',
            required: ['text'],
            properties: {
                text: { type: 'string', description: 'Text to synthesize.' },
                style: { type: 'string', description: 'Voice/style instruction.' },
                voice: { type: 'string', description: 'Voice name, e.g. Chloe.' },
                format: { type: 'string', enum: ['wav', 'mp3', 'pcm16'], description: 'Output audio format.' },
                output_path: { type: 'string', description: 'Optional output path. Relative paths resolve against the workspace.' },
                model: { type: 'string', description: 'Override TTS model, e.g. mimo-v2.5-tts or mimo-v2-tts.' },
            },
        },
        handler: synthesizeSpeech,
    },
    {
        name: 'render_pdf_pages',
        description: 'Render one or more PDF pages into PNG images saved near the source PDF or a chosen output directory.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local PDF path. Relative paths resolve against the workspace.' },
                page: { type: 'number', description: '1-based page number to start from.' },
                count: { type: 'number', description: 'How many pages to render, up to 8.' },
                output_path: { type: 'string', description: 'Optional output file or directory path.' },
                output_dir: { type: 'string', description: 'Optional output directory path.' },
            },
        },
        handler: renderPdfPages,
    },
    {
        name: 'analyze_pdf',
        description: 'Render PDF pages to images, then inspect them with the MiMo multimodal model for text, formulas, tables, and layout.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local PDF path. Relative paths resolve against the workspace.' },
                page: { type: 'number', description: '1-based page number to start from.' },
                count: { type: 'number', description: 'How many pages to analyze, up to 4.' },
                prompt: { type: 'string', description: 'Optional analysis instruction.' },
                output_path: { type: 'string', description: 'Optional output file or directory path used for rendered page images.' },
                output_dir: { type: 'string', description: 'Optional output directory path used for rendered page images.' },
                model: { type: 'string', description: 'Override multimodal model, e.g. mimo-v2.5.' },
                max_tokens: { type: 'number', description: 'Maximum output tokens for each analyzed page.' },
            },
        },
        handler: analyzePdf,
    },
    {
        name: 'inspect_office_archive',
        description: 'Inspect a DOCX/PPTX/XLSX/ODT/ODP/ODS archive directly, extracting text, formulas, and embedded images without rendering pages.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local office document path. Relative paths resolve against the workspace.' },
                output_path: { type: 'string', description: 'Optional output file or directory path used for extracted embedded images.' },
                output_dir: { type: 'string', description: 'Optional output directory path used for extracted embedded images.' },
            },
        },
        handler: inspectOfficeArchiveTool,
    },
    {
        name: 'render_office_pages',
        description: 'Convert an office document such as DOC/DOCX/PPT/PPTX/XLS/XLSX/RTF/ODT to PDF when possible, then render pages into PNG images near the source file.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local office document path. Relative paths resolve against the workspace.' },
                page: { type: 'number', description: '1-based page number to start from.' },
                count: { type: 'number', description: 'How many pages to render, up to 8.' },
                output_path: { type: 'string', description: 'Optional output file or directory path.' },
                output_dir: { type: 'string', description: 'Optional output directory path.' },
            },
        },
        handler: renderOfficePages,
    },
    {
        name: 'analyze_office_document',
        description: 'Analyze complex office documents such as DOCX/PPTX/XLSX by combining office-to-PDF page rendering with archive text/formula/image extraction.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local office document path. Relative paths resolve against the workspace.' },
                page: { type: 'number', description: '1-based page number to start from.' },
                count: { type: 'number', description: 'How many pages to analyze, up to 4.' },
                prompt: { type: 'string', description: 'Optional analysis instruction.' },
                output_path: { type: 'string', description: 'Optional output file or directory path used for rendered pages and extracted images.' },
                output_dir: { type: 'string', description: 'Optional output directory path used for rendered pages and extracted images.' },
                model: { type: 'string', description: 'Override multimodal model, e.g. mimo-v2.5.' },
                max_tokens: { type: 'number', description: 'Maximum output tokens for each analyzed page or image.' },
            },
        },
        handler: analyzeOfficeDocument,
    },
    {
        name: 'preview_archive',
        description: 'Preview entries inside zip-like archives such as ZIP, EPUB, DOCX, PPTX, XLSX, JAR, APK, or CBZ without extracting everything.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local archive path. Relative paths resolve against the workspace.' },
                limit: { type: 'number', description: 'Maximum number of entries to list, up to 300.' },
            },
        },
        handler: previewArchiveTool,
    },
    {
        name: 'inspect_epub',
        description: 'Inspect an EPUB by extracting chapter text and embedded images near the source file.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local EPUB path. Relative paths resolve against the workspace.' },
                output_path: { type: 'string', description: 'Optional output file or directory path used for extracted images.' },
                output_dir: { type: 'string', description: 'Optional output directory path used for extracted images.' },
            },
        },
        handler: inspectEpubTool,
    },
    {
        name: 'analyze_epub',
        description: 'Analyze an EPUB by extracting chapter text and then optionally inspecting embedded illustrations with the multimodal model.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local EPUB path. Relative paths resolve against the workspace.' },
                prompt: { type: 'string', description: 'Optional analysis instruction.' },
                output_path: { type: 'string', description: 'Optional output file or directory path used for extracted images.' },
                output_dir: { type: 'string', description: 'Optional output directory path used for extracted images.' },
                model: { type: 'string', description: 'Override multimodal model, e.g. mimo-v2.5.' },
                max_tokens: { type: 'number', description: 'Maximum output tokens for embedded image analysis.' },
            },
        },
        handler: analyzeEpub,
    },
    {
        name: 'preview_tabular_data',
        description: 'Preview CSV, TSV, TXT, or XLSX tabular data with headers, sample rows, and worksheet summaries.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local CSV/TSV/TXT/XLSX path. Relative paths resolve against the workspace.' },
                max_rows: { type: 'number', description: 'Maximum number of sample rows to return, up to 50.' },
            },
        },
        handler: previewTabularDataTool,
    },
    {
        name: 'extract_document_images',
        description: 'Extract embedded images from DOCX/PPTX/XLSX/ODT/ODP/ODS or EPUB files and save them near the source file.',
        inputSchema: {
            type: 'object',
            required: ['file_path'],
            properties: {
                file_path: { type: 'string', description: 'Local supported document path. Relative paths resolve against the workspace.' },
                output_path: { type: 'string', description: 'Optional output file or directory path used for extracted images.' },
                output_dir: { type: 'string', description: 'Optional output directory path used for extracted images.' },
            },
        },
        handler: extractDocumentImagesTool,
    },
    {
        name: 'sympy_simplify',
        description: 'Simplify a symbolic math expression with SymPy and return plain-text and LaTeX forms.',
        inputSchema: {
            type: 'object',
            required: ['expression'],
            properties: {
                expression: { type: 'string', description: 'Expression to simplify, e.g. (x^2 - 1)/(x - 1).' },
            },
        },
        handler: sympySimplify,
    },
    {
        name: 'sympy_solve',
        description: 'Solve an equation or symbolic system with SymPy.',
        inputSchema: {
            type: 'object',
            required: ['equation'],
            properties: {
                equation: { type: 'string', description: 'Equation to solve, e.g. x^2 - 5*x + 6 = 0.' },
                symbols: { type: 'string', description: 'Optional comma-separated symbol list to solve for, e.g. x,y.' },
            },
        },
        handler: sympySolve,
    },
    {
        name: 'matrix_calculator',
        description: 'Compute matrix summaries, determinant, inverse, rank, or eigenvalues with SymPy.',
        inputSchema: {
            type: 'object',
            required: ['matrix'],
            properties: {
                matrix: { type: 'array', description: '2D numeric/symbolic matrix array.' },
                action: { type: 'string', enum: ['summary', 'determinant', 'inverse', 'rank', 'eigenvalues'], description: 'Matrix operation to run.' },
            },
        },
        handler: matrixCalculator,
    },
    {
        name: 'equation_derivation_checker',
        description: 'Check whether each adjacent pair of derivation steps is symbolically equivalent using SymPy.',
        inputSchema: {
            type: 'object',
            required: ['steps'],
            properties: {
                steps: { type: ['array', 'string'], description: 'Array of equations/expressions or a newline-separated derivation.' },
            },
        },
        handler: equationDerivationChecker,
    },
    {
        name: 'math_reasoning_mode',
        description: 'Return a structured math-solving scaffold that encourages step-by-step derivation and explicit self-checking.',
        inputSchema: {
            type: 'object',
            required: ['problem'],
            properties: {
                problem: { type: 'string', description: 'Math problem statement.' },
                strategy: { type: 'string', description: 'Optional label for the desired reasoning strategy.' },
            },
        },
        handler: mathReasoningMode,
    },
];

function respond(id: JsonRpcMessage['id'], result: any): void {
    if (id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id: JsonRpcMessage['id'], code: number, message: string, data?: any): void {
    if (id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } }) + '\n');
}

async function handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (!msg.method) return;
    if (msg.method === 'initialize') {
        respond(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mimo-multimodal', version: '1.0.0' },
        });
        return;
    }
    if (msg.method === 'tools/list') {
        respond(msg.id, {
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
        return;
    }
    if (msg.method === 'tools/call') {
        const name = String(msg.params?.name || '');
        const tool = tools.find(t => t.name === name);
        if (!tool) {
            respondError(msg.id, -32602, `Unknown tool: ${name}`);
            return;
        }
        try {
            const text = await tool.handler(msg.params?.arguments || {});
            respond(msg.id, { content: [{ type: 'text', text }] });
        } catch (e: any) {
            respondError(msg.id, -32000, e?.message || String(e));
        }
        return;
    }
    if (msg.id !== undefined) respond(msg.id, {});
}

if (require.main === module) {
    let buffer = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            try {
                void handleMessage(JSON.parse(line));
            } catch (e: any) {
                respondError(undefined, -32700, e?.message || String(e));
            }
        }
    });

    process.stdin.on('end', () => process.exit(0));
    process.stderr.write(`[mimo-multimodal-mcp] ready in ${workspaceRoot()} on ${os.platform()}\n`);
}
