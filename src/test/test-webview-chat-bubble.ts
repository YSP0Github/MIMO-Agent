import { describe, it, expect } from './test-runner';
import { isRenderableImageDataUrl } from '../webview/components/messages/ChatBubble';
import { sanitizeReasoningForDisplay, sanitizeReasoningForHistoryDisplay } from '../webview/components/messages/ThinkingBlock';
import { renderFriendlyErrorHtml } from '../webview/components/friendlyError';
import { renderTaskChecklist } from '../webview/components/taskChecklist';
import { smartScroll } from '../webview/components/messages/shared';

describe('webview chat bubble image handling', () => {
    it('accepts safe image data URLs for inline previews', () => {
        expect(isRenderableImageDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
        expect(isRenderableImageDataUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg==')).toBe(true);
        expect(isRenderableImageDataUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(true);
    });

    it('rejects persisted image placeholders and unsafe URLs', () => {
        expect(isRenderableImageDataUrl('[large image omitted from VS Code state; full image is kept in MiMo history]')).toBe(false);
        expect(isRenderableImageDataUrl('https://example.test/image.png')).toBe(false);
        expect(isRenderableImageDataUrl('javascript:alert(1)')).toBe(false);
    });

    it('hides long internal reasoning drafts from the thinking display', () => {
        const raw = [
            '[Role: 解决方案架构师] [意图: refactor]',
            'The user wants a cinematic fighter jet animation. Actually, I should plan the fuselage coordinates.',
            'Here is my plan: draw canvas layers, afterburner particles, then write HTML.',
            '<!DOCTYPE html><html><head><style>canvas{width:100%}</style></head><body><script>const ctx = canvas.getContext("2d"); function draw(){}</script></body></html>',
        ].join('\n').repeat(8);

        const display = sanitizeReasoningForDisplay(raw);
        expect(display).toContain('已隐藏详细思考内容');
        expect(display.includes('reasoning_content')).toBe(false);
        expect(display).toContain('[Role: 解决方案架构师]');
        expect(display.includes('<!DOCTYPE html>')).toBe(false);
        expect(display.includes('fuselage coordinates')).toBe(false);
    });

    it('keeps saved reasoning readable in history display', () => {
        const raw = [
            '[Role: 解决方案架构师] [意图: refactor]',
            'The user wants a cinematic fighter jet animation. Actually, I should plan the fuselage coordinates.',
            'Here is my plan: draw canvas layers, afterburner particles, then write HTML.',
            '<!DOCTYPE html><html><head><style>canvas{width:100%}</style></head><body><script>const ctx = canvas.getContext("2d"); function draw(){}</script></body></html>',
        ].join('\n').repeat(8);

        const display = sanitizeReasoningForHistoryDisplay(raw);
        expect(display).toContain('fuselage coordinates');
        expect(display.includes('已隐藏详细思考内容')).toBe(false);
        expect(display.includes('reasoning_content')).toBe(false);
    });

    it('hides todo priority badges when every item has the same priority', () => {
        const html = renderTaskChecklist([
            { text: 'Inspect files', done: false, priority: 'P1' },
            { text: 'Apply change', done: false, priority: 'P1' },
        ]);

        expect(html.includes('todo-priority')).toBe(false);
        expect(html.includes('P1')).toBe(false);
    });

    it('shows todo priority badges only when priorities differ', () => {
        const html = renderTaskChecklist([
            { text: 'Fix blocking issue', done: false, priority: 'P1' },
            { text: 'Optional cleanup', done: false, priority: 'P3' },
        ]);

        expect(html.includes('todo-priority')).toBe(true);
        expect(html.includes('P1')).toBe(true);
        expect(html.includes('P3')).toBe(true);
    });

    it('avoids duplicating flattened task status text in friendly error cards', () => {
        const raw = 'Task status: task interrupted by API or runtime error Goal: 请继续完成上一条回复中未完成的任务，避免重复已经完成的步骤。 Completed tool calls: 17 Progress: round 1 (unlimited budget) Soft budget: unlimited Latest model output: 现在我已经充分理解了两个文件的内容。让我直接创建 markdown 文件： Next action: continue from the latest changed files or ask the model to verify and finalize. MiMo API 返回 400：生成参数不符合要求。 问题归因：更可能是 Agent 请求构造、参数配置或多轮协议拼接问题，不是大模型推理能力问题。 原因：请求 JSON、参数范围、模型名、消息格式或多模态输入不符合 MiMo API 要求。 建议：检查 JSON 格式、必需参数、参数范围和消息结构；确认模型名存在，并且当前接口支持该模型和图像/多模态输入。';
        const html = renderFriendlyErrorHtml(raw);

        expect(html.includes('friendly-error-title">MiMo API 返回 400')).toBe(true);
        expect(html.includes('friendly-error-label">Task Status<')).toBe(true);
        expect((html.match(/friendly-error-label">Task Status</g) || []).length).toBe(1);
        expect(html.includes('friendly-error-title">Task status: task interrupted by API or runtime error')).toBe(false);
    });
});

describe('webview performance guards', () => {
    it('coalesces smartScroll calls onto the latest target', () => {
        let rafCallback: ((time: number) => void) | null = null;
        (globalThis as any).requestAnimationFrame = (cb: (time: number) => void) => {
            rafCallback = cb;
            return 1;
        };

        const a = { scrollHeight: 1000, scrollTop: 890, clientHeight: 100 } as any;
        const b = { scrollHeight: 500, scrollTop: 390, clientHeight: 100 } as any;

        smartScroll(a);
        smartScroll(b);
        if (rafCallback) {
            (rafCallback as any)(0);
        }

        expect(a.scrollTop).toBe(890);
        expect(b.scrollTop).toBe(500);
    });
});
