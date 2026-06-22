import { describe, it, expect, summary } from './test-runner';
import { MiMoAPI, normalizeApiEndpointMode, resolveProxyForUrl } from '../api';

describe('normalizeApiEndpointMode', () => {
    it('defaults to chat completions', () => {
        expect(normalizeApiEndpointMode(undefined)).toBe('chat_completions');
        expect(normalizeApiEndpointMode('unknown')).toBe('chat_completions');
    });

    it('keeps responses mode', () => {
        expect(normalizeApiEndpointMode('responses')).toBe('responses');
    });
});

describe('MiMoAPI endpoint selection', () => {
    it('uses chat completions path by default', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1');
        expect(api.getRequestPath()).toBe('/chat/completions');
        expect(api.getEndpointMode()).toBe('chat_completions');
    });

    it('uses responses path when configured', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1', 'responses');
        expect(api.getRequestPath()).toBe('/responses');
        expect(api.getEndpointMode()).toBe('responses');
    });

    it('sanitizes chat-completions request messages to API-safe fields only', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1');
        const body = (api as any).transformRequest({
            model: 'mimo-v2.5-pro',
            messages: [
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'write_file', arguments: '{"path":"a.md","content":"hello"}' },
                        },
                    ],
                    reasoning_content: '',
                    _uiSnapshot: { noisy: true },
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: 'Written to a.md',
                    _toolName: 'write_file',
                    _toolElapsed: 0.2,
                },
            ],
        }, true);

        expect(body.messages.length).toBe(2);
        expect(body.messages[0]._uiSnapshot).toBe(undefined);
        expect(body.messages[1]._toolName).toBe(undefined);
        expect(body.messages[1]._toolElapsed).toBe(undefined);
        expect(body.messages[0].tool_calls[0].function.arguments).toBe('{"path":"a.md","content":"hello"}');
        expect('reasoning_content' in body.messages[0]).toBe(false);
    });

    it('sanitizes responses input messages to API-safe fields only', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1', 'responses');
        const body = (api as any).transformRequest({
            model: 'mimo-v2.5-pro',
            messages: [
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                        {
                            id: 'call_1',
                            type: 'function',
                            function: { name: 'write_file', arguments: '{"path":"a.md","content":"hello"}' },
                        },
                    ],
                    reasoning_content: '',
                    _uiSnapshot: { noisy: true },
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_1',
                    content: 'Written to a.md',
                    _toolName: 'write_file',
                },
            ],
        }, true);

        expect(body.input.length).toBe(2);
        expect(body.input[0].type).toBe('function_call');
        expect(body.input[0].call_id).toBe('call_1');
        expect(body.input[1].type).toBe('function_call_output');
        expect(body.input[1].output).toBe('Written to a.md');
    });

    it('builds a request debug summary without leaking message bodies', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1', 'responses');
        const summary = api.buildRequestDebugSummary([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'write_file', arguments: '{"path":"a.md","content":"top secret body"}' },
                    },
                ],
                reasoning_content: 'hidden reasoning',
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: 'Written to a.md',
            },
            {
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
                    { type: 'text', text: 'describe this image' },
                ],
            },
        ], 'mimo-v2.5-pro', 4321);

        expect(summary.endpointMode).toBe('responses');
        expect(summary.model).toBe('mimo-v2.5-pro');
        expect(summary.messageCount).toBe(3);
        expect(summary.assistantWithToolCalls).toBe(1);
        expect(summary.toolMessageCount).toBe(1);
        expect(summary.reasoningMessageCount).toBe(1);
        expect(summary.imageMessageCount).toBe(1);
        expect(summary.bodyChars).toBe(4321);
    });

    it('stores the last request debug summary for user-facing diagnostics', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1', 'responses');

        (api as any).logRequestDebugSummary([
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'write_file', arguments: '{"path":"a.md","content":"hello"}' },
                    },
                ],
            },
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: 'Written to a.md',
            },
        ], 'mimo-v2.5-pro', 2048);

        expect(api.getLastRequestSummary()).toContain('model=mimo-v2.5-pro');
        expect(api.getLastRequestSummary()).toContain('endpoint=responses');
        expect(api.getLastRequestSummary()).toContain('body_chars=2048');
    });

    it('treats incomplete streamed tool-call arguments as retryable stream failures', () => {
        const api = new MiMoAPI('key', 'https://api.example.com/v1');
        expect(typeof (api as any).chatCompletionsStream).toBe('function');
        expect((api as any).getRequestPath()).toBe('/chat/completions');
        expect(/unexpected end of data/i.test('unexpected end of data: incomplete streamed tool_call arguments')).toBe(true);
    });
});

