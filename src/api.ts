import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as net from 'net';
import * as tls from 'tls';
import { StringDecoder } from 'string_decoder';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { URL } from 'url';

export type ApiEndpointMode = 'chat_completions' | 'responses';

export function normalizeApiEndpointMode(value: unknown): ApiEndpointMode {
    return value === 'responses' ? 'responses' : 'chat_completions';
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[];
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    /** Replay metadata — tool name for history display */
    _toolName?: string;
    /** Replay metadata — elapsed seconds for history display */
    _toolElapsed?: number;
    /** Replay metadata - wall-clock elapsed seconds for a user turn */
    _elapsedSec?: number;
    /** Replay metadata - serialized webview turn snapshot for high-fidelity history */
    _uiSnapshot?: any;
    /** Replay metadata - original user images when the model-facing content was converted to text */
    _uiImages?: Array<{ dataUrl: string; name: string; size: number }>;
}

export interface ContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}

export interface StreamDelta {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface StreamCallbacks {
    onToken?: (token: string) => void;
    onReasoning?: (token: string) => void;
    onToolCalls?: (toolCalls: ToolCall[]) => void;
    onError?: (error: string) => void;
    onUsage?: (usage: TokenUsage) => void;
}

type ResponseInputItem = {
    role?: 'system' | 'user' | 'assistant';
    type?: string;
    content?: Array<Record<string, any>>;
    call_id?: string;
    name?: string;
    arguments?: string;
    output?: string;
};

type RequestHeaders = Record<string, string | number>;

type ProxyEnv = NodeJS.ProcessEnv;

type ProxyCandidate = {
    value: string;
    name: string;
};

export type ResolvedProxy = {
    url: URL;
    source: string;
    rewrittenForWsl: boolean;
};

function firstEnv(env: ProxyEnv, names: string[]): ProxyCandidate | null {
    for (const name of names) {
        const value = env[name];
        if (typeof value === 'string' && value.trim()) {
            return { value: value.trim(), name };
        }
    }
    return null;
}

function firstPacProxy(value: string): string | null {
    for (const part of value.split(';')) {
        const raw = part.trim();
        if (!raw || /^DIRECT$/i.test(raw)) continue;
        const proxyDirective = raw.match(/^(?:PROXY|HTTPS?)\s+(.+)$/i);
        if (proxyDirective) return proxyDirective[1].trim();
        return raw;
    }
    return null;
}

function normalizeProxyUrl(value: string): URL | null {
    const firstProxy = firstPacProxy(value);
    if (!firstProxy) return null;
    let raw = firstProxy;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
    try {
        const parsed = new URL(raw);
        if (!/^https?:$/i.test(parsed.protocol)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host === '[::1]';
}

function isWslEnvironment(env: ProxyEnv = process.env): boolean {
    if (env.WSL_INTEROP || env.WSL_DISTRO_NAME) return true;
    if (process.platform !== 'linux') return false;
    try {
        return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8'));
    } catch {
        return false;
    }
}

function getWslHostIp(env: ProxyEnv = process.env): string | null {
    const explicit = env.MIMO_WSL_HOST_IP?.trim();
    if (explicit) return explicit;
    try {
        const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
        const match = resolv.match(/^\s*nameserver\s+([^\s#]+)/m);
        return match?.[1] || null;
    } catch {
        return null;
    }
}

function rewriteLocalhostProxyForWsl(proxyUrl: URL, env: ProxyEnv = process.env): boolean {
    if (env.MIMO_DISABLE_WSL_PROXY_REWRITE === '1') return false;
    if (!isWslEnvironment(env) || !isLoopbackHost(proxyUrl.hostname)) return false;
    const hostIp = getWslHostIp(env);
    if (!hostIp) return false;
    proxyUrl.hostname = hostIp;
    return true;
}

function shouldIgnoreInjectedWslLoopbackProxy(candidate: ProxyCandidate, proxyUrl: URL, env: ProxyEnv = process.env): boolean {
    if (env.MIMO_WSL_PROXY_MODE === 'rewrite') return false;
    if (!isWslEnvironment(env) || !isLoopbackHost(proxyUrl.hostname)) return false;
    return candidate.name === 'vscode.http.proxy' || /^PROXY\s+/i.test(candidate.value);
}

function hostMatchesNoProxy(hostname: string, entry: string): boolean {
    const host = hostname.toLowerCase();
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    if (rule.startsWith('.')) return host.endsWith(rule) || host === rule.slice(1);
    return host === rule || host.endsWith(`.${rule}`);
}

function shouldBypassProxy(target: URL, env: ProxyEnv = process.env): boolean {
    const noProxy = firstEnv(env, ['NO_PROXY', 'no_proxy'])?.value;
    if (!noProxy) return false;
    return noProxy.split(',').some((entry) => hostMatchesNoProxy(target.hostname, entry));
}

function getVsCodeHttpProxy(): ProxyCandidate | null {
    try {
        // Optional dependency: only available inside the VS Code extension host.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode');
        const proxy = vscode?.workspace?.getConfiguration?.('http')?.get?.('proxy');
        if (typeof proxy === 'string' && proxy.trim()) {
            return { value: proxy.trim(), name: 'vscode.http.proxy' };
        }
    } catch {
        // Running outside VS Code, such as unit tests.
    }
    return null;
}

function getProxyCandidate(
    targetUrl: URL,
    env: ProxyEnv = process.env,
    vscodeProxy: ProxyCandidate | null = getVsCodeHttpProxy(),
): ProxyCandidate | null {
    const envProxy = targetUrl.protocol === 'https:'
        ? firstEnv(env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])
        : firstEnv(env, ['HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']);
    return envProxy || vscodeProxy;
}

export function resolveProxyForUrl(
    target: string | URL,
    env: ProxyEnv = process.env,
    vscodeProxy: ProxyCandidate | null = getVsCodeHttpProxy(),
): ResolvedProxy | null {
    const targetUrl = typeof target === 'string' ? new URL(target) : target;
    if (shouldBypassProxy(targetUrl, env)) return null;
    const proxyCandidate = getProxyCandidate(targetUrl, env, vscodeProxy);
    if (!proxyCandidate) return null;

    const proxyUrl = normalizeProxyUrl(proxyCandidate.value);
    if (!proxyUrl) return null;
    if (shouldIgnoreInjectedWslLoopbackProxy(proxyCandidate, proxyUrl, env)) {
        console.log(`[MiMo API] Ignoring WSL-injected loopback proxy from ${proxyCandidate.name}: ${proxyCandidate.value}`);
        return null;
    }
    const rewrittenForWsl = rewriteLocalhostProxyForWsl(proxyUrl, env);
    return { url: proxyUrl, source: proxyCandidate.name, rewrittenForWsl };
}

function createRequestAgent(target: URL): http.Agent | https.Agent | false {
    const proxy = resolveProxyForUrl(target);
    if (!proxy) return false;
    if (proxy.rewrittenForWsl) {
        console.log(`[MiMo API] Rewrote WSL localhost proxy from ${proxy.source} to ${proxy.url.host}`);
    }
    return target.protocol === 'https:'
        ? new HttpsProxyAgent(proxy.url)
        : new HttpProxyAgent(proxy.url);
}

function createAbortError(message = 'Aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function parseRetryAfterMs(message: string): number | null {
    const match = message.match(/retry-after[:\s]+(\d+)/i);
    if (!match) return null;
    return Math.max(0, Number(match[1]) * 1000);
}

function isRetryableStreamError(error: any): boolean {
    const message = String(error?.message || error || '');
    if (/AbortError|Aborted/i.test(error?.name || message)) return false;
    if (/\b(408|409|425|429|500|502|503|504)\b/.test(message)) return true;
    return /Request timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|unexpected end of data|aborted before complete/i.test(message);
}

function retryDelayMs(error: any, attempt: number): number {
    const retryAfter = parseRetryAfterMs(String(error?.message || ''));
    if (retryAfter !== null) return Math.min(retryAfter, 30_000);
    const base = Math.min(1_500 * Math.pow(2, attempt), 15_000);
    const jitter = Math.floor(Math.random() * 750);
    return base + jitter;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
        }, { once: true });
    });
}

function socketRequestRaw(
    parsed: URL,
    method: string,
    headers: RequestHeaders,
    body: Buffer,
    timeout: number,
    signal: AbortSignal | undefined,
    onData: (chunk: Buffer) => void,
    onEnd: () => void,
    onError: (error: Error) => void,
): { destroy: () => void } {
    const isHttps = parsed.protocol === 'https:';
    const port = Number(parsed.port || (isHttps ? 443 : 80));
    const socket = isHttps
        ? tls.connect({ host: parsed.hostname, port, servername: parsed.hostname })
        : net.connect({ host: parsed.hostname, port });
    let ended = false;
    const fail = (error: Error) => {
        if (ended) return;
        ended = true;
        socket.destroy();
        onError(error);
    };
    const finish = () => {
        if (ended) return;
        ended = true;
        onEnd();
    };

    socket.setTimeout(timeout, () => fail(new Error('Request timeout')));
    socket.once('error', fail);
    socket.once('end', finish);
    socket.once('close', () => finish());
    socket.on('data', onData);

    if (signal) {
        if (signal.aborted) {
            fail(createAbortError());
            return { destroy: () => socket.destroy() };
        }
        signal.addEventListener('abort', () => fail(createAbortError()), { once: true });
    }

    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const headerLines = [
        `${method} ${path} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Connection: close',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        '',
        '',
    ].join('\r\n');

    socket.once(isHttps ? 'secureConnect' : 'connect', () => {
        socket.write(headerLines);
        socket.write(body);
    });

    return {
        destroy: () => {
            ended = true;
            socket.destroy();
        },
    };
}

function splitHttpResponse(buffer: Buffer): { headers: string; body: Buffer } | null {
    const idx = buffer.indexOf('\r\n\r\n');
    if (idx < 0) return null;
    return {
        headers: buffer.slice(0, idx).toString('utf8'),
        body: buffer.slice(idx + 4),
    };
}

function parseStatusCode(headers: string): number {
    const match = headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i);
    return match ? Number(match[1]) : 0;
}

function decodeChunkedBody(body: Buffer): Buffer {
    let offset = 0;
    const chunks: Buffer[] = [];
    while (offset < body.length) {
        const lineEnd = body.indexOf('\r\n', offset);
        if (lineEnd < 0) break;
        const sizeText = body.slice(offset, lineEnd).toString('ascii').split(';')[0].trim();
        const size = parseInt(sizeText, 16);
        if (!Number.isFinite(size)) break;
        offset = lineEnd + 2;
        if (size === 0) break;
        if (offset + size > body.length) break;
        chunks.push(body.slice(offset, offset + size));
        offset += size + 2;
    }
    return Buffer.concat(chunks);
}

function responseBodyFromHeaders(headers: string, body: Buffer): Buffer {
    return /transfer-encoding:\s*chunked/i.test(headers) ? decodeChunkedBody(body) : body;
}

/**
 * MiMo API client — pure HTTP, no SDK dependency.
 * Uses OpenAI-compatible chat completions with SSE streaming.
 */
export class MiMoAPI {
    constructor(
        private apiKey: string,
        private baseUrl: string,
        private apiEndpoint: ApiEndpointMode = 'chat_completions',
    ) {}

    getEndpointMode(): ApiEndpointMode {
        return this.apiEndpoint;
    }

    getRequestPath(): string {
        return this.apiEndpoint === 'responses' ? '/responses' : '/chat/completions';
    }

    private buildUrl(): string {
        return `${this.baseUrl}${this.getRequestPath()}`;
    }

    private transformRequest(params: Record<string, any>, stream: boolean): Record<string, any> {
        if (this.apiEndpoint !== 'responses') return { ...params, stream };

        const body: Record<string, any> = {
            model: params.model,
            input: this.toResponsesInput(params.messages),
            stream,
        };

        const maxTokens = Number(params.max_output_tokens ?? params.max_tokens);
        if (Number.isFinite(maxTokens) && maxTokens > 0) {
            body.max_output_tokens = Math.round(maxTokens);
        }

        if (params.temperature !== undefined) body.temperature = params.temperature;
        if (params.top_p !== undefined) body.top_p = params.top_p;
        if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
        if (params.extra_body && typeof params.extra_body === 'object') {
            Object.assign(body, params.extra_body);
        }

        const tools = this.toResponsesTools(params.tools);
        if (tools.length > 0) body.tools = tools;
        return body;
    }

    private toResponsesTools(tools: any): any[] {
        if (!Array.isArray(tools)) return [];
        return tools
            .map((tool) => {
                if (!tool || tool.type !== 'function' || !tool.function?.name) return null;
                return {
                    type: 'function',
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                    strict: false,
                };
            })
            .filter((tool): tool is { type: string; name: any; description: any; parameters: any; strict: boolean } => !!tool);
    }

    private toResponsesInput(messages: any): ResponseInputItem[] {
        if (!Array.isArray(messages)) return [];
        const input: ResponseInputItem[] = [];

        for (const msg of messages) {
            if (!msg || typeof msg !== 'object') continue;
            const role = msg.role;

            if (role === 'tool') {
                input.push({
                    type: 'function_call_output',
                    call_id: String(msg.tool_call_id || ''),
                    output: this.contentToPlainText(msg.content),
                });
                continue;
            }

            if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const text = this.contentToPlainText(msg.content);
                if (text) {
                    input.push({
                        role: 'assistant',
                        content: [{ type: 'output_text', text }],
                    });
                }
                for (const toolCall of msg.tool_calls) {
                    if (!toolCall?.id || !toolCall.function?.name) continue;
                    input.push({
                        type: 'function_call',
                        call_id: toolCall.id,
                        name: toolCall.function.name,
                        arguments: toolCall.function.arguments || '',
                    });
                }
                continue;
            }

            const content = this.toResponsesContent(msg.content);
            if (content.length === 0) continue;
            input.push({ role, content });
        }

        return input;
    }

    private toResponsesContent(content: any): Array<Record<string, any>> {
        if (typeof content === 'string') {
            return content ? [{ type: 'input_text', text: content }] : [];
        }
        if (!Array.isArray(content)) return [];

        const parts: Array<Record<string, any>> = [];
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (part.type === 'text' && typeof part.text === 'string' && part.text) {
                parts.push({ type: 'input_text', text: part.text });
            } else if (part.type === 'image_url' && part.image_url?.url) {
                parts.push({ type: 'input_image', image_url: part.image_url.url });
            }
        }
        return parts;
    }

    private contentToPlainText(content: any): string {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content
            .map((part) => (part?.type === 'text' && typeof part.text === 'string') ? part.text : '')
            .filter(Boolean)
            .join('\n');
    }

    private extractTextFromResponseJson(json: any): string {
        if (!json || typeof json !== 'object') return '';

        const outputText = typeof json.output_text === 'string' ? json.output_text : '';
        if (outputText) return outputText;

        const segments: string[] = [];
        for (const item of Array.isArray(json.output) ? json.output : []) {
            if (!item || typeof item !== 'object') continue;
            if (Array.isArray(item.content)) {
                for (const part of item.content) {
                    const text = typeof part?.text === 'string' ? part.text : '';
                    if (text) segments.push(text);
                }
            }
        }
        return segments.join('');
    }

    /**
     * Non-streaming chat completion. Used for internal tasks like summarization.
     * Returns the full response text.
     */
    async chatCompletion(
        params: Record<string, any>,
        signal?: AbortSignal,
    ): Promise<string> {
        const maxRetries = 3;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await this.doChatCompletion(params, signal);
            } catch (e: any) {
                lastError = e;
                if (!isRetryableStreamError(e) || signal?.aborted || attempt >= maxRetries) {
                    throw e;
                }
                await abortableDelay(retryDelayMs(e, attempt), signal);
            }
        }
        throw lastError || new Error('Max retries exceeded');
    }

    private async doChatCompletion(
        params: Record<string, any>,
        signal?: AbortSignal,
    ): Promise<string> {
        const url = this.buildUrl();
        const requestBody = this.transformRequest(params, false);
        const body = Buffer.from(JSON.stringify(requestBody), 'utf-8');

        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const transport = isHttps ? https : http;
            const agent = createRequestAgent(parsed);
            if (agent === false) {
                let raw = Buffer.alloc(0);
                socketRequestRaw(
                    parsed,
                    'POST',
                    {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                        Authorization: `Bearer ${this.apiKey}`,
                        Accept: 'application/json',
                    },
                    body,
                    60_000,
                    signal,
                    (chunk) => { raw = Buffer.concat([raw, chunk]); },
                    () => {
                        const split = splitHttpResponse(raw);
                        if (!split) {
                            reject(new Error('Failed to parse response headers'));
                            return;
                        }
                        const statusCode = parseStatusCode(split.headers);
                        const data = responseBodyFromHeaders(split.headers, split.body).toString('utf8');
                        if (statusCode !== 200) {
                            reject(new Error(`API error ${statusCode}: ${data.slice(0, 500)}`));
                            return;
                        }
                        try {
                            const json = JSON.parse(data);
                            const content = this.apiEndpoint === 'responses'
                                ? this.extractTextFromResponseJson(json)
                                : (json.choices?.[0]?.message?.content || '');
                            resolve(content);
                        } catch {
                            reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
                        }
                    },
                    reject,
                );
                return;
            }

            const req = transport.request(
                {
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: parsed.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                        Authorization: `Bearer ${this.apiKey}`,
                        Accept: 'application/json',
                    },
                    agent,
                    timeout: 60_000,
                },
                (res) => {
                    let data = '';
                    res.on('data', (c: Buffer) => (data += c.toString('utf-8')));
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`API error ${res.statusCode}: ${data.slice(0, 500)}`));
                            return;
                        }
                        try {
                            const json = JSON.parse(data);
                            const content = this.apiEndpoint === 'responses'
                                ? this.extractTextFromResponseJson(json)
                                : (json.choices?.[0]?.message?.content || '');
                            resolve(content);
                        } catch {
                            reject(new Error(`Failed to parse response: ${data.slice(0, 200)}`));
                        }
                    });
                    res.on('error', reject);
                },
            );

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

            if (signal) {
                if (signal.aborted) { req.destroy(); reject(createAbortError()); return; }
                signal.addEventListener('abort', () => { req.destroy(); reject(createAbortError()); }, { once: true });
            }

            req.write(body);
            req.end();
        });
    }

    /**
     * Streaming chat completion. Calls callbacks as tokens arrive.
     * Returns the full collected content and tool calls.
     */
    async chatCompletionsStream(
        params: Record<string, any>,
        callbacks: StreamCallbacks,
        signal?: AbortSignal,
    ): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent: string; usage: TokenUsage | null }> {
        const maxRetries = 4;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await this.doChatCompletionsStream(params, callbacks, signal);
                // Detect silent empty response: stream ended without [DONE] and produced nothing.
                // This typically happens when the connection drops mid-stream on first attempt.
                if (!result.content && result.toolCalls.length === 0 && !result.reasoningContent && !signal?.aborted) {
                    throw new Error('unexpected end of data: empty stream response');
                }
                return result;
            } catch (e: any) {
                lastError = e;
                if (!isRetryableStreamError(e) || signal?.aborted || attempt >= maxRetries) {
                    throw e;
                }
                const delay = retryDelayMs(e, attempt);
                callbacks.onReasoning?.(`\n[Connection recovery ${attempt + 1}/${maxRetries}: ${String(e.message || e).slice(0, 120)}. Retrying in ${(delay / 1000).toFixed(1)}s.]\n`);
                await abortableDelay(delay, signal);
            }
        }
        throw lastError || new Error('Max retries exceeded');
    }

    private async doChatCompletionsStream(
        params: Record<string, any>,
        callbacks: StreamCallbacks,
        signal?: AbortSignal,
    ): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent: string; usage: TokenUsage | null }> {
        const url = this.buildUrl();
        const requestBody = this.transformRequest(params, true);
        const body = Buffer.from(JSON.stringify(requestBody), 'utf-8');
        console.log(`[MiMo API] Request: ${params.model}, messages: ${params.messages?.length}, body size: ${body.length} chars`);

        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const isHttps = parsed.protocol === 'https:';
            const transport = isHttps ? https : http;
            const agent = createRequestAgent(parsed);
            let settled = false;
            const settle = (err: Error) => { if (!settled) { settled = true; reject(err); } };
            const finalizeStreamBody = (bodyText: string, toolCallsMap: Map<number, { id: string; name: string; arguments: string }>, collectedUsage: TokenUsage | null, collectedContent: string, collectedReasoning: string) => {
                const toolCalls: ToolCall[] = [];
                for (const [, tc] of toolCallsMap) {
                    if (tc.id && tc.name) {
                        toolCalls.push({
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.name, arguments: tc.arguments },
                        });
                    }
                }
                if (toolCalls.length > 0) callbacks.onToolCalls?.(toolCalls);
                if (collectedUsage) callbacks.onUsage?.(collectedUsage);
                if (!settled) {
                    settled = true;
                    resolve({ content: collectedContent, toolCalls, reasoningContent: collectedReasoning, usage: collectedUsage });
                }
            };
            if (agent === false) {
                let headerBuffer = Buffer.alloc(0);
                let bodyBuffer = Buffer.alloc(0);
                let headersParsed = false;
                let isChunked = false;
                let errorStatus = 0;
                let errorBody = Buffer.alloc(0);
                let sseBuffer = '';
                const decoder = new StringDecoder('utf8');
                let collectedContent = '';
                let collectedReasoning = '';
                let collectedUsage: TokenUsage | null = null;
                const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
                let socketHandle: { destroy: () => void } | null = null;

                const finishSocketStream = () => {
                    const toolCalls: ToolCall[] = [];
                    for (const [, tc] of toolCallsMap) {
                        if (tc.id && tc.name) {
                            toolCalls.push({
                                id: tc.id,
                                type: 'function',
                                function: { name: tc.name, arguments: tc.arguments },
                            });
                        }
                    }
                    if (toolCalls.length > 0) callbacks.onToolCalls?.(toolCalls);
                    if (collectedUsage) callbacks.onUsage?.(collectedUsage);
                    if (!settled) {
                        settled = true;
                        socketHandle?.destroy();
                        resolve({ content: collectedContent, toolCalls, reasoningContent: collectedReasoning, usage: collectedUsage });
                    }
                };

                const processSseText = (text: string) => {
                    if (settled) return;
                    sseBuffer += text;
                    let nlIdx: number;
                    while ((nlIdx = sseBuffer.indexOf('\n')) !== -1) {
                        const line = sseBuffer.slice(0, nlIdx).trim();
                        sseBuffer = sseBuffer.slice(nlIdx + 1);
                        if (!line) continue;
                        if (line === 'data: [DONE]') {
                            finishSocketStream();
                            return;
                        }
                        if (!line.startsWith('data: ')) continue;
                        let eventJson: any;
                        try {
                            eventJson = JSON.parse(line.slice(6));
                        } catch {
                            continue;
                        }
                        if (this.apiEndpoint === 'responses') {
                            const rs = this.handleResponsesStreamEvent(eventJson, toolCallsMap, callbacks);
                            if (rs.contentDelta) collectedContent += rs.contentDelta;
                            if (rs.reasoningDelta) collectedReasoning += rs.reasoningDelta;
                            if (rs.usage) collectedUsage = rs.usage;
                            continue;
                        }
                        const choices = eventJson.choices;
                        if (!choices?.length) continue;
                        const delta: StreamDelta = choices[0].delta || {};
                        if (delta.reasoning_content) {
                            collectedReasoning += delta.reasoning_content;
                            callbacks.onReasoning?.(delta.reasoning_content);
                        }
                        if (delta.content) {
                            collectedContent += delta.content;
                            callbacks.onToken?.(delta.content);
                        }
                        if (delta.tool_calls) {
                            for (const tc of delta.tool_calls) {
                                const idx = tc.index;
                                if (!toolCallsMap.has(idx)) toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
                                const existing = toolCallsMap.get(idx)!;
                                if (tc.id) existing.id = tc.id;
                                if (tc.function?.name) existing.name = tc.function.name;
                                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                            }
                        }
                        if (eventJson.usage) {
                            collectedUsage = {
                                promptTokens: eventJson.usage.prompt_tokens || 0,
                                completionTokens: eventJson.usage.completion_tokens || 0,
                                totalTokens: eventJson.usage.total_tokens || 0,
                            };
                        }
                    }
                };

                const feedBodyBytes = (bytes: Buffer) => {
                    if (settled || bytes.length === 0) return;
                    if (!isChunked) {
                        processSseText(decoder.write(bytes));
                        return;
                    }
                    bodyBuffer = Buffer.concat([bodyBuffer, bytes]);
                    while (!settled) {
                        const lineEnd = bodyBuffer.indexOf('\r\n');
                        if (lineEnd < 0) return;
                        const sizeText = bodyBuffer.slice(0, lineEnd).toString('ascii').split(';')[0].trim();
                        const size = parseInt(sizeText, 16);
                        if (!Number.isFinite(size)) return;
                        const chunkStart = lineEnd + 2;
                        const chunkEnd = chunkStart + size;
                        if (bodyBuffer.length < chunkEnd + 2) return;
                        if (size === 0) {
                            finishSocketStream();
                            return;
                        }
                        processSseText(decoder.write(bodyBuffer.slice(chunkStart, chunkEnd)));
                        bodyBuffer = bodyBuffer.slice(chunkEnd + 2);
                    }
                };

                socketHandle = socketRequestRaw(
                    parsed,
                    'POST',
                    {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                        Authorization: `Bearer ${this.apiKey}`,
                        Accept: 'text/event-stream',
                    },
                    body,
                    120_000,
                    signal,
                    (chunk) => {
                        if (settled) return;
                        if (errorStatus) {
                            errorBody = Buffer.concat([errorBody, chunk]);
                            return;
                        }
                        if (!headersParsed) {
                            headerBuffer = Buffer.concat([headerBuffer, chunk]);
                            const split = splitHttpResponse(headerBuffer);
                            if (!split) return;
                            headersParsed = true;
                            const statusCode = parseStatusCode(split.headers);
                            if (statusCode !== 200) {
                                errorStatus = statusCode;
                                errorBody = Buffer.concat([errorBody, split.body]);
                                return;
                            }
                            isChunked = /transfer-encoding:\s*chunked/i.test(split.headers);
                            feedBodyBytes(split.body);
                            return;
                        }
                        feedBodyBytes(chunk);
                    },
                    () => {
                        if (settled) return;
                        if (!headersParsed) {
                            settle(new Error('Failed to parse response headers'));
                            return;
                        }
                        if (errorStatus) {
                            settle(new Error(`API error ${errorStatus}: ${errorBody.toString('utf8').slice(0, 500)}`));
                            return;
                        }
                        processSseText(decoder.end());
                        finishSocketStream();
                    },
                    settle,
                );
                return;
            }

            const req = transport.request(
                {
                    hostname: parsed.hostname,
                    port: parsed.port || (isHttps ? 443 : 80),
                    path: parsed.pathname,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': body.length,
                        Authorization: `Bearer ${this.apiKey}`,
                        Accept: 'text/event-stream',
                    },
                    agent,
                    timeout: 120_000,
                },
                (res) => {
                    resRef = res; // save for abort listener
                    if (res.statusCode !== 200) {
                        let errBody = '';
                        res.on('data', (c) => (errBody += c.toString()));
                        res.on('end', () =>
                            settle(new Error(`API error ${res.statusCode}: ${errBody.slice(0, 500)}`)),
                        );
                        return;
                    }

                    let collectedContent = '';
                    let collectedReasoning = '';
                    let collectedUsage: TokenUsage | null = null;
                    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
                    let buffer = '';

                    res.on('data', (chunk: Buffer) => {
                        // Check abort during streaming — destroy immediately
                        if (signal?.aborted) {
                            res.destroy();
                            req.destroy();
                            settle(createAbortError());
                            return;
                        }
                        buffer += chunk.toString('utf-8');

                        // Process complete lines
                        let nlIdx: number;
                        while ((nlIdx = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.slice(0, nlIdx).trim();
                            buffer = buffer.slice(nlIdx + 1);

                            if (!line) continue;
                            if (line === 'data: [DONE]') {
                                // Finalize
                                const toolCalls: ToolCall[] = [];
                                for (const [, tc] of toolCallsMap) {
                                    if (tc.id && tc.name) {
                                        toolCalls.push({
                                            id: tc.id,
                                            type: 'function',
                                            function: { name: tc.name, arguments: tc.arguments },
                                        });
                                    }
                                }
                                if (toolCalls.length > 0) {
                                    callbacks.onToolCalls?.(toolCalls);
                                }
                                if (collectedUsage) {
                                    callbacks.onUsage?.(collectedUsage);
                                }
                                resolve({ content: collectedContent, toolCalls, reasoningContent: collectedReasoning, usage: collectedUsage });
                                return;
                            }

                            if (!line.startsWith('data: ')) continue;
                            let parsed: any;
                            try {
                                parsed = JSON.parse(line.slice(6));
                            } catch {
                                continue;
                            }

                            if (this.apiEndpoint === 'responses') {
                                const responseState = this.handleResponsesStreamEvent(parsed, toolCallsMap, callbacks);
                                if (responseState.contentDelta) {
                                    collectedContent += responseState.contentDelta;
                                }
                                if (responseState.reasoningDelta) {
                                    collectedReasoning += responseState.reasoningDelta;
                                }
                                if (responseState.usage) {
                                    collectedUsage = responseState.usage;
                                }
                                continue;
                            }

                            const choices = parsed.choices;
                            if (!choices?.length) continue;
                            const delta: StreamDelta = choices[0].delta || {};

                            if (delta.reasoning_content) {
                                collectedReasoning += delta.reasoning_content;
                                callbacks.onReasoning?.(delta.reasoning_content);
                            }

                            if (delta.content) {
                                collectedContent += delta.content;
                                callbacks.onToken?.(delta.content);
                            }

                            if (delta.tool_calls) {
                                for (const tc of delta.tool_calls) {
                                    const idx = tc.index;
                                    if (!toolCallsMap.has(idx)) {
                                        toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
                                    }
                                    const existing = toolCallsMap.get(idx)!;
                                    if (tc.id) existing.id = tc.id;
                                    if (tc.function?.name) existing.name = tc.function.name;
                                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                                }
                            }

                            if (parsed.usage) {
                                collectedUsage = {
                                    promptTokens: parsed.usage.prompt_tokens || 0,
                                    completionTokens: parsed.usage.completion_tokens || 0,
                                    totalTokens: parsed.usage.total_tokens || 0,
                                };
                            }
                        }
                    });

                    res.on('end', () => {
                        // Flush any remaining buffered data (partial last line)
                        if (buffer.trim()) {
                            const leftover = buffer.trim();
                            if (leftover === 'data: [DONE]') {
                                // Normal end marker arrived in final chunk
                            } else if (leftover.startsWith('data: ')) {
                                try {
                                    const parsed = JSON.parse(leftover.slice(6));
                                    if (this.apiEndpoint === 'responses') {
                                        const rs = this.handleResponsesStreamEvent(parsed, toolCallsMap, callbacks);
                                        if (rs.contentDelta) collectedContent += rs.contentDelta;
                                        if (rs.reasoningDelta) collectedReasoning += rs.reasoningDelta;
                                        if (rs.usage) collectedUsage = rs.usage;
                                    } else {
                                        const choices = parsed.choices;
                                        if (choices?.length) {
                                            const delta: StreamDelta = choices[0].delta || {};
                                            if (delta.reasoning_content) collectedReasoning += delta.reasoning_content;
                                            if (delta.content) { collectedContent += delta.content; callbacks.onToken?.(delta.content); }
                                            if (delta.tool_calls) {
                                                for (const tc of delta.tool_calls) {
                                                    const idx = tc.index;
                                                    if (!toolCallsMap.has(idx)) toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
                                                    const existing = toolCallsMap.get(idx)!;
                                                    if (tc.id) existing.id = tc.id;
                                                    if (tc.function?.name) existing.name = tc.function.name;
                                                    if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                                                }
                                            }
                                            if (parsed.usage) {
                                                collectedUsage = { promptTokens: parsed.usage.prompt_tokens || 0, completionTokens: parsed.usage.completion_tokens || 0, totalTokens: parsed.usage.total_tokens || 0 };
                                            }
                                        }
                                    }
                                } catch { /* ignore unparseable leftover */ }
                            }
                        }
                        // If we get here without [DONE], resolve with what we have
                        const toolCalls: ToolCall[] = [];
                        for (const [, tc] of toolCallsMap) {
                            if (tc.id && tc.name) {
                                toolCalls.push({
                                    id: tc.id,
                                    type: 'function',
                                    function: { name: tc.name, arguments: tc.arguments },
                                });
                            }
                        }
                        if (collectedUsage) {
                            callbacks.onUsage?.(collectedUsage);
                        }
                        if (!settled) {
                            settled = true;
                            resolve({ content: collectedContent, toolCalls, reasoningContent: collectedReasoning, usage: collectedUsage });
                        }
                    });

                    res.on('error', (err) => { settle(err); });
                },
            );

            req.on('error', (err) => { settle(err); });
            req.on('timeout', () => {
                req.destroy();
                settle(new Error('Request timeout'));
            });

            // Handle abort signal — destroy both req AND res for fast teardown
            let resRef: any = null;
            if (signal) {
                if (signal.aborted) {
                    req.destroy();
                    settle(createAbortError());
                    return;
                }
                signal.addEventListener('abort', () => {
                    if (resRef) resRef.destroy();
                    req.destroy();
                    settle(createAbortError());
                }, { once: true });
            }

            req.write(body);
            req.end();
        });
    }

    private handleResponsesStreamEvent(
        parsed: any,
        toolCallsMap: Map<number, { id: string; name: string; arguments: string }>,
        callbacks: StreamCallbacks,
    ): { contentDelta: string; reasoningDelta: string; usage: TokenUsage | null } {
        const type = String(parsed?.type || '');
        let contentDelta = '';
        let reasoningDelta = '';
        let usage: TokenUsage | null = null;

        if (type === 'response.output_text.delta') {
            contentDelta = String(parsed.delta || '');
            if (contentDelta) callbacks.onToken?.(contentDelta);
        } else if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
            reasoningDelta = String(parsed.delta || '');
            if (reasoningDelta) callbacks.onReasoning?.(reasoningDelta);
        } else if (type === 'response.function_call_arguments.delta') {
            const idx = Number(parsed.output_index ?? 0);
            if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
            }
            const existing = toolCallsMap.get(idx)!;
            if (parsed.item_id) existing.id = String(parsed.item_id);
            if (parsed.name) existing.name = String(parsed.name);
            if (parsed.delta) existing.arguments += String(parsed.delta);
        } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            const item = parsed.item || {};
            if (item.type === 'function_call') {
                const idx = Number(parsed.output_index ?? item.output_index ?? 0);
                if (!toolCallsMap.has(idx)) {
                    toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
                }
                const existing = toolCallsMap.get(idx)!;
                if (item.call_id) existing.id = String(item.call_id);
                if (item.name) existing.name = String(item.name);
                if (item.arguments) existing.arguments = String(item.arguments);
            }
        } else if (type === 'response.completed') {
            const usageRaw = parsed.response?.usage || parsed.usage;
            if (usageRaw) {
                usage = {
                    promptTokens: usageRaw.input_tokens || usageRaw.prompt_tokens || 0,
                    completionTokens: usageRaw.output_tokens || usageRaw.completion_tokens || 0,
                    totalTokens: usageRaw.total_tokens
                        || ((usageRaw.input_tokens || usageRaw.prompt_tokens || 0) + (usageRaw.output_tokens || usageRaw.completion_tokens || 0)),
                };
                callbacks.onUsage?.(usage);
            }
        }

        return { contentDelta, reasoningDelta, usage };
    }
}
