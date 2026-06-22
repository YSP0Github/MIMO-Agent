/**
 * Shared helpers for the chat message surface.
 */

export interface EditedFileInfo {
    path: string;
    action: string;
    added: number;
    removed: number;
}

export interface WorkflowUiState {
    card: HTMLElement;
    phases: Array<{ title: string; mode: string; tasks: Array<{ label: string; result?: any }> }>;
    totalTasks: number;
    completedTasks: number;
    startedAt: number;
    lastRenderedAt: number;
    ended: boolean;
}

export function formatTokenCount(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

function isNearBottom(el: HTMLElement, threshold = 120): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

let pendingScrollFrame = 0;
let pendingScrollTarget: HTMLElement | null = null;

export function smartScroll(el: HTMLElement): void {
    pendingScrollTarget = el;
    if (pendingScrollFrame) return;
    pendingScrollFrame = requestAnimationFrame(() => {
        pendingScrollFrame = 0;
        const target = pendingScrollTarget;
        pendingScrollTarget = null;
        if (!target) return;
        if (isNearBottom(target)) {
            target.scrollTop = target.scrollHeight;
        }
    });
}

export function setLazyToolOutput(el: HTMLElement, text: string): void {
    const limit = 1200;
    if (text.length <= limit) {
        el.textContent = text;
        return;
    }
    const preview = text.slice(0, limit);
    el.textContent = `${preview}\n\n... output truncated in view (${text.length} chars). Click to load full output.`;
    el.classList.add('lazy-tool-output');
    let loaded = false;
    el.addEventListener('click', () => {
        if (loaded) return;
        el.textContent = text;
        loaded = true;
        el.classList.remove('lazy-tool-output');
    });
}