describe('proxy resolution', () => {
    it('uses HTTPS proxy for HTTPS API targets', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'http://proxy.example.test:7890',
        });

        expect(proxy?.url.href).toBe('http://proxy.example.test:7890/');
        expect(proxy?.source).toBe('HTTPS_PROXY');
        expect(proxy?.rewrittenForWsl).toBe(false);
    });

    it('normalizes PROXY directives from VS Code proxy settings', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'PROXY 127.0.0.1:7890',
        });

        expect(proxy?.url.href).toBe('http://127.0.0.1:7890/');
    });

    it('reads VS Code http.proxy when proxy env vars are not set', () => {
        const proxy = resolveProxyForUrl(
            'https://api.example.com/v1/chat/completions',
            {},
            { value: 'PROXY 127.0.0.1:7890', name: 'vscode.http.proxy' },
        );

        expect(proxy?.url.href).toBe('http://127.0.0.1:7890/');
        expect(proxy?.source).toBe('vscode.http.proxy');
    });

    it('normalizes PAC-style proxy directives with DIRECT fallback', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'PROXY 127.0.0.1:7890; DIRECT',
        });

        expect(proxy?.url.href).toBe('http://127.0.0.1:7890/');
    });

    it('rewrites localhost proxy to the WSL host IP by default', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'http://127.0.0.1:7890',
            WSL_INTEROP: '/run/WSL/123_interop',
            MIMO_WSL_HOST_IP: '172.28.128.1',
        });

        expect(proxy?.url.href).toBe('http://172.28.128.1:7890/');
        expect(proxy?.rewrittenForWsl).toBe(true);
    });

    it('ignores WSL-injected PROXY loopback directives by default', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'PROXY 127.0.0.1:7890',
            WSL_INTEROP: '/run/WSL/123_interop',
            MIMO_WSL_HOST_IP: '172.28.128.1',
        });

        expect(proxy).toBe(null);
    });

    it('can force rewrite mode for WSL-injected PROXY directives', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'PROXY 127.0.0.1:7890',
            WSL_INTEROP: '/run/WSL/123_interop',
            MIMO_WSL_HOST_IP: '172.28.128.1',
            MIMO_WSL_PROXY_MODE: 'rewrite',
        });

        expect(proxy?.url.href).toBe('http://172.28.128.1:7890/');
        expect(proxy?.rewrittenForWsl).toBe(true);
    });

    it('ignores VS Code WSL loopback proxy by default', () => {
        const proxy = resolveProxyForUrl(
            'https://api.example.com/v1/chat/completions',
            {
                WSL_INTEROP: '/run/WSL/123_interop',
                MIMO_WSL_HOST_IP: '172.28.128.1',
            },
            { value: 'PROXY 127.0.0.1:7890', name: 'vscode.http.proxy' },
        );

        expect(proxy).toBe(null);
    });

    it('can disable WSL localhost proxy rewriting', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'http://localhost:7890',
            WSL_INTEROP: '/run/WSL/123_interop',
            MIMO_WSL_HOST_IP: '172.28.128.1',
            MIMO_DISABLE_WSL_PROXY_REWRITE: '1',
        });

        expect(proxy?.url.href).toBe('http://localhost:7890/');
        expect(proxy?.rewrittenForWsl).toBe(false);
    });

    it('honors NO_PROXY for matching API targets', () => {
        const proxy = resolveProxyForUrl('https://api.example.com/v1/chat/completions', {
            HTTPS_PROXY: 'http://proxy.example.test:7890',
            NO_PROXY: 'api.example.com',
        });

        expect(proxy).toBe(null);
    });
});

summary();
