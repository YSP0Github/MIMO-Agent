/**
 * Messages component - chat messages, streaming, tool cards, diff view, thinking blocks.
 */
import { store, ImageData } from '../core/store';
import { bus } from '../core/bus';
import { vscode } from '../core/vscode';
import { escapeHtml, createElement } from '../utils/dom';
import { getWelcomePair, t } from '../core/i18n';
import { renderTaskChecklist, TodoItem } from './taskChecklist';
import {
    EditedFileInfo as MessageEditedFileInfo,
    WorkflowUiState as MessageWorkflowUiState,
    computeDiff as computeMessageDiff,
    createDiffCard as createMessageDiffCard,
    createExecuteCommandCard,
    createToolLine,
    createUserBubble,
    enhanceTaskChecklists as enhanceMessageTaskChecklists,
    filterReasoningNoise as filterMessageReasoningNoise,
    formatTokenCount as formatMessageTokenCount,
    getFileLink as getMessageFileLink,
    getFilePath as getMessageFilePath,
    getLineInfo as getMessageLineInfo,
    getToolColor as getMessageToolColor,
    getToolLabel as getMessageToolLabel,
    buildRichMessageClipboardPayload,
    installUserBubbleCollapse,
    reasoningStoreLimit,
    renderEditDiff as renderMessageEditDiff,
    renderGitDiff as renderMessageGitDiff,
    sanitizeReasoningForHistoryDisplay as sanitizeMessageReasoningForHistoryDisplay,
    sanitizeReasoningForDisplay as sanitizeMessageReasoningForDisplay,
    renderThinkingBlock as renderMessageThinkingBlock,
    setCopyButtonState as setMessageCopyButtonState,
    setLazyToolOutput as setMessageLazyToolOutput,
    setupCodeBlockCopy,
    smartScroll as smartMessageScroll,
    stripRawToolCalls as stripMessageRawToolCalls,
    dedupReasoning as dedupMessageReasoning,
    toolIcon as messageToolIcon,
    toolSummary as messageToolSummary,
    writeClipboardPayload,
} from './messages/index';

// Helpers

function formatTokenCount(n: number): string {
    return formatMessageTokenCount(n);
}

/**
 * Smart auto-scroll: only scroll to bottom if user is already near the bottom.
 * If user has scrolled up to read earlier content, leave their position alone.
 */
function isNearBottom(el: HTMLElement, threshold = 120): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}
let pendingScrollFrame = 0;
function smartScroll(el: HTMLElement): void {
    smartMessageScroll(el);
}

function copyIconMarkup(): string {
    return '<span class="copy-icon" aria-hidden="true"></span>';
}

function setCopyButtonState(btn: HTMLElement, copied: boolean): void {
    setMessageCopyButtonState(btn, copied);
}

function copyTextToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(ta);
    return Promise.resolve();
}

function extractBubbleClipboardPayload(bubble: HTMLElement): { text: string; html?: string; primaryImageDataUrl?: string } {
    const text = Array.from(bubble.querySelectorAll<HTMLElement>('.text-content'))
        .map(el => el.textContent || '')
        .filter(Boolean)
        .join('\n');
    const images = Array.from(bubble.querySelectorAll<HTMLImageElement>('.msg-img'))
        .map((img, index) => ({
            dataUrl: img.getAttribute('src') || '',
            name: img.getAttribute('title') || img.getAttribute('alt') || `image-${index + 1}`,
        }));
    return buildRichMessageClipboardPayload(text, images);
}

function assistantActionIcon(action: string): string {
    const attrs = 'class="assistant-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"';
    if (action === 'retry') {
        return `<svg ${attrs}><path d="M13.2 5.2A5.5 5.5 0 1 0 14 8" /><path d="M13.2 2.5v2.7h-2.7" /></svg>`;
    }
    if (action === 'continue') {
        return `<svg ${attrs}><path d="M4 3.5l5 4.5-5 4.5" /><path d="M10.5 4v8" /></svg>`;
    }
    if (action === 'feedback') {
        return `<svg ${attrs}><path d="M8 2.2v6.4" /><circle cx="8" cy="13.1" r="1.05" fill="currentColor" stroke="none" /></svg>`;
    }
    if (action === 'copied') {
        return `<svg ${attrs}><path d="M3.2 8.4l3 3L12.8 4.8" /></svg>`;
    }
    return `<svg ${attrs}><rect x="5" y="3" width="8" height="10" rx="1.4" /><path d="M3 11V5.2C3 4.5 3.5 4 4.2 4H10" /></svg>`;
}

const REASONING_PREVIEW_CHARS = 360;
const REASONING_STORE_CHARS = 4000;
const REASONING_DEDUP_INTERVAL_MS = 3000;
const WORKFLOW_UPDATE_INTERVAL_MS = 400;
const HISTORY_SNAPSHOT_MAX_HTML = 700_000;
const HISTORY_PATCH_MAX_CHARS = 500_000;
const QUEUE_VISIBLE_ITEMS = 3;
const TASK_CHANGES_VISIBLE_FILES = 3;

interface EditedFileInfo {
    path: string;
    action: string;
    added: number;
    removed: number;
}

interface TaskChangeFile {
    path: string;
    added: number;
    removed: number;
    binary?: boolean;
    staged?: boolean;
    source?: 'git' | 'tool';
    action?: string;
    hasToolDiff?: boolean;
    toolDiff?: string;
}

interface TaskChangeSummary {
    id: string;
    files: TaskChangeFile[];
    totalAdded: number;
    totalRemoved: number;
    patch: string;
    createdAt: number;
    canUndo?: boolean;
    warning?: string;
}

interface TaskChangePatchEntry {
    filePath: string;
    patch: string;
}

interface HistoryTaskChangeSnapshot {
    gitPatch: string;
    toolPatches: TaskChangePatchEntry[];
}

interface ParsedTaskChangeContent {
    before: string;
    after: string;
}

function countUnifiedDiffChanges(patch: string): { added: number; removed: number } {
    const text = String(patch || '').trim();
    if (!text) return { added: 0, removed: 0 };

    let added = 0;
    let removed = 0;
    for (const line of text.split('\n')) {
        if (
            line.startsWith('diff --git') ||
            line.startsWith('index ') ||
            line.startsWith('--- ') ||
            line.startsWith('+++ ') ||
            line.startsWith('@@ ')
        ) {
            continue;
        }
        if (line.startsWith('+')) {
            added++;
        } else if (line.startsWith('-')) {
            removed++;
        }
    }
    return { added, removed };
}

function splitUnifiedDiffByFile(patch: string): TaskChangePatchEntry[] {
    const text = String(patch || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];

    const entries: TaskChangePatchEntry[] = [];
    const lines = text.split('\n');
    let current: string[] = [];
    let currentFile = '';

    const flush = () => {
        const body = current.join('\n').trim();
        if (!body) return;
        entries.push({
            filePath: currentFile || `changes-${entries.length + 1}`,
            patch: body,
        });
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flush();
            current = [line];
            const match = line.match(/ b\/(.+)$/);
            currentFile = match?.[1] || '';
            continue;
        }
        current.push(line);
        if (!currentFile && line.startsWith('+++ ')) {
            currentFile = line.replace(/^\+\+\+\s+(?:b\/)?/, '').trim();
        }
    }
    flush();

    if (entries.length > 0) return entries;
    return [{ filePath: 'changes', patch: text }];
}

function buildTaskChangePreviewDocument(_title: string, entries: TaskChangePatchEntry[]): string {
    const content = entries
        .map(entry => String(entry.patch || '').trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
    return content ? `${content}\n` : '';
}

function parseUnifiedDiffToContent(patch: string): ParsedTaskChangeContent | null {
    const text = String(patch || '').replace(/\r\n/g, '\n').trim();
    if (!text) return null;

    const lines = text.split('\n');
    const before: string[] = [];
    const after: string[] = [];
    let sawHunk = false;

    for (const line of lines) {
        if (line.startsWith('@@ ')) {
            sawHunk = true;
            continue;
        }
        if (!sawHunk) continue;
        if (line === '\\ No newline at end of file') continue;
        if (line.startsWith('+') && !line.startsWith('+++')) {
            after.push(line.slice(1));
            continue;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            before.push(line.slice(1));
            continue;
        }
        if (line.startsWith(' ')) {
            const content = line.slice(1);
            before.push(content);
            after.push(content);
        }
    }

    if (!sawHunk) return null;
    return {
        before: before.join('\n'),
        after: after.join('\n'),
    };
}

function escapeHtmlPreservingBreaks(text: string): string {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function extractErrorCode(text: string): string {
    const match = String(text || '').match(/\b(400|401|402|403|404|421|429|500|503)\b/);
    return match?.[1] || '';
}

function looksLikeConfigOrApiError(text: string): boolean {
    const value = String(text || '');
    const hasProviderSignal = /MiMo API|Authentication failed|API Key|Base URL|task interrupted by API or runtime error|invalid api key|unauthorized|forbidden|rate limit|service unavailable|status code|http(?:\s+error)?/i.test(value);
    const hasErrorSignal = /\berror\b|\bfailed\b|\bfailure\b|\bexception\b|\binvalid\b|\bunauthorized\b|\bforbidden\b|\bunavailable\b|\brate limit\b|^failed:/i.test(value) || !!extractErrorCode(value);
    return hasProviderSignal && hasErrorSignal;
}

function extractPlainTextFromHtml(html: string): string {
    const host = document.createElement('div');
    host.innerHTML = html;
    return (host.textContent || '').trim();
}

function isRichErrorHtmlCandidate(html: string): boolean {
    return !/<(?:table|ul|ol|pre|code|details|blockquote|img|button|input|svg)\b/i.test(html);
}

function renderFriendlyErrorHtml(text: string): string {
    const raw = String(text || '').trim();
    if (!raw) return '';

    const code = extractErrorCode(raw);
    const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const title = lines[0] || 'API / runtime error';
    const sections: string[] = [];

    const collectSection = (label: string) =>
        lines
            .map(line => {
                if (line.startsWith(`${label}:`)) return line.slice(label.length + 1).trim();
                if (line.startsWith(`${label}\uFF1A`)) return line.slice(label.length + 1).trim();
                return '';
            })
            .filter(Boolean);

    const reasons = [...collectSection('问题归因'), ...collectSection('原因')];
    const suggestions = collectSection('建议')
        .flatMap(item => item.split(/[；;]/))
        .map(item => item.trim())
        .filter(Boolean);
    const nextActions = collectSection('Next action');
    const taskStatus = collectSection('Task status');

    if (taskStatus.length) {
        sections.push(
            `<div class="friendly-error-section">` +
            `<div class="friendly-error-label">Task Status</div>` +
            `<div class="friendly-error-text">${escapeHtmlPreservingBreaks(taskStatus.join('\n'))}</div>` +
            `</div>`
        );
    }
    if (reasons.length) {
        sections.push(
            `<div class="friendly-error-section">` +
            `<div class="friendly-error-label">原因</div>` +
            `<div class="friendly-error-text">${escapeHtmlPreservingBreaks(reasons.join('\n'))}</div>` +
            `</div>`
        );
    }
    if (suggestions.length) {
        sections.push(
            `<div class="friendly-error-section">` +
            `<div class="friendly-error-label">建议</div>` +
            `<ul class="friendly-error-list">${suggestions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` +
            `</div>`
        );
    }
    if (nextActions.length) {
        sections.push(
            `<div class="friendly-error-section">` +
            `<div class="friendly-error-label">Next Action</div>` +
            `<div class="friendly-error-text">${escapeHtmlPreservingBreaks(nextActions.join('\n'))}</div>` +
            `</div>`
        );
    }

    const consumed = new Set<string>([
        ...taskStatus.map(v => `Task status: ${v}`),
        ...reasons,
        ...suggestions,
        ...nextActions.map(v => `Next action: ${v}`),
    ]);
    const sectionLabels = ['\u95ee\u9898\u5f52\u56e0', '\u539f\u56e0', '\u5efa\u8bae', 'Next action', 'Task status'];
    const leftovers = lines.filter(line => {
        let normalized = line.trim();
        for (const label of sectionLabels) {
            if (normalized.startsWith(`${label}:`)) {
                normalized = normalized.slice(label.length + 1).trim();
                break;
            }
            if (normalized.startsWith(`${label}\uFF1A`)) {
                normalized = normalized.slice(label.length + 1).trim();
                break;
            }
        }
        return normalized && !consumed.has(normalized) && !consumed.has(line);
    });

    return (
        `<div class="friendly-error-card">` +
        `<div class="friendly-error-head">` +
        `<span class="friendly-error-badge">API / Runtime Error</span>` +
        (code ? `<span class="friendly-error-code">Error ${escapeHtml(code)}</span>` : '') +
        `</div>` +
        `<div class="friendly-error-title">${escapeHtml(title)}</div>` +
        (sections.length ? sections.join('') : `<div class="friendly-error-text">${escapeHtmlPreservingBreaks(raw)}</div>`) +
        (leftovers.length
            ? `<details class="friendly-error-raw"><summary>原始信息</summary><pre>${escapeHtml(leftovers.join('\n'))}</pre></details>`
            : '') +
        `</div>`
    );
}

function formatAssistantBodyHtml(rawHtml: string): string {
    const sanitizedHtml = enhanceMessageTaskChecklists(stripMessageRawToolCalls(rawHtml || ''));
    const plainText = extractPlainTextFromHtml(sanitizedHtml);
    if (plainText && isRichErrorHtmlCandidate(sanitizedHtml) && looksLikeConfigOrApiError(plainText)) {
        return renderFriendlyErrorHtml(plainText);
    }
    return sanitizedHtml;
}

interface WorkflowUiState {
    card: HTMLElement;
    phases: Array<{ title: string; mode: string; tasks: Array<{ label: string; result?: any }> }>;
    totalTasks: number;
    completedTasks: number;
    startedAt: number;
    lastRenderedAt: number;
    ended: boolean;
}

// Tool card helpers

const TOOL_ICONS: Record<string, string> = {
    schedule_tasks: 'SC',
    update_todos: 'TD',
    read_file: 'R', write_file: 'W', edit_file: 'E', list_directory: 'L',
    search_files: 'S', execute_command: '$', fetch_url: 'U', glob_files: 'G',
    delete_file: 'D', move_file: 'M', copy_file: 'C', get_file_info: 'I',
    git_status: 'GS', git_diff: 'GD', git_log: 'GL', git_commit: 'GC',
    git_push: 'GP', git_pull: 'GU', web_search: 'WS',
    browser_open: 'BO', browser_click: 'BC', browser_type: 'BT',
    browser_screenshot: 'BS', browser_get_content: 'BG', browser_close: 'BX',
    spawn_subagent: 'SA', run_workflow: 'WF', git_worktree_add: 'WA', git_worktree_list: 'WL',
    git_worktree_remove: 'WR', read_notebook: 'NR', edit_notebook_cell: 'NE',
    insert_notebook_cell: 'NI', delete_notebook_cell: 'ND',
    desktop_screenshot: 'DS', desktop_windows: 'DW', desktop_focus: 'DF',
    desktop_type: 'DT', desktop_key: 'DK', desktop_click: 'DC',
    desktop_mouse_move: 'DM', desktop_drag: 'DD', desktop_launch: 'DL',
};

const READONLY_TOOLS = new Set([
    'read_file', 'list_directory', 'glob_files', 'search_files',
    'get_file_info', 'git_status', 'git_diff', 'git_log', 'web_search',
    'git_worktree_list', 'read_notebook',
]);

function toolIcon(name: string): string {
    return messageToolIcon(name);
}

function toolSummary(name: string, args: any): string {
    return messageToolSummary(name, args);
}

export const Messages = {
    mount(): void {
        const messagesDiv = document.getElementById('messages');
        if (!messagesDiv) return;

        // Single sticky prompt bar. User cards stay in normal flow; only a cloned
        // preview sticks to the top, which avoids stacked cards and leakage.
        const stickyPrompt = createElement('div', 'sticky-user-preview hidden');
        stickyPrompt.setAttribute('aria-hidden', 'true');
        messagesDiv.prepend(stickyPrompt);
        let lastStickySource: HTMLElement | null = null;
        let stickyFrame = 0;
        let stickyResizeObserver: ResizeObserver | null = null;

        const setStickySource = (source: HTMLElement | null) => {
            if (source === lastStickySource) return;
            lastStickySource?.classList.remove('is-sticky-source');
            lastStickySource = source;

            if (!source) {
                stickyPrompt.classList.add('hidden');
                stickyPrompt.replaceChildren();
                messagesDiv.style.removeProperty('--sticky-user-height');
                stickyResizeObserver?.disconnect();
                stickyResizeObserver = null;
                return;
            }

            source.classList.add('is-sticky-source');
            const clone = source.cloneNode(true) as HTMLElement;
            clone.className = 'msg msg-user sticky-user-clone';
            clone.querySelectorAll('button').forEach(btn => btn.remove());
            const sourceCopy = source.querySelector('.msg-copy') as HTMLButtonElement | null;
            const copyBtn = createElement('button', 'msg-copy sticky-copy') as HTMLButtonElement;
            setCopyButtonState(copyBtn, false);
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                sourceCopy?.click();
                setCopyButtonState(copyBtn, true);
                window.setTimeout(() => setCopyButtonState(copyBtn, false), 1400);
            });
            clone.appendChild(copyBtn);
            if (source.classList.contains('collapsible')) {
                const expandBtn = createElement('button', 'expand-toggle sticky-expand') as HTMLButtonElement;
                const syncExpandLabel = () => {
                    expandBtn.textContent = source.classList.contains('expanded') ? '鏀惰捣' : '灞曞紑';
                    clone.classList.toggle('expanded', source.classList.contains('expanded'));
                };
                syncExpandLabel();
                expandBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const original = source.querySelector('.expand-toggle') as HTMLButtonElement | null;
                    if (original) original.click();
                    else source.classList.toggle('expanded');
                    syncExpandLabel();
                    requestAnimationFrame(syncHeight);
                });
                clone.appendChild(expandBtn);
                clone.classList.add('collapsible');
            }
            stickyPrompt.replaceChildren(clone);
            stickyPrompt.classList.remove('hidden');
            const syncHeight = () => {
                const height = clone.offsetHeight || stickyPrompt.scrollHeight || stickyPrompt.offsetHeight;
                messagesDiv.style.setProperty('--sticky-user-height', `${Math.ceil(height)}px`);
            };
            requestAnimationFrame(syncHeight);
            stickyResizeObserver?.disconnect();
            if (typeof ResizeObserver !== 'undefined') {
                stickyResizeObserver = new ResizeObserver(syncHeight);
                stickyResizeObserver.observe(stickyPrompt);
            }
        };

        const updateStickyPrompt = () => {
            stickyFrame = 0;
            const userMsgs = Array.from(messagesDiv.querySelectorAll('.msg-user:not(.sticky-user-clone)')) as HTMLElement[];
            if (userMsgs.length === 0) {
                setStickySource(null);
                return;
            }

            const containerTop = messagesDiv.getBoundingClientRect().top;
            let active: HTMLElement | null = null;
            for (const msg of userMsgs) {
                const rect = msg.getBoundingClientRect();
                if (rect.top <= containerTop + 2) active = msg;
                if (rect.top > containerTop + 2) break;
            }

            const last = userMsgs[userMsgs.length - 1];
            if (active && active === last && last.getBoundingClientRect().top > containerTop - 2) {
                active = null;
            }
            setStickySource(active);
        };

        const scheduleStickyPromptUpdate = () => {
            if (stickyFrame) return;
            const streamingActive = !!store.get('streamingMsg');
            const delay = streamingActive ? 250 : 0;
            window.setTimeout(() => {
                if (stickyFrame) return;
                stickyFrame = requestAnimationFrame(updateStickyPrompt);
            }, delay);
        };

        messagesDiv.addEventListener('scroll', scheduleStickyPromptUpdate, { passive: true });
        new MutationObserver((mutations) => {
            const shouldUpdate = mutations.some((mutation) =>
                Array.from(mutation.addedNodes).some((node) =>
                    node instanceof HTMLElement &&
                    (node.classList.contains('msg-user') || node.classList.contains('msg-assistant') || node.classList.contains('msg-error'))
                )
            );
            if (shouldUpdate) scheduleStickyPromptUpdate();
        }).observe(messagesDiv, { childList: true });
        requestAnimationFrame(updateStickyPrompt);

        // Copy buttons (event delegation for both fresh and history-rendered messages)
        messagesDiv.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;

            const msgCopyBtn = target.closest('.msg-copy') as HTMLElement | null;
            if (msgCopyBtn) {
                e.stopPropagation();
                const bubble = msgCopyBtn.closest('.msg');
                if (!(bubble instanceof HTMLElement)) return;
                const payload = extractBubbleClipboardPayload(bubble);
                writeClipboardPayload(payload).then(() => {
                    setCopyButtonState(msgCopyBtn, true);
                    setTimeout(() => setCopyButtonState(msgCopyBtn, false), 1600);
                }).catch(() => {});
                return;
            }

            const btn = target.closest('.copy-btn') as HTMLElement | null;
            if (!btn) return;
            const block = btn.closest('.code-block');
            if (!block) return;
            const code = block.querySelector('code');
            if (!code) return;
            const text = code.textContent || '';
            navigator.clipboard.writeText(text).then(() => {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
            }).catch(() => {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); } catch { /* ignore */ }
                document.body.removeChild(ta);
            });
        });

        // Tool card expand/collapse (event delegation)
        messagesDiv.addEventListener('click', (e) => {
            const header = (e.target as HTMLElement).closest('.tool-header');
            if (header) {
                const card = header.closest('.tool-card');
                if (card) card.classList.toggle('expanded');
            }

            // URL link click 鈫?open in browser
            const link = (e.target as HTMLElement).closest('a.url-link') as HTMLAnchorElement | null;
            if (link && link.href) {
                e.preventDefault();
                e.stopPropagation();
                vscode.post({ type: 'openUrl', url: link.href });
            }

            const fileLink = (e.target as HTMLElement).closest('a.file-link') as HTMLAnchorElement | null;
            const filePath = fileLink?.dataset.file;
            if (fileLink && filePath) {
                e.preventDefault();
                e.stopPropagation();
                const line = Number(fileLink.dataset.line || 1);
                vscode.post({ type: 'openFile', path: filePath, line: Number.isFinite(line) ? line : 1 });
            }

            const actionBtn = (e.target as HTMLElement).closest('.assistant-action-btn') as HTMLButtonElement | null;
            if (actionBtn) {
                e.preventDefault();
                e.stopPropagation();
                this.handleAssistantAction(actionBtn);
            }
        });

        // Listen for messages from host
        bus.on('userMessage', (text: string, images?: ImageData[] | null) => this.addUserMessage(text, images));
        bus.on('streamHtml', (html: string, lightweight?: boolean) => this.handleStream(html, !!lightweight));
        bus.on('assistantUpdate', (html: string) => this.handleAssistantUpdate(html));
        bus.on('verificationUpdate', (html: string) => this.handleVerificationUpdate(html));
        bus.on('finalAnswer', (html: string) => this.handleFinalAnswer(html));
        bus.on('streamSegmentEnd', () => this.commitStreamSegment());
        bus.on('reasoning', (token: string) => this.handleReasoning(token));
        bus.on('toolCallStart', (name: string, args: any) => this.addToolCard(name, args));
        bus.on('toolCallEnd', (name: string, result: string, isError: boolean, elapsed: number, gitDiff?: string) => this.handleToolCallEnd(name, result, isError, elapsed, gitDiff));
        bus.on('roundStart', (round: number) => this.handleRoundStart(round));
        bus.on('done', (_response?: string, elapsedSec?: number) => this.handleDone(elapsedSec));
        bus.on('error', (error: string) => this.handleError(error));
        bus.on('system', (text: string) => this.addSystemMessage(text));
        bus.on('clearMessages', () => this.clearMessages());
        bus.on('historyRender', (turns: any[]) => this.renderHistoryTurns(turns));
        bus.on('welcomeUpdate', (desc: string, hint: string) => this.updateWelcome(desc, hint));
        bus.on('tokenUsage', (usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => this.handleTokenUsage(usage));
        bus.on('conversationUsage', (usage: { totalTokens: number; callCount: number }) => this.handleConversationUsage(usage));
        bus.on('editPreview', (
            previewId: string,
            path: string,
            oldText: string,
            newText: string,
            matchCount: number,
            lineStart?: number,
            lineEnd?: number,
        ) => this.renderEditPreviewCard(previewId, path, oldText, newText, matchCount, lineStart, lineEnd));
        bus.on('writePreview', (previewId: string, filePath: string, content: string, isCreate: boolean, oldText?: string) => this.renderWritePreviewCard(previewId, filePath, content, isCreate, oldText));
        // Workflow events
        bus.on('workflowStart', (totalPhases: number, totalTasks: number) => this.handleWorkflowStart(totalPhases, totalTasks));
        bus.on('workflowPhaseStart', (pi: number, title: string, mode: string, tc: number) => this.handleWorkflowPhaseStart(pi, title, mode, tc));
        bus.on('workflowTaskStart', (pi: number, ti: number, label: string) => this.handleWorkflowTaskStart(pi, ti, label));
        bus.on('workflowTaskEnd', (pi: number, ti: number, result: any) => this.handleWorkflowTaskEnd(pi, ti, result));
        bus.on('workflowPhaseEnd', (pi: number, result: any) => this.handleWorkflowPhaseEnd(pi, result));
        bus.on('workflowEnd', (result: any) => this.handleWorkflowEnd(result));
        this.removeExecutionMetaChips(document);
        // Adversarial mode events
        bus.on('adversarialTurn', (persona: string, name: string, icon: string, phase: string, content: string, iteration: number) => this.handleAdversarialTurn(persona, name, icon, phase, content, iteration));
        bus.on('adversarialToolStart', (persona: string, toolName: string, args: any) => this.handleAdversarialToolStart(persona, toolName, args));
        bus.on('adversarialToolEnd', (persona: string, toolName: string, result: string, isError: boolean, elapsed: number) => this.handleAdversarialToolEnd(persona, toolName, result, isError, elapsed));
        // Plan mode
        bus.on('planReady', (planContent?: string, planPath?: string) => this.showPlanConfirm(planContent, planPath));
        // Ask user interactive dialog
        bus.on('askUser', (previewId: string, question: string, options: string[]) => this.renderAskUserCard(previewId, question, options));
        bus.on('stopGuard', (info: any) => this.renderStopGuardCard(info));
        bus.on('taskChanges', (summary: TaskChangeSummary) => this.renderTaskChangesCard(summary));
        // Message queue
        bus.on('messageQueued', (text: string, queueLength: number) => this.showQueuedMessage(text, queueLength));
        bus.on('queueProcessed', (remaining: number) => this.updateQueueDisplay(remaining));
        bus.on('clearQueue', () => this.clearQueueDisplay());
        bus.on('langChanged', () => {
            this.localizeQueueDisplay();
            this.localizeTaskChangesDisplay();
            this.localizeAssistantActions();
        });
        bus.on('renderFlush', () => smartScroll(messagesDiv));
        bus.on('fileOpenResult', (msg: any) => this.handleFileOpenResult(msg));
    },

    // User message
    addUserMessage(text: string, images?: ImageData[] | null): void {
        const messagesDiv = document.getElementById('messages')!;
        this.archiveAssistantActions();
        store.set('lastUserMsg', { text, images: images || null });
        store.set('currentTurnStartedAt', Date.now());

        const delegatedBubble = createUserBubble(text, images, 'msg msg-user');
        const hasDelegatedVisibleMessages = Array.from(messagesDiv.children)
            .some(child => !(child as HTMLElement).classList.contains('sticky-user-preview'));
        if (hasDelegatedVisibleMessages) {
            delegatedBubble.style.marginTop = '20px';
        }
        messagesDiv.appendChild(delegatedBubble);
        smartScroll(messagesDiv);
        installUserBubbleCollapse(delegatedBubble, images, text);
        store.set('streamingMsg', null);
        store.set('rawHtml', '');
    },

    // Thinking block lifecycle
    /** Mark all active (not done) thinking dots as completed. */
    _markThinkingDone(): void {
        const dots = document.querySelectorAll('.thinking-dot:not(.done)');
        for (let i = 0; i < dots.length; i++) {
            dots[i].classList.add('done');
            const lbl = dots[i].parentElement?.querySelector('span:nth-child(2)') as HTMLElement | null;
            if (lbl) lbl.textContent = t('thought');
            // Show the toggle when thinking is finalized
            const toggle = dots[i].parentElement as HTMLElement | null;
            const block = toggle?.nextElementSibling as HTMLElement | null;
            if (block?.classList.contains('thinking-block')) {
                (block as any)._thinkingDone = true;
                // Keep completed thoughts collapsed and cheap. Rendering the full
                // text here blocks the webview right when the turn is finishing.
                this.renderThinkingBlock(block, false);
                block.classList.remove('show');
                toggle?.classList.remove('open');
            }
            if (toggle) {
                toggle.style.display = '';
                const parent = toggle.closest('.msg-assistant') as HTMLElement | null;
                if (parent) (parent as any)._activeThinkingBlock = null;
            }
        }
    },

    // Streaming
    handleStream(html: string, lightweight = false): void {
        const messagesDiv = document.getElementById('messages')!;
        let streamingMsg = store.get('streamingMsg');

        if (!streamingMsg) {
            streamingMsg = this.createAssistantMsg();
            const mc = createElement('div', 'md-content');
            streamingMsg.appendChild(mc);
            store.set('streamingMsg', streamingMsg);
            store.set('rawHtml', '');
        }

        // Remove spinner
        const sp = streamingMsg.querySelector('.spinner');
        if (sp) sp.remove();

        // NOTE: Do NOT mark thinking as done here.
        // Thinking blocks should only be finalized when:
        //   1. A tool call starts (addToolCard)
        //   2. The response is done (handleDone)
        //   3. An error occurs (handleError)
        // Marking thinking done in handleStream causes a single continuous
        // thought to be split into multiple blocks when content tokens arrive
        // before the next round's reasoning tokens.

        store.set('rawHtml', html);
        let el = streamingMsg.querySelector('.md-content:not([data-stream-finalized="true"])') as HTMLElement | null;
        if (!el) {
            el = createElement('div', 'md-content');
            streamingMsg.appendChild(el);
        }
        if ((el as any)._lastStreamHtml === html) return;
        (el as any)._lastStreamHtml = html;
        el.innerHTML = lightweight ? stripMessageRawToolCalls(html || '') : formatAssistantBodyHtml(html);
        smartScroll(messagesDiv);
    },

    commitStreamSegment(): void {
        const streamingMsg = store.get('streamingMsg');
        if (!streamingMsg) return;
        const el = streamingMsg.querySelector('.md-content:not([data-stream-finalized="true"])') as HTMLElement | null;
        if (!el) return;
        if (!el.textContent?.trim() && !el.querySelector('*')) {
            el.remove();
            return;
        }
        el.setAttribute('data-stream-finalized', 'true');
        el.classList.add('md-content-final');
        store.set('rawHtml', '');
    },

    // Enhance task checklists
    upsertVerificationSegment(html: string): void {
        const messagesDiv = document.getElementById('messages')!;
        let streamingMsg = store.get('streamingMsg');
        if (!streamingMsg) {
            streamingMsg = this.createAssistantMsg();
            store.set('streamingMsg', streamingMsg);
            store.set('rawHtml', '');
        }
        const nextHtml = formatAssistantBodyHtml(html || '');
        const existing = streamingMsg.querySelector('.md-content-verification') as HTMLElement | null;
        if (existing) {
            if ((existing as any)._lastVerificationHtml === nextHtml) return;
            (existing as any)._lastVerificationHtml = nextHtml;
            existing.innerHTML = nextHtml;
            existing.classList.add('md-content-final');
            existing.setAttribute('data-stream-finalized', 'true');
            existing.dataset.label = t('assistant.verification.followup');
            smartScroll(messagesDiv);
            return;
        }
        this.handleStream(html || '');
        this.commitStreamSegment();
        const finalized = streamingMsg.querySelector('.md-content-final:last-of-type') as HTMLElement | null;
        if (finalized) {
            finalized.classList.add('md-content-verification');
            finalized.dataset.label = t('assistant.verification.followup');
            (finalized as any)._lastVerificationHtml = finalized.innerHTML;
        }
        smartScroll(messagesDiv);
    },

    appendFixedAssistantSegment(html: string, kind: 'update' | 'verification' | 'final'): void {
        if (kind === 'verification') {
            this.upsertVerificationSegment(html);
            return;
        }
        this.handleStream(html || '');
        this.commitStreamSegment();
        const streamingMsg = store.get('streamingMsg');
        const finalized = streamingMsg?.querySelector('.md-content-final:last-of-type') as HTMLElement | null;
        if (finalized) {
            finalized.classList.add(`md-content-${kind}`);
        }
        if (kind === 'final') {
            this._markThinkingDone();
        }
        const messagesDiv = document.getElementById('messages')!;
        smartScroll(messagesDiv);
    },

    handleAssistantUpdate(html: string): void {
        this.appendFixedAssistantSegment(html, 'update');
    },

    handleVerificationUpdate(html: string): void {
        this.appendFixedAssistantSegment(html, 'verification');
    },

    handleFinalAnswer(html: string): void {
        this.appendFixedAssistantSegment(html, 'final');
    },

    enhanceTaskChecklists(html: string): string {
        return enhanceMessageTaskChecklists(html);
    },

    /**
     * Strip raw tool_call XML that the model leaked into its text response.
     * Defense-in-depth: the system prompt already forbids this, but models
     * sometimes output <tool_call> tags anyway when tool calling fails.
     */
    stripRawToolCalls(html: string): string {
        return stripMessageRawToolCalls(html);
    },

    // Reasoning/thinking
    handleReasoning(token: string): void {
        token = this.filterReasoningNoise(token);
        if (!token) return;
        let streamingMsg = store.get('streamingMsg');

        if (!streamingMsg) {
            streamingMsg = this.createAssistantMsg();
            const mc = createElement('div', 'md-content');
            streamingMsg.appendChild(mc);
            store.set('streamingMsg', streamingMsg);
            store.set('rawHtml', '');
        }

        const oldSpinner = streamingMsg.querySelector('.spinner');
        if (oldSpinner) oldSpinner.remove();

        let thinkBlock = (streamingMsg as any)._activeThinkingBlock as HTMLElement | null;
        const activeDot = thinkBlock?.previousElementSibling?.querySelector('.thinking-dot');
        if (!thinkBlock || (thinkBlock as any)._thinkingDone || activeDot?.classList.contains('done')) {
            thinkBlock = null;
        }

        if (!thinkBlock) {
            thinkBlock = createElement('div', 'thinking-block');
            (thinkBlock as any)._reasoningText = '';
            (thinkBlock as any)._reasoningTrimmed = false;
            (thinkBlock as any)._lastDedupAt = 0;
            (thinkBlock as any)._dedupedText = '';
            (thinkBlock as any)._lastRenderedText = '';
            (thinkBlock as any)._thinkingDone = false;

            const toggle = createElement('div', 'thinking-toggle');
            const dot = createElement('span', 'thinking-dot');
            toggle.appendChild(dot);
            const lbl = createElement('span');
            lbl.textContent = t('thinking');
            toggle.appendChild(lbl);
            const arrow = createElement('span', 'arrow');
            arrow.textContent = '>';
            toggle.appendChild(arrow);
            const toggleThinking = () => {
                thinkBlock!.classList.toggle('show');
                toggle.classList.toggle('open');
                this.renderThinkingBlock(thinkBlock!, thinkBlock!.classList.contains('show'));
            };
            toggle.addEventListener('click', toggleThinking);
            thinkBlock.addEventListener('click', () => {
                if (!thinkBlock!.classList.contains('show')) toggleThinking();
            });
            thinkBlock.title = t('thinking.expand.title');

            streamingMsg.appendChild(toggle);
            streamingMsg.appendChild(thinkBlock);
            const mdContent = streamingMsg.querySelector('.md-content:not([data-stream-finalized="true"])');
            if (mdContent) streamingMsg.appendChild(mdContent);
            (streamingMsg as any)._activeThinkingBlock = thinkBlock;
        }

        let nextReasoning = ((thinkBlock as any)._reasoningText || '') + token;
        if (nextReasoning.length > REASONING_STORE_CHARS) {
            nextReasoning = nextReasoning.slice(-REASONING_STORE_CHARS);
            (thinkBlock as any)._reasoningTrimmed = true;
            (thinkBlock as any)._dedupedText = '';
        }
        (thinkBlock as any)._reasoningText = nextReasoning;
        this.renderThinkingBlock(thinkBlock, false, false);
    },

    filterReasoningNoise(text: string): string {
        return filterMessageReasoningNoise(text);
    },

    renderThinkingBlock(thinkBlock: HTMLElement, forceFull = false, replayHint = false): void {
        const datasetText = thinkBlock.dataset.reasoningText || '';
        const rawText = (thinkBlock as any)._reasoningText || datasetText;
        const trimmed = !!((thinkBlock as any)._reasoningTrimmed || thinkBlock.dataset.reasoningTrimmed === 'true');
        if (rawText && !(thinkBlock as any)._reasoningText) {
            (thinkBlock as any)._reasoningText = rawText;
        }
        (thinkBlock as any)._reasoningTrimmed = trimmed;
        delete thinkBlock.dataset.reasoningText;
        thinkBlock.dataset.reasoningTrimmed = trimmed ? 'true' : 'false';
        const toggle = thinkBlock.previousElementSibling as HTMLElement | null;
        if (rawText.length <= 30) {
            if (toggle) toggle.style.display = 'none';
            return;
        }
        const now = Date.now();
        if (!forceFull && !replayHint) {
            const lastAt = (thinkBlock as any)._lastRenderedAt || 0;
            if (now - lastAt < 900) {
                if (!(thinkBlock as any)._renderTimer) {
                    (thinkBlock as any)._renderTimer = window.setTimeout(() => {
                        (thinkBlock as any)._renderTimer = 0;
                        this.renderThinkingBlock(thinkBlock, false, false);
                    }, 900 - (now - lastAt));
                }
                return;
            }
            (thinkBlock as any)._lastRenderedAt = now;
        }

        const expanded = forceFull || thinkBlock.classList.contains('show');
        let displayText = rawText;
        if (expanded) {
            const sanitize = thinkBlock.dataset.historyReasoning === 'true'
                ? sanitizeMessageReasoningForHistoryDisplay
                : sanitizeMessageReasoningForDisplay;
            displayText = sanitize(rawText, trimmed);
        } else {
            const trimmedText = trimmed ? t('thinking.trimmed') : '';
            displayText = t('thinking.compact')
                .replace('{count}', rawText.length.toLocaleString())
                .replace('{trimmed}', trimmedText);
        }

        if (/loop|recovery/i.test(displayText)) {
            thinkBlock.classList.add('reasoning-loop-warn');
        }

        if ((thinkBlock as any)._lastRenderedText !== displayText) {
            thinkBlock.textContent = displayText;
            (thinkBlock as any)._lastRenderedText = displayText;
            if (toggle) toggle.style.display = '';
        }

        if (replayHint && !thinkBlock.classList.contains('show')) {
            thinkBlock.classList.add('show');
            toggle?.classList.add('open');
            this.renderThinkingBlock(thinkBlock, true);
        }
    },

    /**
     * Deduplicate repeated phrases in reasoning text.
     * Detects when the same phrase repeats 3+ times consecutively
     * and collapses it to "脳N" notation.
     */
    _dedupReasoning(text: string): string {
        return dedupMessageReasoning(text);
        // Pass 1: Match 3+ consecutive identical multi-line blocks (each line 鈮?200 chars)
        let result = text.replace(
            /((?:[^\n]{1,200}\n?){1,3})\1{2,}/g,
            (_match: string, phrase: string) => {
                const trimmed = phrase.replace(/\n+$/, '');
                const count = Math.ceil(_match.length / phrase.length);
                return trimmed + ` 脳${count}\n`;
            }
        );
        // Skip expensive passes for very long text (performance guard)
        if (result.length < 3000) {
            // Pass 2: Fixed-size sliding-window dedup for aligned single-line repeats
            for (let size = 100; size >= 20; size -= 10) {
                const regex = new RegExp(`(.{${size}})\\1{2,}`, 'g');
                const newResult = result.replace(regex, (match: string, phrase: string) => {
                    const count = Math.round(match.length / phrase.length);
                    return phrase + ` 脳${count}`;
                });
                if (newResult !== result) { result = newResult; break; }
            }
            // Pass 3: Flexible-length consecutive repeats (catches non-aligned patterns)
            // e.g. "鎬濊€冩€濊€冩€濊€?.." or "Let me think.Let me think.Let me think."
            result = result.replace(/(.{20,}?)\1{2,}/g, (match: string, phrase: string) => {
                const count = Math.round(match.length / phrase.length);
                return phrase + ` 脳${count}`;
            });
        }
        return result;
    },

    // Tool cards
    addToolCard(name: string, args: any): void {
        // Mark thinking as done -tool execution means reasoning for this round is complete
        this._markThinkingDone();
        this.markLiveProgressToolStart(name, args);

        // Append to the current streaming assistant message so tool cards
        // interleave with thinking blocks (not floating at #messages level)
        const streamingMsg = store.get('streamingMsg');
        const messagesDiv = document.getElementById('messages')!;
        const targetDiv = streamingMsg || messagesDiv;
        const delegatedCard = name === 'execute_command'
            ? createExecuteCommandCard(name, args)
            : createToolLine(name, args);
        if (name === 'execute_command') {
            this.makeCardCollapsible(delegatedCard, '.tool-card-header', true);
        }
        targetDiv.appendChild(delegatedCard);
        smartScroll(messagesDiv);
        return;

        // execute_command 鈫?card-style layout with IN/OUT
        if (name === 'execute_command') {
            const card = createElement('div', 'tool-card');
            card.setAttribute('data-status', 'running');
            card.setAttribute('data-tool', name);
            (card as any)._toolName = name;
            (card as any)._toolArgs = args;

            const command = args.command || '';
            card.innerHTML =
                `<div class="tool-card-header">` +
                    `<span class="tool-card-dot"></span>` +
                    `<span class="tool-card-title">Bash</span>` +
                    `<span class="tool-card-desc">${escapeHtml(command.length > 60 ? command.substring(0, 60) + '...' : command)}</span>` +
                    `<span class="tool-card-time"></span>` +
                `</div>` +
                `<div class="tool-card-body">` +
                    `<div class="tool-card-section">` +
                        `<span class="tool-card-section-label">IN</span>` +
                        `<span class="tool-card-section-content">${escapeHtml(command)}</span>` +
                    `</div>` +
                `</div>`;

            targetDiv.appendChild(card);
            smartScroll(messagesDiv);
            return;
        }

        const card = createElement('div', 'tool-line');
        card.setAttribute('data-status', 'running');
        card.setAttribute('data-tool', name);
        (card as any)._toolName = name;
        (card as any)._toolArgs = args;

        const label = this.getToolLabel(name);
        const color = this.getToolColor(name);
        const summary = toolSummary(name, args);

        // Build clickable file link
        const filePath = this.getFilePath(args);
        const url = typeof args?.url === 'string' && /^https?:\/\//i.test(args.url) ? args.url : '';
        const lineInfo = this.getLineInfo(name, args);
        const displayPath = filePath ? (lineInfo ? `${filePath} ${lineInfo}` : filePath) : (url || summary);
        const linkClass = url ? 'tool-link url-link' : 'tool-link';

        card.innerHTML = `<span class="tool-label" style="color:${color}">${label}</span>` +
            `<span class="tool-path"><a class="${linkClass}" href="${url ? escapeHtml(url) : '#'}">${escapeHtml(displayPath)}</a></span>` +
            `<span class="tool-time"></span>`;

        // Click link to open files in VSCode or URLs externally.
        const link = card.querySelector<HTMLAnchorElement>('.tool-link');
        if (!link) return;
        const toolLink = link!;
        toolLink.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (url) {
                vscode.post({ type: 'openUrl', url });
            } else if (filePath) {
                vscode.post({ type: 'openFile', path: filePath, line: args.offset ? args.offset + 1 : undefined });
            }
        });

        targetDiv.appendChild(card);
        smartScroll(messagesDiv);
    },

    getToolLabel(name: string): string {
        const labels: Record<string, string> = {
            schedule_tasks: t('tool.schedule'),
            update_todos: t('tool.todos'),
            read_file: 'Read', write_file: 'Write', edit_file: 'Edit',
            list_directory: 'List', search_files: 'Search', glob_files: 'Glob',
            execute_command: 'Bash', fetch_url: 'Fetch', web_search: 'Search',
            git_status: 'Git', git_diff: 'Diff', git_log: 'Log',
            git_commit: 'Commit', git_push: 'Push', git_pull: 'Pull',
            delete_file: 'Delete', move_file: 'Move', copy_file: 'Copy',
            get_file_info: 'Info',
            browser_open: 'Open', browser_click: 'Click', browser_type: 'Type',
            browser_screenshot: 'Screenshot', browser_get_content: 'Read', browser_close: 'Close',
            run_workflow: 'Workflow',
        };
        if (name.startsWith('mcp_')) return 'MCP';
        return labels[name] || name;
    },

    getToolColor(name: string): string {
        if (name.startsWith('git_')) return '#F05032';
        if (name.startsWith('browser_')) return '#2196F3';
        if (name.startsWith('mcp_')) return '#9C27B0';
        const colors: Record<string, string> = {
            schedule_tasks: '#64B5F6',
            update_todos: '#4CAF50',
            read_file: '#4EC9B0', write_file: '#CE9178', edit_file: '#DCDCAA',
            search_files: '#569CD6', glob_files: '#569CD6', list_directory: '#569CD6',
            execute_command: '#DCDCAA', fetch_url: '#CE9178', web_search: '#569CD6',
            delete_file: '#F44336', move_file: '#FF9800', copy_file: '#9C27B0',
        };
        return colors[name] || 'var(--vscode-descriptionForeground)';
    },

    getFilePath(args: any): string {
        return args.path || args.source || args.file || '';
    },

    getLineInfo(name: string, args: any): string {
        if (name === 'read_file' && (args.offset || args.limit)) {
            const start = (args.offset || 0) + 1;
            const end = args.limit ? start + args.limit - 1 : '...';
            return `[L${start}-${end}]`;
        }
        return '';
    },

    getFileLink(name: string, args: any): string {
        const pathFields = ['path', 'source', 'file'];
        for (const field of pathFields) {
            if (args[field]) return args[field];
        }
        if (args.command) return args.command;
        if (args.url) return args.url;
        if (args.query) return args.query;
        return '';
    },

    handleToolCallEnd(name: string, result: string, isError: boolean, elapsed: number, gitDiff?: string): void {
        const messagesDiv = document.getElementById('messages')!;
        const streamingMsg = store.get('streamingMsg');
        // Search in streamingMsg first (tool cards are now inside it), fallback to #messages
        const searchRoot = streamingMsg || messagesDiv;
        const allTools = searchRoot.querySelectorAll('.tool-line, .tool-card');
        const last = allTools[allTools.length - 1] as HTMLElement | null;
        if (!last) return;
        this.markLiveProgressToolEnd(name, isError, elapsed);

        last.setAttribute('data-status', isError ? 'error' : 'success');

        // Update elapsed time
        const timeEl = last.querySelector('.tool-time') as HTMLElement | null;
        if (timeEl) timeEl.textContent = elapsed.toFixed(1) + 's';

        // Get tool info
        const toolName = (last as any)._toolName as string;
        const toolArgs = (last as any)._toolArgs as any;

        // edit_file 鈫?compact diff card
        if (toolName === 'edit_file' && toolArgs && (toolArgs.old_text || toolArgs.new_text)) {
            const diffCard = this.createDiffCard(toolArgs);
            if (diffCard) {
                last.after(diffCard);
                return;
            }
        }

        // git_diff 鈫?compact diff card
        if (toolName === 'git_diff' && result && result !== 'No changes') {
            const diffCard = this.createDeferredGitDiffCard(result);
            last.after(diffCard);
            return;
        }

        // execute_command 鈫?card-style: add OUT section
        if (toolName === 'update_todos') {
            const todos = Array.isArray(toolArgs?.todos) ? toolArgs.todos : [];
            const items: TodoItem[] = todos
                .map((item: any): TodoItem | null => {
                    const text = String(item?.content || item?.text || item?.title || '').trim();
                    if (!text) return null;
                    const priorityText = String(item?.priority || '').toLowerCase();
                    const priority = priorityText === 'high' ? 'P1' : priorityText === 'low' ? 'P3' : 'P2';
                    const status = String(item?.status || '');
                    return {
                        text,
                        active: /in[_-]?progress|active|doing/i.test(status),
                        done: /completed|done/i.test(status),
                        priority,
                    };
                })
                .filter((item: TodoItem | null): item is TodoItem => !!item);
            const checklist = renderTaskChecklist(items);
            if (checklist) {
                const card = createElement('div', 'todo-tool-result');
                card.innerHTML = checklist;
                last.after(card);
            }
            return;
        }

        if (toolName === 'execute_command') {
            last.setAttribute('data-status', isError ? 'error' : 'success');
            const body = last.querySelector('.tool-card-body');
            if (body) {
                const outSection = createElement('div', 'tool-card-section');
                const outLabel = createElement('span', 'tool-card-section-label');
                outLabel.textContent = 'OUT';
                const outContent = createElement('span', 'tool-card-section-content');
                this.setLazyToolOutput(outContent, result || '(no output)');
                outSection.appendChild(outLabel);
                outSection.appendChild(outContent);
                body.appendChild(outSection);
            }
            const timeEl = last.querySelector('.tool-card-time') as HTMLElement | null;
            if (timeEl) timeEl.textContent = elapsed.toFixed(1) + 's';
            // Show git diff card if command modified files
            if (gitDiff && !isError) {
                last.after(this.createDeferredGitDiffCard(gitDiff));
            }
            // Don't clear streamingMsg - allow thinking to continue
            return;
        }

        // Don't clear streamingMsg - allow thinking to continue across tool calls
    },

    setLazyToolOutput(el: HTMLElement, text: string): void {
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
    },

    createDeferredGitDiffCard(diffText: string): HTMLElement {
        const lineCount = diffText.split(/\r?\n/).length;
        const fileCount = (diffText.match(/^diff --git /gm) || []).length || 1;
        const card = createElement('div', 'tool-card tool-card-compact git-diff-preview-card collapsed');
        card.setAttribute('data-tool', 'git_diff');
        card.innerHTML =
            `<div class="tool-header">` +
            `<div class="tool-icon-wrapper"><div class="tool-icon">GD</div><div class="tool-status-dot"></div></div>` +
            `<div class="tool-info"><span class="tool-name">git_diff</span><span class="tool-args">${fileCount} file${fileCount === 1 ? '' : 's'}, ${lineCount} lines</span></div>` +
            `<div class="tool-meta"><span class="tool-elapsed">Preview</span><span class="tool-chevron">鈻?/span></div>` +
            `</div><div class="tool-body"><div class="tool-result"><div class="diff-line"><span class="diff-info">Expand to render the git diff.</span></div></div></div>`;

        const render = () => {
            const result = card.querySelector<HTMLElement>('.tool-result');
            if (!result) return;
            this.renderGitDiff(result, diffText);
        };
        this.makeCardCollapsible(card, '.tool-header', true);
        this.bindDeferredToolResult(card, render);
        return card;
    },

    ensureStreamingAssistantMessage(): HTMLElement {
        let streamingMsg = store.get('streamingMsg');
        if (!streamingMsg) {
            streamingMsg = this.createAssistantMsg();
            const mc = createElement('div', 'md-content');
            streamingMsg.appendChild(mc);
            store.set('streamingMsg', streamingMsg);
            store.set('rawHtml', '');
        }
        return streamingMsg;
    },

    ensureLiveProgressCard(): HTMLElement | null {
        if (!store.get('planExecutionActive')) return null;
        const messagesDiv = document.getElementById('messages')!;
        const streamingMsg = this.ensureStreamingAssistantMessage();
        let card = streamingMsg.querySelector('.live-progress-card[data-active="true"]') as HTMLElement | null;
        if (card) return card;
        card = createElement('div', 'live-progress-card');
        card.setAttribute('data-active', 'true');
        card.innerHTML =
            `<div class="live-progress-header">` +
            `<span class="live-progress-title">${escapeHtml(t('todo.progress.title'))}</span>` +
            `<span class="live-progress-count">0/0</span>` +
            `</div><div class="live-progress-items"></div>`;
        const mdContent = streamingMsg.querySelector('.md-content:not([data-stream-finalized="true"])');
        if (mdContent) {
            streamingMsg.insertBefore(card, mdContent);
        } else {
            streamingMsg.appendChild(card);
        }
        smartScroll(messagesDiv);
        return card;
    },

    liveProgressLabel(name: string, args: any): string {
        const summary = toolSummary(name, args);
        return (summary ? `${name}: ${summary}` : name).slice(0, 180);
    },

    markLiveProgressToolStart(name: string, args: any): void {
        const card = this.ensureLiveProgressCard();
        if (!card) return;
        const list = card.querySelector('.live-progress-items') as HTMLElement | null;
        if (!list) return;
        const item = createElement('div', 'live-progress-item running');
        item.setAttribute('data-tool', name);
        item.innerHTML =
            `<span class="live-progress-check"></span>` +
            `<span class="live-progress-text">${escapeHtml(this.liveProgressLabel(name, args))}</span>` +
            `<span class="live-progress-state">running</span>`;
        list.appendChild(item);
        this.updateLiveProgressCount(card);
    },

    markLiveProgressToolEnd(name: string, isError: boolean, elapsed: number): void {
        const card = this.ensureLiveProgressCard();
        if (!card) return;
        const running = Array.from(card.querySelectorAll<HTMLElement>('.live-progress-item.running'));
        const item = running.reverse().find(el => el.getAttribute('data-tool') === name) || running[0];
        if (!item) return;
        item.classList.remove('running');
        item.classList.add(isError ? 'error' : 'done');
        const check = item.querySelector('.live-progress-check') as HTMLElement | null;
        const state = item.querySelector('.live-progress-state') as HTMLElement | null;
        if (check) check.textContent = isError ? '!' : '✓';
        if (state) state.textContent = isError ? 'error' : `${elapsed.toFixed(1)}s`;
        this.updateLiveProgressCount(card);
    },

    updateLiveProgressCount(card: HTMLElement): void {
        const total = card.querySelectorAll('.live-progress-item').length;
        const done = card.querySelectorAll('.live-progress-item.done').length;
        const count = card.querySelector('.live-progress-count') as HTMLElement | null;
        if (count) count.textContent = `${done}/${total}`;
    },

    createDiffCard(args: any): HTMLElement | null {
        const oldText = args.old_text || '';
        const newText = args.new_text || '';
        if (!oldText && !newText) return null;

        const card = createElement('div', 'diff-card expanded');
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        const filePath = args.path || 'file';

        // Compute diff using LCS
        const diff = this.computeDiff(oldLines, newLines);
        const added = diff.filter(d => d.type === 'add').length;
        const removed = diff.filter(d => d.type === 'del').length;
        card.setAttribute('data-file', filePath);
        card.setAttribute('data-action', 'edit');
        card.setAttribute('data-added', String(added));
        card.setAttribute('data-removed', String(removed));

        // Header
        card.innerHTML = `<div class="diff-card-header">` +
            `<span class="diff-file">${escapeHtml(filePath)}</span>` +
            `<span class="diff-stats">${added} lines added, ${removed} lines removed</span>` +
            `<span class="diff-chevron">鈻?/span>` +
            `</div><div class="diff-card-body"></div>`;

        const body = card.querySelector('.diff-card-body') as HTMLElement;

        // Render diff with context (show unchanged lines grayed out)
        const maxShow = Math.min(diff.length, 15);
        const startLine = Number(args.line_start);
        const initialLine = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) - 1 : 0;
        let oldLineNum = initialLine;
        let newLineNum = initialLine;
        for (let i = 0; i < maxShow; i++) {
            const d = diff[i];
            const div = createElement('div', `diff-card-line ${d.type === 'add' ? 'add' : d.type === 'del' ? 'del' : 'ctx'}`);
            if (d.type === 'del') {
                oldLineNum++;
                div.innerHTML = `<span class="diff-ln">${oldLineNum}</span><span class="diff-text">${escapeHtml(d.text).substring(0, 120)}</span>`;
            } else if (d.type === 'add') {
                newLineNum++;
                div.innerHTML = `<span class="diff-ln">${newLineNum}</span><span class="diff-text">${escapeHtml(d.text).substring(0, 120)}</span>`;
            } else {
                oldLineNum++;
                newLineNum++;
                div.innerHTML = `<span class="diff-ln">${newLineNum}</span><span class="diff-text" style="opacity:.4">${escapeHtml(d.text).substring(0, 120)}</span>`;
            }
            body.appendChild(div);
        const ctxCount = diff.slice(0, maxShow).filter(d => d.type === 'ctx').length;
        const hdrStats = card.querySelector('.diff-stats') as HTMLElement | null;
        if (hdrStats) hdrStats.textContent = `+${added}, -${removed}` + (ctxCount ? ` (${ctxCount} ctx)` : '');
        }
        if (diff.length > maxShow) {
            const more = createElement('div', 'diff-card-line ctx');
            more.innerHTML = `<span class="diff-ln"></span><span class="diff-text" style="opacity:.4">... ${diff.length - maxShow} more lines</span>`;
            body.appendChild(more);
        }

        // Toggle expand on header click
        const diffHeader = card.querySelector('.diff-card-header');
        if (diffHeader) diffHeader.addEventListener('click', () => {
            card.classList.toggle('expanded');
        });

        return card;
    },

    /**
     * Simple LCS-based diff algorithm.
     * Returns array of {type: 'ctx'|'add'|'del', text: string}
     */
    computeDiff(oldLines: string[], newLines: string[]): Array<{type: string; text: string}> {
        const m = oldLines.length;
        const n = newLines.length;

        // Guard: skip LCS for very large inputs to avoid O(m*n) memory blowup
        if (m * n > 250_000) {
            // Fallback: show all old as del, all new as add (no context)
            const result: Array<{type: string; text: string}> = [];
            for (const line of oldLines) result.push({ type: 'del', text: line });
            for (const line of newLines) result.push({ type: 'add', text: line });
            return result;
        }

        // Build LCS table
        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (oldLines[i - 1] === newLines[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack to find diff (push + reverse instead of unshift for O(n) total)
        const result: Array<{type: string; text: string}> = [];
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
                result.push({ type: 'ctx', text: oldLines[i - 1] });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                result.push({ type: 'add', text: newLines[j - 1] });
                j--;
            } else {
                result.push({ type: 'del', text: oldLines[i - 1] });
                i--;
            }
        }

        result.reverse();
        return result;
    },

    renderEditDiff(res: HTMLElement, args: any, txt: string): void {
        const oldLines = (args.old_text || '').split('\n');
        const newLines = (args.new_text || '').split('\n');
        let html = `<div class="diff-header-line"><span class="diff-stats">-${oldLines.length} +${newLines.length}</span></div>`;
        const maxShow = Math.max(oldLines.length, newLines.length, 8);
        const showOld = oldLines.slice(0, maxShow);
        const showNew = newLines.slice(0, maxShow);
        for (const line of showOld) {
            html += `<div class="diff-line"><span class="diff-ln">-</span><span class="diff-del">- ${escapeHtml(line).substring(0, 120)}</span></div>`;
        }
        if (oldLines.length > maxShow) html += `<div class="diff-line"><span class="diff-ln">...</span><span class="diff-info">+${oldLines.length - maxShow} more lines</span></div>`;
        for (const line of showNew) {
            html += `<div class="diff-line"><span class="diff-ln">+</span><span class="diff-add">+ ${escapeHtml(line).substring(0, 120)}</span></div>`;
        }
        if (newLines.length > maxShow) html += `<div class="diff-line"><span class="diff-ln">...</span><span class="diff-info">+${newLines.length - maxShow} more lines</span></div>`;
        html += `<div class="diff-info">${escapeHtml(txt)}</div>`;
        res.innerHTML = html;
    },

    renderGitDiff(res: HTMLElement, txt: string): void {
        const maxChars = 8000;
        const truncated = txt.length > maxChars;
        const lines = (truncated ? txt.substring(0, maxChars) : txt).split('\n');
        const CONTEXT_LINES = 2; // lines of context around each change

        // Phase 1: Parse into structured hunks per file
        interface DiffLine { type: 'add' | 'del' | 'ctx' | 'hunk' | 'file'; text: string; oldLn?: number; newLn?: number; label?: string; skipped?: number; }
        const files: { name: string; hunks: DiffLine[][]; added: number; removed: number }[] = [];
        let curFile = { name: '', hunks: [] as DiffLine[][], added: 0, removed: 0 };
        let curHunk: DiffLine[] = [];
        let oldLn = 0, newLn = 0;

        for (const line of lines) {
            if (line.startsWith('diff --git')) {
                if (curHunk.length > 0) {
                    curFile.hunks.push(curHunk);
                    curHunk = [];
                }
                if (curFile.name) { files.push(curFile); }
                const m = line.match(/b\/(.+)$/);
                curFile = { name: m ? m[1] : '', hunks: [], added: 0, removed: 0 };
                oldLn = 0; newLn = 0;
                continue;
            }
            if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue;
            if (line.startsWith('@@')) {
                const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
                if (m) { oldLn = parseInt(m[1]) - 1; newLn = parseInt(m[2]) - 1; }
                if (curHunk.length > 0) curFile.hunks.push(curHunk);
                curHunk = [{ type: 'hunk', text: m ? m[0] : line, label: m?.[3]?.trim() }];
                continue;
            }
            if (line.startsWith('+') && !line.startsWith('+++')) {
                newLn++; curFile.added++; curHunk.push({ type: 'add', text: line.substring(1), newLn });
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                oldLn++; curFile.removed++; curHunk.push({ type: 'del', text: line.substring(1), oldLn });
            } else if (line.startsWith(' ')) {
                oldLn++; newLn++; curHunk.push({ type: 'ctx', text: line.substring(1), oldLn, newLn });
            }
        }
        if (curHunk.length > 0) curFile.hunks.push(curHunk);
        if (curFile.name) files.push(curFile);

        // Phase 2: Render with collapsed context
        let html = '';
        let totalAdded = 0, totalRemoved = 0;

        for (const file of files) {
            totalAdded += file.added;
            totalRemoved += file.removed;
            if (file.added === 0 && file.removed === 0) continue;

            html += `<div class="diff-file-header" data-file="${escapeHtml(file.name)}">File ${escapeHtml(file.name)}</div>`;

            for (const hunk of file.hunks) {
                // Find hunk header line
                const hunkLine = hunk.find(l => l.type === 'hunk');
                if (hunkLine) {
                    const m = (hunkLine.text || '').match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
                    if (m) {
                        const loc = hunkLine.text.replace(/^@@\s*/, '').replace(/\s*@@.*$/, '').trim();
                        html += `<div class="diff-hunk"><span class="diff-hunk-marker">@@</span><span class="diff-hunk-loc">${escapeHtml(loc)}</span>${hunkLine.label ? `<span class="diff-hunk-fn">${escapeHtml(hunkLine.label)}</span>` : ''}</div>`;
                    } else {
                        html += `<div class="diff-hunk"><span class="diff-hunk-marker">@@</span>${escapeHtml(hunkLine.text)}</div>`;
                    }
                }

                // Build index of changed positions within this hunk
                const changed = new Set<number>();
                hunk.forEach((l, i) => { if (l.type === 'add' || l.type === 'del') changed.add(i); });

                let lastShown = -1;
                for (let i = 0; i < hunk.length; i++) {
                    const l = hunk[i];
                    if (l.type === 'hunk') continue;

                    const isNearChange = [...changed].some(ci => Math.abs(ci - i) <= CONTEXT_LINES);
                    if (!isNearChange && l.type === 'ctx') {
                        continue; // skip distant context
                    }

                    // Insert "..." gap if we skipped lines
                    if (l.type === 'ctx' && lastShown >= 0 && i - lastShown > 1) {
                        const skipped = i - lastShown - 1;
                        html += `<div class="diff-skip">... ${skipped} unchanged line${skipped > 1 ? 's' : ''} ...</div>`;
                    }
                    lastShown = i;

                    const esc = escapeHtml(l.text);
                    if (l.type === 'add') {
                        html += `<div class="diff-line diff-add"><span class="diff-ln new">${l.newLn}</span><span class="diff-sign">+</span><span class="diff-text">${esc}</span></div>`;
                    } else if (l.type === 'del') {
                        html += `<div class="diff-line diff-del"><span class="diff-ln old">${l.oldLn}</span><span class="diff-sign">-</span><span class="diff-text">${esc}</span></div>`;
                    } else {
                        html += `<div class="diff-line diff-ctx"><span class="diff-ln old">${l.oldLn}</span><span class="diff-ln new">${l.newLn}</span><span class="diff-sign"> </span><span class="diff-text">${esc}</span></div>`;
                    }
                }
            }

            // Per-file summary
            html += `<div class="diff-file-summary"><span class="diff-stats-add">+${file.added} lines</span><span class="diff-stats-del">-${file.removed} lines</span></div>`;
        }

        // Total summary bar at top
        if (totalAdded > 0 || totalRemoved > 0) {
            const label = files.length > 1 ? `${files.length} files` : (files[0]?.name || 'changes');
            html = `<div class="diff-summary"><span class="diff-file-name">${escapeHtml(label)}</span><span class="diff-stats-add">+${totalAdded} lines</span><span class="diff-stats-del">-${totalRemoved} lines</span></div>` + html;
        }

        if (truncated) html += `<div class="diff-info">... (truncated, ${txt.length} chars total)</div>`;
        res.innerHTML = html || '<div class="diff-info">No changes</div>';
    },

    // Round / Done / Error
    handleRoundStart(round: number): void {
        if (round <= 1) return;
        const messagesDiv = document.getElementById('messages')!;
        const streamingMsg = store.get('streamingMsg');
        const mk = createElement('div', 'round-marker');
        mk.innerHTML = `<span>Round ${round}</span>`;
        (streamingMsg || messagesDiv).appendChild(mk);
    },

    handleDone(elapsedSec?: number): void {
        this.commitStreamSegment();
        // Mark all thinking dots as done
        this._markThinkingDone();

        // Collapse all execution details into a drawer, leaving final answer visible below.
        this.compactExecutionDetails(elapsedSec);
        this.attachAssistantActions(store.get('streamingMsg'), undefined, { elapsedSec });

        const completedStreamingMsg = store.get('streamingMsg');
        store.set('streamingMsg', null);
        store.set('rawHtml', '');
        document.querySelectorAll<HTMLElement>('.live-progress-card[data-active="true"]').forEach(card => card.setAttribute('data-active', 'false'));
        store.set('planExecutionActive', false);
        const messagesDiv = document.getElementById('messages')!;
        this.renderToolOnlyTaskChangesFallback(completedStreamingMsg || undefined);
        smartScroll(messagesDiv);
        this.scheduleHistorySnapshot(elapsedSec);
    },

    attachAssistantActions(
        assistant: HTMLElement | null,
        retryPayload?: { text: string; images?: any[] | null } | null,
        meta?: { elapsedSec?: number }
    ): void {
        if (!assistant) return;
        assistant.querySelectorAll('.assistant-actions').forEach(el => el.remove());
        const copyText = this.extractAssistantCopyText(assistant);
        if (!copyText) return;

        const actions = createElement('div', 'assistant-actions');
        actions.setAttribute('role', 'toolbar');
        actions.setAttribute('aria-label', t('assistant.actions'));
        actions.setAttribute('data-i18n-aria-label', 'assistant.actions');
        const replayable = retryPayload || store.get('lastUserMsg') || null;
        (actions as any)._retryPayload = replayable;

        const buttonsEl = createElement('div', 'assistant-action-buttons');
        const buttons: Array<{ action: string; labelKey: string }> = [
            { action: 'copy', labelKey: 'assistant.action.copy' },
            ...(replayable ? [{ action: 'retry', labelKey: 'assistant.action.retry' }] : []),
            ...(this.shouldShowContinueAction(assistant) ? [{ action: 'continue', labelKey: 'assistant.action.continue' }] : []),
            { action: 'feedback', labelKey: 'assistant.action.feedback' },
        ];

        for (const item of buttons) {
            const btn = createElement('button', 'assistant-action-btn') as HTMLButtonElement;
            btn.type = 'button';
            btn.dataset.action = item.action;
            btn.setAttribute('aria-label', t(item.labelKey));
            btn.setAttribute('data-i18n-aria-label', item.labelKey);
            btn.setAttribute('data-i18n-title', item.labelKey);
            btn.title = t(item.labelKey);
            btn.innerHTML = assistantActionIcon(item.action);
            buttonsEl.appendChild(btn);
        }
        actions.appendChild(buttonsEl);

        const metaEl = this.createAssistantActionMeta(assistant, meta);
        if (metaEl) actions.appendChild(metaEl);
        assistant.appendChild(actions);
    },

    createAssistantActionMeta(assistant: HTMLElement, meta?: { elapsedSec?: number }): HTMLElement | null {
        const wrap = createElement('div', 'assistant-action-meta');
        const elapsed = typeof meta?.elapsedSec === 'number' && meta.elapsedSec > 0 ? this.formatDuration(meta.elapsedSec) : '';
        if (elapsed) {
            const item = createElement('span', 'assistant-action-meta-item assistant-action-elapsed');
            item.textContent = elapsed;
            wrap.appendChild(item);
        }

        return wrap.children.length > 0 ? wrap : null;
    },

    shouldShowContinueAction(assistant: HTMLElement): boolean {
        if (assistant.querySelector('.task-checklist .todo:not(.done), .todo-tool-result .todo:not(.done)')) return true;
        const text = this.extractAssistantCopyText(assistant);
        return /(可以继续|继续执行|下一步|未完成|待完成|后续|接着做|continue|next step|remaining work|follow[- ]?up)/i.test(text);
    },

    localizeAssistantActions(): void {},

    extractAssistantCopyText(assistant: HTMLElement): string {
        const finalContents = Array.from(assistant.querySelectorAll<HTMLElement>('.md-content-final:not(.md-content-update):not(.md-content-verification)'));
        const normalContents = Array.from(assistant.querySelectorAll<HTMLElement>('.md-content:not(.md-content-update):not(.md-content-verification)'));
        const source = finalContents.length > 0
            ? finalContents[finalContents.length - 1]
            : normalContents.length > 0
                ? normalContents[normalContents.length - 1]
                : assistant;
        const clone = source.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.assistant-actions, .copy-btn, .code-copy, .msg-copy').forEach(el => el.remove());
        return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    },

    handleAssistantAction(button: HTMLButtonElement): void {
        const action = button.dataset.action || '';
        const assistant = button.closest('.msg-assistant') as HTMLElement | null;
        if (action === 'copy' && assistant) {
            const text = this.extractAssistantCopyText(assistant);
            copyTextToClipboard(text).then(() => {
                button.innerHTML = assistantActionIcon('copied');
                button.classList.add('copied');
                window.setTimeout(() => {
                    button.innerHTML = assistantActionIcon('copy');
                    button.classList.remove('copied');
                }, 1400);
            }).catch(() => {});
            return;
        }

        if (action === 'retry') {
            const actions = button.closest('.assistant-actions') as HTMLElement | null;
            const last = (actions as any)?._retryPayload || store.get('lastUserMsg');
            if (!last?.text && !last?.images?.length) return;
            vscode.send(last.text || '', last.images || null);
            return;
        }

        if (action === 'continue') {
            vscode.send(t('assistant.continue.prompt'));
            return;
        }

        if (action === 'feedback') {
            vscode.send(t('assistant.feedback.prompt'));
            return;
        }
    },

    archiveAssistantActions(): void {
        document.querySelectorAll<HTMLElement>('.assistant-actions').forEach(actions => {
            actions.classList.add('is-archived');
        });
    },

    refreshAssistantActionVisibility(): void {
        const actions = Array.from(document.querySelectorAll<HTMLElement>('.msg-assistant .assistant-actions'));
        actions.forEach((el, index) => {
            el.classList.toggle('is-archived', index < actions.length - 1);
        });
    },

    scheduleHistorySnapshot(elapsedSec?: number): void {
        window.setTimeout(() => {
            const snapshot = this.captureLatestTurnSnapshot(elapsedSec);
            if (snapshot) vscode.historySnapshot(snapshot);
        }, 80);
    },

    captureLatestTurnSnapshot(elapsedSec?: number): any | null {
        const messagesDiv = document.getElementById('messages');
        if (!messagesDiv) return null;
        const assistants = Array.from(messagesDiv.querySelectorAll<HTMLElement>('.msg-assistant, .streaming'));
        const assistant = assistants.reverse().find(el =>
            el.classList.contains('execution-compacted') ||
            el.querySelector('.execution-drawer, .task-changes-card, .diff-card, .todo-tool-result, .task-checklist')
        );
        if (!assistant) return null;
        const userMessages = Array.from(messagesDiv.querySelectorAll<HTMLElement>('.msg-user'));
        const user = userMessages[userMessages.length - 1] || null;
        const snapshotNodes = this.collectLatestTurnSnapshotNodes(messagesDiv, assistant, user);
        const html = snapshotNodes.map(node => node.outerHTML).join('\n');
        if (!html || html.length > HISTORY_SNAPSHOT_MAX_HTML) return null;
        const userHtml = user?.outerHTML || '';
        const taskChanges = this.buildHistoryTaskChangeSnapshots(snapshotNodes);
        return {
            version: 2,
            capturedAt: Date.now(),
            elapsedSec: typeof elapsedSec === 'number' ? Number(elapsedSec.toFixed(1)) : undefined,
            assistantHtml: html,
            userHtml: userHtml.length < 200_000 ? userHtml : '',
            taskChanges,
        };
    },

    collectLatestTurnSnapshotNodes(messagesDiv: HTMLElement, assistant: HTMLElement, user: HTMLElement | null): HTMLElement[] {
        const nodes: HTMLElement[] = [];
        let next: HTMLElement | null = user?.nextElementSibling instanceof HTMLElement
            ? user.nextElementSibling
            : assistant;
        while (next) {
            if (this.isLatestTurnSnapshotNode(next)) {
                nodes.push(next);
            }
            const following: Element | null = next.nextElementSibling;
            next = following instanceof HTMLElement ? following : null;
        }
        if (!nodes.includes(assistant)) nodes.unshift(assistant);
        return nodes.filter((node, index) => nodes.indexOf(node) === index);
    },

    isLatestTurnSnapshotNode(node: HTMLElement): boolean {
        if (node.classList.contains('sticky-user-preview')) return false;
        if (node.classList.contains('msg-user')) return false;
        if (node.classList.contains('msg-queue-container')) return false;
        return node.classList.contains('msg-assistant') ||
            node.classList.contains('task-changes-card') ||
            node.classList.contains('diff-card') ||
            node.classList.contains('completion-summary') ||
            node.classList.contains('msg-error');
    },

    buildHistoryTaskChangeSnapshots(nodes: HTMLElement[]): HistoryTaskChangeSnapshot[] {
        return nodes
            .filter(node => node.classList.contains('task-changes-card'))
            .map(card => {
                const gitTpl = card.querySelector<HTMLTemplateElement>('template.task-changes-patch[data-kind="git-patch"]');
                const gitPatch = String((card as any)._patch || gitTpl?.content?.textContent || gitTpl?.textContent || '').trim();
                const toolPatchMap = new Map<string, string>();

                Array.from(card.querySelectorAll<HTMLTemplateElement>('template.task-changes-patch[data-kind="tool-patch"]')).forEach(node => {
                    const filePath = node.getAttribute('data-file') || '';
                    const patch = String(node.content?.textContent || node.textContent || '').trim();
                    if (filePath && patch) toolPatchMap.set(this.normalizeFileKey(filePath), patch);
                });

                const runtimeToolDiffs = (card as any)._fileToolDiffs as Record<string, string> | undefined;
                if (runtimeToolDiffs) {
                    card.querySelectorAll<HTMLElement>('.task-change-entry[data-file]').forEach(entry => {
                        const filePath = entry.getAttribute('data-file') || '';
                        const patch = runtimeToolDiffs[this.normalizeFileKey(filePath)] || '';
                        if (filePath && patch) toolPatchMap.set(this.normalizeFileKey(filePath), String(patch).trim());
                    });
                }

                return {
                    gitPatch,
                    toolPatches: Array.from(toolPatchMap.entries()).map(([fileKey, patch]) => {
                        const matchedPath = Array.from(card.querySelectorAll<HTMLElement>('.task-change-entry[data-file]'))
                            .map(entry => entry.getAttribute('data-file') || '')
                            .find(filePath => this.normalizeFileKey(filePath) === fileKey) || fileKey;
                        return { filePath: matchedPath, patch };
                    }),
                };
            })
            .filter(snapshot => !!snapshot.gitPatch || snapshot.toolPatches.length > 0);
    },

    compactExecutionDetails(elapsedSec?: number): void {
        const streamingMsg = store.get('streamingMsg');
        if (!streamingMsg || streamingMsg.classList.contains('execution-compacted')) return;

        const finalContents = Array.from(streamingMsg.querySelectorAll('.md-content-final:not(.md-content-update):not(.md-content-verification)')) as HTMLElement[];
        const finalContent = [...finalContents]
            .reverse()
            .find(el => !!el.textContent?.trim() || !!el.querySelector('*')) || null;
        for (const content of finalContents) {
            if (content !== finalContent) content.classList.add('md-content-update');
        }

        const detailNodes = Array.from(streamingMsg.children).filter((node) => {
            const el = node as HTMLElement;
            return el.classList.contains('thinking-toggle') ||
                el.classList.contains('thinking-block') ||
                el.classList.contains('md-content-update') ||
                el.classList.contains('md-content-verification') ||
                el.classList.contains('tool-line') ||
                el.classList.contains('tool-card') ||
                el.classList.contains('todo-tool-result') ||
                el.classList.contains('diff-card') ||
                el.classList.contains('workflow-card') ||
                el.classList.contains('live-progress-card') ||
                el.classList.contains('round-marker');
        }) as HTMLElement[];

        if (detailNodes.length === 0) return;

        const drawer = createElement('div', 'execution-drawer');
        const header = createElement('button', 'execution-drawer-header');
        header.type = 'button';
        this.removeExecutionMetaChips(streamingMsg);
        header.innerHTML =
            `<span class="execution-title">Processed</span>` +
            `<span class="execution-chevron">&rsaquo;</span>`;

        const body = createElement('div', 'execution-drawer-body');
        const details = createElement('div', 'execution-details');
        for (const node of detailNodes) {
            details.appendChild(node);
        }
        body.appendChild(details);
        drawer.appendChild(header);
        drawer.appendChild(body);

        header.addEventListener('click', () => {
            drawer.classList.toggle('open');
        });

        if (finalContent) {
            streamingMsg.insertBefore(drawer, finalContent);
        } else {
            streamingMsg.appendChild(drawer);
        }
        streamingMsg.classList.add('execution-compacted');
    },

    formatDuration(seconds: number): string {
        if (!seconds || seconds <= 0) return '';
        if (seconds < 60) return `${seconds.toFixed(1)}s`;
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return `${m}m ${s}s`;
    },

    collectEditedFiles(root: HTMLElement): EditedFileInfo[] {
        const map = new Map<string, EditedFileInfo>();
        const nodes = root.querySelectorAll<HTMLElement>('[data-file][data-action]');
        nodes.forEach((node) => {
            const file = node.getAttribute('data-file') || '';
            const action = node.getAttribute('data-action') || 'edit';
            if (!file) return;
            const added = parseInt(node.getAttribute('data-added') || '0', 10) || 0;
            const removed = parseInt(node.getAttribute('data-removed') || '0', 10) || 0;
            const existing = map.get(file);
            if (existing) {
                existing.added += added;
                existing.removed += removed;
                if (existing.action !== action) existing.action = 'edit';
            } else {
                map.set(file, { path: file, action, added, removed });
            }
        });
        return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    },

    normalizeFileKey(filePath: string): string {
        return String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    },

    fileKeysMatch(a: string, b: string): boolean {
        const left = this.normalizeFileKey(a);
        const right = this.normalizeFileKey(b);
        if (!left || !right) return false;
        return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
    },

    getLatestAssistantWithToolDiffs(): HTMLElement | null {
        const containers = Array.from(document.querySelectorAll<HTMLElement>('.msg-assistant, .streaming'));
        return containers.reverse().find(container => container.querySelector('.diff-card[data-file], [data-file][data-action]')) || null;
    },

    findToolDiffCard(filePath: string): HTMLElement | null {
        const latest = this.getLatestAssistantWithToolDiffs();
        if (!latest) return null;
        const cards = Array.from(latest.querySelectorAll<HTMLElement>('.diff-card[data-file]'));
        return cards.find(card => this.fileKeysMatch(card.getAttribute('data-file') || '', filePath)) || null;
    },

    cloneToolDiffForFile(filePath: string): HTMLElement | null {
        const source = this.findToolDiffCard(filePath);
        if (!source) return null;
        const clone = source.cloneNode(true) as HTMLElement;
        clone.classList.add('expanded', 'task-tool-diff');
        clone.querySelector<HTMLElement>('.diff-card-header')?.addEventListener('click', () => {
            clone.classList.toggle('expanded');
        });
        return clone;
    },

    cloneAllToolDiffs(): HTMLElement[] {
        const latest = this.getLatestAssistantWithToolDiffs();
        if (!latest) return [];
        return Array.from(latest.querySelectorAll<HTMLElement>('.diff-card[data-file]')).map(card => {
            const clone = card.cloneNode(true) as HTMLElement;
            clone.classList.add('expanded', 'task-tool-diff');
            clone.querySelector<HTMLElement>('.diff-card-header')?.addEventListener('click', () => {
                clone.classList.toggle('expanded');
            });
            return clone;
        });
    },

    getTaskChangePreviewEntries(summary: TaskChangeSummary | null | undefined, targetFile?: string): TaskChangePatchEntry[] {
        const entries: TaskChangePatchEntry[] = [];
        const seen = new Set<string>();
        const addEntry = (filePath: string, patch: string) => {
            const key = this.normalizeFileKey(filePath);
            if (!patch || !key || seen.has(key)) return;
            if (targetFile && !this.fileKeysMatch(filePath, targetFile)) return;
            seen.add(key);
            entries.push({ filePath, patch: String(patch).trim() });
        };

        for (const entry of splitUnifiedDiffByFile(summary?.patch || '')) {
            addEntry(entry.filePath, entry.patch);
        }
        for (const file of summary?.files || []) {
            addEntry(file.path, file.toolDiff || '');
        }
        return entries;
    },

    getHistoryTaskChangePreviewEntries(card: HTMLElement | null | undefined, details: any[] = [], targetFile?: string): TaskChangePatchEntry[] {
        const entries: TaskChangePatchEntry[] = [];
        const seen = new Set<string>();
        const addEntry = (filePath: string, patch: string) => {
            const key = this.normalizeFileKey(filePath);
            if (!patch || !key || seen.has(key)) return;
            if (targetFile && !this.fileKeysMatch(filePath, targetFile)) return;
            seen.add(key);
            entries.push({ filePath, patch: String(patch).trim() });
        };

        for (const entry of splitUnifiedDiffByFile(this.getHistoryTaskChangesPatch(card, details))) {
            addEntry(entry.filePath, entry.patch);
        }
        const files = Array.from(card?.querySelectorAll<HTMLTemplateElement>('template.task-changes-patch[data-kind="tool-patch"]') || []);
        for (const node of files) {
            addEntry(node.getAttribute('data-file') || '', node.content?.textContent || node.textContent || '');
        }
        return entries;
    },

    getTaskChangeUndoPatch(summary: TaskChangeSummary | null | undefined, targetFile: string): string {
        return this.getTaskChangePreviewEntries(summary, targetFile)
            .map(entry => entry.patch.trim())
            .filter(Boolean)
            .join('\n\n')
            .trim();
    },

    openTaskChangePreview(title: string, entries: TaskChangePatchEntry[], statusEl?: HTMLElement | null, emptyMessage?: string): void {
        if (!entries.length) {
            if (statusEl) statusEl.textContent = emptyMessage || 'No text diff available.';
            return;
        }
        if (statusEl) statusEl.textContent = '';
        const content = buildTaskChangePreviewDocument(title, entries);
        vscode.openScratchDocument(title, content, 'diff', true);
    },

    openTaskChangeFileDiff(title: string, filePath: string, patch: string, statusEl?: HTMLElement | null, emptyMessage?: string): void {
        const parsed = parseUnifiedDiffToContent(patch);
        if (!parsed) {
            if (statusEl) statusEl.textContent = emptyMessage || t('task.changes.preview.empty');
            return;
        }
        if (statusEl) statusEl.textContent = '';
        const extension = (String(filePath || '').match(/\.([A-Za-z0-9_-]+)$/)?.[1] || '').toLowerCase();
        const language = extension === 'svg'
            ? 'xml'
            : extension === 'md'
            ? 'markdown'
            : ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'svg', 'py'].includes(extension)
                ? extension
                : 'plaintext';
        vscode.openReadonlyDiff(title, filePath, parsed.before, parsed.after, language, true);
    },

    openTaskChangeReview(title: string, entries: TaskChangePatchEntry[], statusEl?: HTMLElement | null, emptyMessage?: string): void {
        if (!entries.length) {
            if (statusEl) statusEl.textContent = emptyMessage || t('task.changes.preview.empty');
            return;
        }
        const items = entries
            .map(entry => {
                const parsed = parseUnifiedDiffToContent(entry.patch);
                if (!parsed) return null;
                return {
                    filePath: entry.filePath,
                    patch: entry.patch,
                    before: parsed.before,
                    after: parsed.after,
                };
            })
            .filter((item): item is { filePath: string; patch: string; before: string; after: string } => !!item);
        if (!items.length) {
            if (statusEl) statusEl.textContent = emptyMessage || t('task.changes.preview.empty');
            return;
        }
        if (statusEl) statusEl.textContent = '';
        vscode.openDiffReview(title, items);
    },

    formatTaskChangeFileCount(count: number): string {
        return count === 1 ? '1 file' : `${count} files`;
    },

    formatTaskChangeEditedTitle(count: number): string {
        return t('task.changes.edited').replace('{count}', this.formatTaskChangeFileCount(count));
    },

    formatTaskChangeRemainingTitle(remaining: number, total: number): string {
        return t('task.changes.remaining')
            .replace('{remaining}', this.formatTaskChangeFileCount(remaining))
            .replace('{total}', this.formatTaskChangeFileCount(total));
    },

    setTaskChangeCardState(card: HTMLElement, text = '', tone: 'info' | 'success' | 'error' | 'pending' = 'info'): void {
        const badge = card.querySelector<HTMLElement>('.task-changes-card-state');
        if (!badge) return;
        badge.textContent = text;
        badge.dataset.tone = text ? tone : '';
    },

    setTaskChangeStatus(card: HTMLElement, message = '', tone: 'info' | 'success' | 'error' | 'pending' = 'info'): void {
        const statusEl = card.querySelector<HTMLElement>('.task-changes-status');
        if (!statusEl) return;
        statusEl.textContent = message;
        statusEl.dataset.tone = message ? tone : '';
    },

    refreshTaskChangeCardOverview(card: HTMLElement): void {
        const entries = Array.from(card.querySelectorAll<HTMLElement>('.task-change-entry'));
        const totalCount = entries.length;
        const activeEntries = entries.filter(entry => !entry.classList.contains('task-change-entry-undone'));
        const remainingCount = activeEntries.length;
        const added = activeEntries.reduce((sum, entry) => sum + (Number(entry.dataset.added || '0') || 0), 0);
        const removed = activeEntries.reduce((sum, entry) => sum + (Number(entry.dataset.removed || '0') || 0), 0);

        const titleMain = card.querySelector<HTMLElement>('.task-changes-title-main');
        if (titleMain) {
            if (remainingCount === totalCount) {
                titleMain.textContent = this.formatTaskChangeEditedTitle(totalCount);
            } else if (remainingCount > 0) {
                titleMain.textContent = this.formatTaskChangeRemainingTitle(remainingCount, totalCount);
            } else {
                titleMain.textContent = t('task.changes.undone');
            }
        }

        const stats = card.querySelector<HTMLElement>('.task-changes-stats');
        if (stats) {
            stats.innerHTML = `<span class="diff-stats-add">+${added} lines</span> <span class="diff-stats-del">-${removed} lines</span>`;
        }

        card.classList.toggle('task-changes-undone', remainingCount === 0);
    },

    startTaskChangeUndo(card: HTMLElement, targetFile?: string): void {
        card.dataset.undoPending = 'true';
        card.dataset.pendingFile = targetFile || '';
        card.dataset.awaitingRefresh = 'false';

        const undoBtn = card.querySelector<HTMLButtonElement>('.task-changes-undo');
        const reviewBtn = card.querySelector<HTMLButtonElement>('.task-changes-review');
        if (undoBtn) {
            undoBtn.dataset.defaultText = undoBtn.dataset.defaultText || undoBtn.textContent || 'Undo';
            undoBtn.disabled = true;
            undoBtn.textContent = 'Undoing...';
        }
        if (reviewBtn) reviewBtn.disabled = true;

        if (targetFile) {
            const entry = Array.from(card.querySelectorAll<HTMLElement>('.task-change-entry'))
                .find(node => this.fileKeysMatch(node.dataset.file || '', targetFile));
            const fileUndoBtn = entry?.querySelector<HTMLButtonElement>('.task-change-file-undo') || null;
            entry?.classList.add('task-change-entry-pending');
            if (fileUndoBtn) {
                fileUndoBtn.dataset.defaultText = fileUndoBtn.dataset.defaultText || fileUndoBtn.textContent || 'Undo';
                fileUndoBtn.disabled = true;
                fileUndoBtn.textContent = '...';
            }
            this.setTaskChangeCardState(card, 'Undoing', 'pending');
            this.setTaskChangeStatus(card, `Undoing ${targetFile}...`, 'pending');
            return;
        }

        card.classList.add('task-changes-pending');
        this.setTaskChangeCardState(card, 'Undoing', 'pending');
        this.setTaskChangeStatus(card, 'Undoing changes from this card...', 'pending');
    },

    finishTaskChangeUndo(card: HTMLElement, targetFile?: string): void {
        delete card.dataset.undoPending;
        card.classList.remove('task-changes-pending');

        const undoBtn = card.querySelector<HTMLButtonElement>('.task-changes-undo');
        const reviewBtn = card.querySelector<HTMLButtonElement>('.task-changes-review');
        if (undoBtn) {
            undoBtn.textContent = undoBtn.dataset.defaultText || 'Undo';
        }
        if (reviewBtn) reviewBtn.disabled = false;

        if (targetFile) {
            const entry = Array.from(card.querySelectorAll<HTMLElement>('.task-change-entry'))
                .find(node => this.fileKeysMatch(node.dataset.file || '', targetFile));
            const fileUndoBtn = entry?.querySelector<HTMLButtonElement>('.task-change-file-undo') || null;
            entry?.classList.remove('task-change-entry-pending');
            if (fileUndoBtn && !entry?.classList.contains('task-change-entry-undone')) {
                fileUndoBtn.textContent = fileUndoBtn.dataset.defaultText || 'Undo';
            }
        }
    },

    findTaskChangeFile(map: Map<string, TaskChangeFile>, filePath: string): TaskChangeFile | undefined {
        return Array.from(map.values()).find(file => this.fileKeysMatch(file.path, filePath));
    },

    renderToolOnlyTaskChangesFallback(root?: HTMLElement): void {
        const messagesDiv = document.getElementById('messages');
        if (!messagesDiv) return;
        const latest = root && root.querySelector('.diff-card[data-file], [data-file][data-action]') ? root : null;
        if (!latest || latest.querySelector('.task-changes-card')) return;
        if (messagesDiv.querySelector('.task-changes-card[data-tool-fallback="true"]')) return;

        const editedFiles = this.collectEditedFiles(latest);
        if (editedFiles.length === 0) return;
        const summary: TaskChangeSummary = {
            id: `tool_changes_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            files: editedFiles.map(file => ({
                path: file.path,
                added: file.added,
                removed: file.removed,
                source: 'tool',
                action: file.action,
                hasToolDiff: !!this.findToolDiffCard(file.path),
            })),
            totalAdded: editedFiles.reduce((sum, file) => sum + file.added, 0),
            totalRemoved: editedFiles.reduce((sum, file) => sum + file.removed, 0),
            patch: '',
            createdAt: Date.now(),
            canUndo: false,
            warning: 'Changes were detected from tool records, but no safe reverse Git patch is available. Review the diff and undo manually if needed.',
        };
        this.renderTaskChangesCard(summary, true);
    },

    mergeToolEditedFilesIntoTaskSummary(summary: TaskChangeSummary): TaskChangeSummary {
        const map = new Map<string, TaskChangeFile>();
        for (const file of summary.files || []) {
            map.set(file.path, {
                ...file,
                source: file.source || 'git',
                hasToolDiff: !!(file.hasToolDiff || (typeof file.toolDiff === 'string' && file.toolDiff.trim())),
            });
        }

        for (const entry of splitUnifiedDiffByFile(summary.patch || '')) {
            const existing = map.get(entry.filePath) || this.findTaskChangeFile(map, entry.filePath);
            const counts = countUnifiedDiffChanges(entry.patch);

            if (existing) {
                if ((!existing.added && counts.added) || (!existing.removed && counts.removed)) {
                    existing.added = existing.added || counts.added || 0;
                    existing.removed = existing.removed || counts.removed || 0;
                }
                continue;
            }

            map.set(entry.filePath, {
                path: entry.filePath,
                added: counts.added || 0,
                removed: counts.removed || 0,
                source: 'git',
            });
        }

        const files = Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
        return {
            ...summary,
            files,
            totalAdded: files.reduce((sum, file) => sum + (file.added || 0), 0),
            totalRemoved: files.reduce((sum, file) => sum + (file.removed || 0), 0),
        };
    },

    renderTaskChangesCard(summary: TaskChangeSummary | null, isToolFallback = false): void {
        if (!summary || !summary.files || summary.files.length === 0) return;
        const messagesDiv = document.getElementById('messages')!;
        if (!isToolFallback) {
            messagesDiv.querySelectorAll<HTMLElement>('.task-changes-card[data-tool-fallback="true"]').forEach(el => el.remove());
        }
        summary = this.mergeToolEditedFilesIntoTaskSummary(summary);
        const card = createElement('div', 'task-changes-card');
        card.setAttribute('data-task-change-id', summary.id);
        if (isToolFallback) card.setAttribute('data-tool-fallback', 'true');
        (card as any)._patch = summary.patch;
        (card as any)._fileToolDiffs = Object.fromEntries(
            (summary.files || [])
                .filter(file => typeof file.toolDiff === 'string' && file.toolDiff.trim())
                .map(file => [this.normalizeFileKey(file.path), String(file.toolDiff || '')]),
        );
        if (summary.patch && summary.patch.length <= HISTORY_PATCH_MAX_CHARS) {
            const patchTemplate = createElement('template', 'task-changes-patch');
            patchTemplate.setAttribute('data-kind', 'git-patch');
            patchTemplate.textContent = summary.patch;
            card.appendChild(patchTemplate);
        }
        for (const file of summary.files || []) {
            if (!file.toolDiff || file.toolDiff.length > HISTORY_PATCH_MAX_CHARS) continue;
            const patchTemplate = createElement('template', 'task-changes-patch');
            patchTemplate.setAttribute('data-kind', 'tool-patch');
            patchTemplate.setAttribute('data-file', file.path);
            patchTemplate.textContent = file.toolDiff;
            card.appendChild(patchTemplate);
        }
        for (const [fileKey, patch] of Object.entries((card as any)._fileToolDiffs || {})) {
            if (!patch || String(patch).length > HISTORY_PATCH_MAX_CHARS) continue;
            const hasTemplate = Array.from(card.querySelectorAll<HTMLTemplateElement>('template.task-changes-patch[data-kind="tool-patch"]'))
                .some(node => this.normalizeFileKey(node.getAttribute('data-file') || '') === fileKey);
            if (hasTemplate) continue;
            const matchedFile = (summary.files || []).find(file => this.normalizeFileKey(file.path) === fileKey);
            if (!matchedFile) continue;
            const patchTemplate = createElement('template', 'task-changes-patch');
            patchTemplate.setAttribute('data-kind', 'tool-patch');
            patchTemplate.setAttribute('data-file', matchedFile.path);
            patchTemplate.textContent = String(patch);
            card.appendChild(patchTemplate);
        }

        const fileCount = summary.files.length;
        const fileText = this.formatTaskChangeFileCount(fileCount);
        const hiddenFileCount = Math.max(0, fileCount - TASK_CHANGES_VISIBLE_FILES);
        const patchCountMap = new Map<string, { added: number; removed: number }>();
        for (const entry of splitUnifiedDiffByFile(summary.patch || '')) {
            patchCountMap.set(this.normalizeFileKey(entry.filePath), countUnifiedDiffChanges(entry.patch));
        }
        for (const file of summary.files || []) {
            if (!file.toolDiff) continue;
            patchCountMap.set(this.normalizeFileKey(file.path), countUnifiedDiffChanges(file.toolDiff));
        }
        const normalizedFiles = (summary.files || []).map(file => {
            const patchCounts = patchCountMap.get(this.normalizeFileKey(file.path));
            return patchCounts
                ? { ...file, added: patchCounts.added, removed: patchCounts.removed }
                : file;
        });
        summary = {
            ...summary,
            files: normalizedFiles,
            totalAdded: normalizedFiles.reduce((sum, file) => sum + (file.added || 0), 0),
            totalRemoved: normalizedFiles.reduce((sum, file) => sum + (file.removed || 0), 0),
        };
        const rows = summary.files.map((file, index) => {
            const binary = file.binary ? '<span class="task-change-binary">binary</span>' : '';
            const staged = file.staged ? '<span class="task-change-binary">staged</span>' : '';
            const external = file.source === 'tool' ? '<span class="task-change-binary">tool</span>' : '';
            const action = file.action ? `<span class="task-change-binary">${escapeHtml(file.action)}</span>` : '';
            const collapsedClass = index >= TASK_CHANGES_VISIBLE_FILES ? ' task-change-row-collapsed' : '';
            return `<div class="task-change-entry${collapsedClass}" data-file="${escapeHtml(file.path)}" data-added="${file.added || 0}" data-removed="${file.removed || 0}">` +
                `<button class="task-change-row" type="button" data-file="${escapeHtml(file.path)}">` +
                `<span class="task-change-path">${escapeHtml(file.path)}</span>` +
                `<span class="task-change-row-stats">${binary}${staged}${external}${action}<span class="diff-stats-add">+${file.added} lines</span> <span class="diff-stats-del">-${file.removed} lines</span></span>` +
                `</button></div>`;
        }).join('\n');
        const fileToggle = hiddenFileCount > 0
            ? `<button class="task-changes-files-toggle" type="button" data-expanded="false" data-hidden-count="${hiddenFileCount}"></button>`
            : '';

        card.insertAdjacentHTML('beforeend', `
            <div class="task-changes-head">
                <div class="task-changes-icon"><span class="task-changes-icon-add">+</span><span class="task-changes-icon-del">-</span></div>
                <div class="task-changes-title">
                    <div>${escapeHtml(this.formatTaskChangeEditedTitle(fileCount))}</div>
                    <div class="task-changes-stats"><span class="diff-stats-add">+${summary.totalAdded} lines</span> <span class="diff-stats-del">-${summary.totalRemoved} lines</span></div>
                </div>
                <div class="task-changes-actions">
                    <button class="task-changes-review" type="button">${escapeHtml(t('task.changes.review'))}</button>
                </div>
            </div>
            ${summary.warning ? `<div class="task-changes-warning">${escapeHtml(summary.warning)}</div>` : ''}
            <div class="task-changes-list">${rows}</div>
            ${fileToggle}
            <div class="task-changes-status" aria-live="polite"></div>
        `);

        messagesDiv.appendChild(card);
        this.bindTaskChangeListToggle(card);
        smartScroll(messagesDiv);

        const reviewBtn = card.querySelector<HTMLButtonElement>('.task-changes-review');
        const statusEl = card.querySelector<HTMLElement>('.task-changes-status');
        const titleWrap = card.querySelector<HTMLElement>('.task-changes-title');
        if (titleWrap && !titleWrap.querySelector('.task-changes-title-main')) {
            titleWrap.firstElementChild?.classList.add('task-changes-title-main');
        }
        if (reviewBtn) reviewBtn.textContent = t('task.changes.review');
        card.dataset.canUndo = 'false';
        if (reviewBtn && !summary.patch && !summary.files.some(file => file.hasToolDiff || !!file.toolDiff)) {
            reviewBtn.disabled = true;
            reviewBtn.title = t('task.changes.preview.empty');
        }

        const toggleReview = (targetFile?: string) => {
            const entries = this.getTaskChangePreviewEntries(summary, targetFile);
            const title = targetFile
                ? `MiMo Diff - ${targetFile}`
                : t('task.changes.preview.title').replace('{count}', String(summary.files.length));
            const emptyMessage = targetFile
                ? t('task.changes.preview.empty.file').replace('{file}', targetFile)
                : t('task.changes.preview.empty');
            this.openTaskChangeReview(title, entries, statusEl, emptyMessage);
        };

        reviewBtn?.addEventListener('click', () => toggleReview());
        card.querySelectorAll('.task-change-row').forEach(row => {
            row.addEventListener('click', () => {
                const targetFile = (row as HTMLElement).dataset.file || '';
                const entries = this.getTaskChangePreviewEntries(summary, targetFile);
                this.openTaskChangeFileDiff(
                    `MiMo Diff - ${targetFile}`,
                    targetFile,
                    entries[0]?.patch || '',
                    statusEl,
                    t('task.changes.preview.empty.file').replace('{file}', targetFile),
                );
            });
        });
        this.scheduleHistorySnapshot();
    },

    buildToolDiffCardFromPatch(summary: TaskChangeSummary | null | undefined, filePath: string): HTMLElement | null {
        const file = (summary?.files || []).find(item => this.fileKeysMatch(item.path, filePath));
        const patch = file?.toolDiff || '';
        if (!patch) return null;
        const card = createElement('div', 'diff-card task-tool-diff expanded');
        card.setAttribute('data-file', file?.path || filePath);
        this.renderGitDiff(card, patch);
        return card;
    },

    handleTaskChangesUndoResult(_result: { id?: string; ok?: boolean; error?: string; filePath?: string }): void {
        // Undo is intentionally disabled for task change cards; keep handler as a no-op for compatibility.
    },

    handleTaskChangesRefresh(_summary: TaskChangeSummary | null): void {
        // Undo is intentionally disabled for task change cards; keep handler as a no-op for compatibility.
    },

    getLiveTaskChangeCards(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>('.task-changes-card'))
            .filter(card => !card.classList.contains('history-message'));
    },

    refreshLatestTaskChangeUndoState(): void {
        const cards = this.getLiveTaskChangeCards();
        cards.forEach(card => {
            card.dataset.canUndo = 'false';
            card.classList.remove('task-changes-undone', 'task-changes-pending', 'task-changes-archived');
        });
    },
    handleError(error: string): void {
        const normalizedError = String(error || '').trim();
        if (normalizedError === '(stopped by user)' || /^aborted$/i.test(normalizedError)) {
            this.addSystemMessage('Stopped this task manually.', 'manual-stop');
            store.set('streamingMsg', null);
            store.set('rawHtml', '');
            document.querySelectorAll<HTMLElement>('.live-progress-card[data-active="true"]').forEach(card => card.setAttribute('data-active', 'false'));
            store.set('planExecutionActive', false);
            return;
        }
        // Mark thinking as done on error too
        this._markThinkingDone();

        const messagesDiv = document.getElementById('messages')!;
        const err = createElement('div', 'msg-error');
        if (looksLikeConfigOrApiError(error)) {
            err.classList.add('msg-error-rich');
            err.innerHTML = renderFriendlyErrorHtml(error);
        } else {
            const errText = createElement('span', 'error-text');
            errText.textContent = error;
            err.appendChild(errText);
        }

        const lastUserMsg = store.get('lastUserMsg');
        if (lastUserMsg) {
            const retryBtn = createElement('button', 'retry-btn');
            retryBtn.textContent = '鈫?Retry';
            retryBtn.addEventListener('click', () => {
                const { text, images } = lastUserMsg;
                store.set('lastUserMsg', null);
                vscode.send(text, images);
            });
            err.appendChild(retryBtn);
        }

        messagesDiv.appendChild(err);
        smartScroll(messagesDiv);
        store.set('streamingMsg', null);
        store.set('rawHtml', '');
        document.querySelectorAll<HTMLElement>('.live-progress-card[data-active="true"]').forEach(card => card.setAttribute('data-active', 'false'));
        store.set('planExecutionActive', false);
    },

    // Token usage per call
    renderHistoryTurns(turns: any[]): void {
        const messagesDiv = document.getElementById('messages')!;
        store.set('streamingMsg', null);
        store.set('rawHtml', '');
        store.set('lastUserMsg', null);

        const allTurns = turns || [];
        let index = 0;
        const renderBatch = () => {
            const end = Math.min(index + 12, allTurns.length);
            for (; index < end; index++) {
                this.renderHistoryTurn(allTurns[index], messagesDiv);
            }
            if (index < allTurns.length) {
                requestAnimationFrame(renderBatch);
            } else {
                this.refreshAssistantActionVisibility();
                smartScroll(messagesDiv);
            }
        };
        renderBatch();
    },

    renderHistoryTurn(turn: any, messagesDiv: HTMLElement): void {
            if (turn.snapshot?.assistantHtml) {
                this.renderHistorySnapshotTurn(turn, messagesDiv);
                return;
            }

            const user = turn.user || {};
            this.renderHistoryUserMessage(user.text || '', user.images || null);

            if (!turn.assistantHtml) return;
            const msg = createElement('div', 'msg msg-assistant history-message');
            const meta = turn.meta || {};
            if (meta.hasDetails) {
                const drawer = createElement('div', 'execution-drawer');
                const header = createElement('button', 'execution-drawer-header');
                header.type = 'button';
                header.innerHTML = [
                    `<span class="execution-title">Processed</span>`,
                    `<span class="execution-chevron">&rsaquo;</span>`,
                ].filter(Boolean).join('\n');
                drawer.appendChild(header);
                const body = createElement('div', 'execution-drawer-body');
                drawer.appendChild(body);
                (drawer as any)._detailsHydrated = false;
                const ensureDrawerDetails = () => {
                    if ((drawer as any)._detailsHydrated) return;
                    body.appendChild(this.renderHistoryProcessOverview(meta.details || []));
                    body.appendChild(this.renderHistoryExecutionDetails(meta.details || []));
                    (drawer as any)._detailsHydrated = true;
                };
                header.addEventListener('click', () => {
                    drawer.classList.toggle('open');
                    if (drawer.classList.contains('open')) ensureDrawerDetails();
                });
                msg.appendChild(drawer);
            }

            const content = createElement('div', 'md-content');
            content.innerHTML = formatAssistantBodyHtml(turn.assistantHtml || '');
            msg.appendChild(content);
            this.rebindHistoryCopyButtons(msg);
            this.attachAssistantActions(
                msg,
                { text: user.text || '', images: user.images || null },
                {
                    elapsedSec: Number(meta.elapsedSec || 0) || undefined,
                }
            );
            messagesDiv.appendChild(msg);
    },

    renderHistorySnapshotTurn(turn: any, messagesDiv: HTMLElement): void {
        const snapshot = turn.snapshot || {};
        if (snapshot.userHtml) {
            const userWrap = createElement('div', 'history-snapshot-wrap');
            userWrap.innerHTML = String(snapshot.userHtml);
            this.sanitizeHistorySnapshot(userWrap);
            const userEl = userWrap.firstElementChild as HTMLElement | null;
            if (userEl) {
                this.rehydrateHistorySnapshotUserBubble(userEl);
                messagesDiv.appendChild(userEl);
            } else {
                const user = turn.user || {};
                this.renderHistoryUserMessage(user.text || '', user.images || null);
            }
        } else {
            const user = turn.user || {};
            this.renderHistoryUserMessage(user.text || '', user.images || null);
        }

        const wrap = createElement('div', 'history-snapshot-wrap');
        wrap.innerHTML = String(snapshot.assistantHtml || '');
        this.sanitizeHistorySnapshot(wrap);
        const nodes = Array.from(wrap.children) as HTMLElement[];
        if (nodes.length === 0) return;
        nodes.forEach(node => {
            node.classList.add('history-message', 'history-snapshot-message');
            node.classList.remove('streaming');
        });
        wrap.querySelectorAll<HTMLElement>('.tool-line[data-status="running"], .tool-card[data-status="running"]').forEach(el => {
            el.setAttribute('data-status', 'success');
        });
        this.rebindHistorySnapshotInteractions(wrap, turn.meta?.details || [], turn.snapshot?.taskChanges || []);
        this.rebindHistoryCopyButtons(wrap);
        for (const node of nodes) {
            if (node.classList.contains('msg-assistant')) {
                const user = turn.user || {};
                this.attachAssistantActions(
                    node,
                    { text: user.text || '', images: user.images || null },
                    {
                        elapsedSec: Number(turn.snapshot?.elapsedSec || turn.meta?.elapsedSec || 0) || undefined,
                    }
                );
            }
            messagesDiv.appendChild(node);
        }
        this.renderHistoryDiffFallback(turn, messagesDiv);
    },

    rehydrateHistorySnapshotUserBubble(bubble: HTMLElement): void {
        if (!bubble.classList.contains('msg-user')) return;
        bubble.classList.add('history-message');
        this.rebindHistoryCopyButtons(bubble);
        installUserBubbleCollapse(bubble);
    },

    renderHistoryDiffFallback(turn: any, messagesDiv: HTMLElement): void {
        const details = Array.isArray(turn?.meta?.details) ? turn.meta.details : [];
        if (!details.length) return;
        const hasDiffUi = messagesDiv.lastElementChild?.classList.contains('task-changes-card') ||
            messagesDiv.lastElementChild?.classList.contains('diff-card');
        if (hasDiffUi) return;
        const diff = details
            .map((d: any) => ({
                title: String(d?.title || ''),
                body: String(d?.body || ''),
            }))
            .find((d: any) => d.body.includes('diff --git') || /(^|[._-])git[_-]?diff$/i.test(d.title));
        if (!diff?.body || !diff.body.includes('diff --git')) return;

        const card = createElement('div', 'diff-card history-diff-card');
        card.innerHTML =
            `<div class="diff-card-header">` +
            `<span class="diff-card-icon">卤</span>` +
            `<span class="diff-card-title">鍘嗗彶 Diff</span>` +
            `<span class="diff-card-toggle">灞曞紑</span>` +
            `</div><div class="diff-card-body"></div>`;
        const body = card.querySelector<HTMLElement>('.diff-card-body');
        if (body) renderMessageGitDiff(body, diff.body);
        card.querySelector<HTMLElement>('.diff-card-header')?.addEventListener('click', () => {
            card.classList.toggle('expanded');
        });
        messagesDiv.appendChild(card);
    },

    rebindHistoryCopyButtons(root: HTMLElement): void {
        root.querySelectorAll<HTMLElement>('.msg-copy').forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });
        root.querySelectorAll<HTMLElement>('.copy-btn').forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });

        root.querySelectorAll<HTMLElement>('.msg-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const bubble = btn.closest('.msg');
                if (!(bubble instanceof HTMLElement)) return;
                const payload = extractBubbleClipboardPayload(bubble);
                writeClipboardPayload(payload).then(() => {
                    setCopyButtonState(btn, true);
                    setTimeout(() => setCopyButtonState(btn, false), 1600);
                }).catch(() => {});
            });
        });

        root.querySelectorAll<HTMLElement>('.copy-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const block = btn.closest('.code-block');
                const code = block?.querySelector('code');
                if (!code) return;
                const text = code.textContent || '';
                navigator.clipboard.writeText(text).then(() => {
                    btn.textContent = 'Copied!';
                    btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
                }).catch(() => {});
            });
        });

        root.querySelectorAll<HTMLImageElement>('.msg-img').forEach(img => {
            img.addEventListener('click', (e) => {
                e.stopPropagation();
                const src = img.getAttribute('src') || '';
                if (src) bus.emit('showOverlay', src);
            });
        });
    },

    sanitizeHistorySnapshot(root: HTMLElement): void {
        root.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach(el => el.remove());
        this.removeExecutionMetaChips(root);
        const urlAttrs = new Set(['href', 'src', 'xlink:href', 'formaction', 'action']);
        root.querySelectorAll<HTMLElement>('*').forEach(el => {
            if (el.tagName === 'FORM') {
                el.replaceWith(...Array.from(el.childNodes));
                return;
            }
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                const value = (attr.value || '').trim();
                const safeImageDataUrl = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
                if (
                    name.startsWith('on') ||
                    name === 'srcdoc' ||
                    name === 'data-reasoning-text' ||
                    urlAttrs.has(name) && !this.isSafeHistorySnapshotUrl(value) && !safeImageDataUrl ||
                    (/^\s*(?:javascript|data|vbscript|file|blob):/i.test(value) && !safeImageDataUrl)
                ) {
                    el.removeAttribute(attr.name);
                }
            }
        });
    },

    removeExecutionMetaChips(root: ParentNode): void {
        root.querySelectorAll('.execution-drawer .execution-meta').forEach(el => el.remove());
    },

    isSafeHistorySnapshotUrl(value: string): boolean {
        if (!value) return false;
        if (value.startsWith('#')) return true;
        if (/^https?:\/\//i.test(value)) return true;
        if (/^(?:localhost|127\.0\.0\.1):\d+(?:[/?#]|$)/i.test(value)) return true;
        return false;
    },

    isThinkingCompactPlaceholder(text: string): boolean {
        return /(?:chars?\s+captured|Click to expand|宸叉崟鑾穦鐐瑰嚮灞曞紑)/i.test(String(text || ''));
    },

    hydrateHistoryTaskChangeSnapshotCard(card: HTMLElement, snapshot?: HistoryTaskChangeSnapshot): void {
        if (!snapshot) return;
        if (snapshot.gitPatch) {
            (card as any)._patch = snapshot.gitPatch;
            if (!card.querySelector('template.task-changes-patch[data-kind="git-patch"]')) {
                const patchTemplate = createElement('template', 'task-changes-patch');
                patchTemplate.setAttribute('data-kind', 'git-patch');
                patchTemplate.textContent = snapshot.gitPatch;
                card.prepend(patchTemplate);
            }
        }
        const toolDiffs = { ...((card as any)._fileToolDiffs || {}) } as Record<string, string>;
        for (const entry of snapshot.toolPatches || []) {
            const key = this.normalizeFileKey(entry.filePath);
            if (!key || !entry.patch) continue;
            toolDiffs[key] = entry.patch;
            const hasTemplate = Array.from(card.querySelectorAll<HTMLTemplateElement>('template.task-changes-patch[data-kind="tool-patch"]'))
                .some(node => this.fileKeysMatch(node.getAttribute('data-file') || '', entry.filePath));
            if (!hasTemplate) {
                const patchTemplate = createElement('template', 'task-changes-patch');
                patchTemplate.setAttribute('data-kind', 'tool-patch');
                patchTemplate.setAttribute('data-file', entry.filePath);
                patchTemplate.textContent = entry.patch;
                card.appendChild(patchTemplate);
            }
        }
        if (Object.keys(toolDiffs).length > 0) {
            (card as any)._fileToolDiffs = toolDiffs;
        }
    },

    rebindHistorySnapshotInteractions(root: HTMLElement, details: any[] = [], snapshotTaskChanges: HistoryTaskChangeSnapshot[] = []): void {
        const savedThoughts = (Array.isArray(details) ? details : [])
            .filter(d => d?.type === 'reasoning' && String(d.body || '').trim());
        let thoughtIndex = 0;

        root.querySelectorAll<HTMLElement>('.msg-user').forEach(bubble => {
            this.rehydrateHistorySnapshotUserBubble(bubble);
        });

        root.querySelectorAll<HTMLButtonElement>('.execution-drawer-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.execution-drawer')?.classList.toggle('open');
            });
        });

        root.querySelectorAll<HTMLElement>('.thinking-block').forEach(block => {
            const visibleText = String(block.textContent || '').trim();
            let reasoningText = (block as any)._reasoningText || block.dataset.reasoningText || '';
            if (!reasoningText && visibleText && !this.isThinkingCompactPlaceholder(visibleText)) {
                reasoningText = visibleText;
            }
            if (!reasoningText) {
                const saved = savedThoughts[thoughtIndex];
                if (saved?.body) reasoningText = String(saved.body);
            }
            thoughtIndex++;
            if (!reasoningText) return;
            (block as any)._reasoningText = reasoningText;
            (block as any)._reasoningTrimmed = block.dataset.reasoningTrimmed === 'true';
            delete block.dataset.reasoningText;
            block.dataset.historyReasoning = 'true';
            block.dataset.reasoningTrimmed = (block as any)._reasoningTrimmed ? 'true' : 'false';
            block.title = t('thinking.expand.title');
            this.renderThinkingBlock(block, block.classList.contains('show'), false);
            block.addEventListener('click', () => {
                if (block.classList.contains('show')) return;
                const toggle = block.previousElementSibling as HTMLElement | null;
                block.classList.add('show');
                toggle?.classList.add('open');
                this.renderThinkingBlock(block, true, false);
            });
        });

        root.querySelectorAll<HTMLElement>('.thinking-toggle').forEach(toggle => {
            const dot = toggle.querySelector('.thinking-dot');
            const lbl = toggle.querySelector('span:nth-child(2)') as HTMLElement | null;
            if (lbl) lbl.textContent = dot?.classList.contains('done') ? t('thought') : t('thinking');
            toggle.addEventListener('click', () => {
                const block = toggle.nextElementSibling as HTMLElement | null;
                if (!block?.classList.contains('thinking-block')) return;
                const open = !block.classList.contains('show');
                block.classList.toggle('show', open);
                toggle.classList.toggle('open', open);
                this.renderThinkingBlock(block, open, false);
            });
        });

        root.querySelectorAll<HTMLElement>('.diff-card-header').forEach(header => {
            header.addEventListener('click', () => {
                header.closest('.diff-card')?.classList.toggle('expanded');
            });
        });

        const taskChangeCards = Array.from(root.querySelectorAll<HTMLElement>('.task-changes-card'));
        taskChangeCards.forEach((card, index) => {
            this.hydrateHistoryTaskChangeSnapshotCard(card, snapshotTaskChanges[index]);
            this.bindTaskChangeListToggle(card);
        });

        root.querySelectorAll<HTMLButtonElement>('.task-changes-review').forEach(btn => {
            const card = btn.closest('.task-changes-card') as HTMLElement | null;
            const diffEl = card?.querySelector<HTMLElement>('.task-changes-diff');
            const hasToolPatch = !!card?.querySelector('template.task-changes-patch[data-kind="tool-patch"]');
            if (!this.getHistoryTaskChangesPatch(card, details) && !hasToolPatch && diffEl && !diffEl.hasChildNodes()) {
                btn.disabled = true;
                btn.title = t('task.changes.preview.empty.history');
            }
            btn.addEventListener('click', () => {
                const entries = this.getHistoryTaskChangePreviewEntries(card, details);
                const fileCount = entries.length || card?.querySelectorAll('.task-change-row').length || 0;
                this.openTaskChangeReview(
                    t('task.changes.preview.title').replace('{count}', String(fileCount)),
                    entries,
                    card?.querySelector<HTMLElement>('.task-changes-status'),
                    t('task.changes.preview.empty.history'),
                );
            });
        });

        root.querySelectorAll<HTMLButtonElement>('.task-change-row').forEach(row => {
            row.addEventListener('click', () => {
                const card = row.closest('.task-changes-card') as HTMLElement | null;
                const targetFile = row.dataset.file || '';
                const entries = this.getHistoryTaskChangePreviewEntries(card, details, targetFile);
                this.openTaskChangeFileDiff(
                    `MiMo Diff - ${targetFile}`,
                    targetFile,
                    entries[0]?.patch || '',
                    card?.querySelector<HTMLElement>('.task-changes-status'),
                    t('task.changes.preview.empty.file.history').replace('{file}', targetFile),
                );
            });
        });
    },
    getHistoryTaskChangesPatch(card: HTMLElement | null | undefined, details: any[] = []): string {
        if (!card) return '';
        const runtimePatch = (card as any)._patch;
        if (typeof runtimePatch === 'string' && runtimePatch) return runtimePatch;
        const tpl = card.querySelector<HTMLTemplateElement>('template.task-changes-patch[data-kind="git-patch"]');
        const patch = tpl?.content?.textContent || tpl?.textContent || '';
        if (patch) {
            (card as any)._patch = patch;
            return patch;
        }
        const detailPatch = this.findHistoryDiffFromDetails(details);
        if (detailPatch) (card as any)._patch = detailPatch;
        return detailPatch;
    },

    getHistoryTaskChangesToolPatch(card: HTMLElement | null | undefined, filePath: string): string {
        if (!card) return '';
        const key = this.normalizeFileKey(filePath);
        const cache = (card as any)._fileToolDiffs;
        if (cache && typeof cache[key] === 'string' && cache[key]) return cache[key];
        const tpl = Array.from(card.querySelectorAll<HTMLTemplateElement>('template.task-changes-patch[data-kind="tool-patch"]'))
            .find(node => this.fileKeysMatch(node.getAttribute('data-file') || '', filePath));
        const patch = tpl?.content?.textContent || tpl?.textContent || '';
        if (patch) {
            (card as any)._fileToolDiffs = { ...(cache || {}), [key]: patch };
        }
        return patch;
    },

    ensureHistoryTaskChangesToolPatchTemplate(card: HTMLElement | null | undefined, filePath: string): string {
        if (!card) return '';
        const existing = Array.from(card.querySelectorAll<HTMLTemplateElement>('template.task-changes-patch[data-kind="tool-patch"]'))
            .find(node => this.fileKeysMatch(node.getAttribute('data-file') || '', filePath));
        if (existing) {
            return existing.content?.textContent || existing.textContent || '';
        }
        const patch = this.getHistoryTaskChangesToolPatch(card, filePath);
        if (!patch) return '';
        const tpl = createElement('template', 'task-changes-patch');
        tpl.setAttribute('data-kind', 'tool-patch');
        tpl.setAttribute('data-file', filePath);
        tpl.textContent = patch;
        card.appendChild(tpl);
        return patch;
    },

    findHistoryDiffFromDetails(details: any[] = []): string {
        if (!Array.isArray(details)) return '';
        const found = details
            .map(d => ({
                title: String(d?.title || ''),
                body: String(d?.body || ''),
            }))
            .find(d => d.body.includes('diff --git') || /(^|[._-])git[_-]?diff$/i.test(d.title));
        return found?.body?.includes('diff --git') ? found.body : '';
    },

    ensureHistoryTaskChangesDiff(card: HTMLElement | null | undefined, diffEl: HTMLElement, details: any[] = []): void {
        if (diffEl.querySelector('.diff-file-header')) return;
        const patch = this.getHistoryTaskChangesPatch(card, details);
        if (!patch) return;
        diffEl.innerHTML = '';
        renderMessageGitDiff(diffEl, patch);
    },

    renderHistoryProcessOverview(details: any[]): HTMLElement {
        const wrap = createElement('div', 'history-process-overview');
        const list = Array.isArray(details) ? details : [];
        const thoughts = list.filter(d => d?.type === 'reasoning' && String(d.body || '').trim());
        const tools = list.filter(d => d?.type === 'tool');
        const errors = tools.filter(d => d?.isError);

        const thoughtPreview = thoughts
            .map(d => this.previewHistoryDetail(d, 220))
            .find(Boolean);

        const stats = createElement('div', 'history-process-stats');
        stats.innerHTML = [
            thoughts.length ? `<span class="history-process-pill thought">${thoughts.length} ${escapeHtml(t('thought'))}</span>` : '',
            tools.length ? `<span class="history-process-pill tool">${tools.length} Tools</span>` : '',
            errors.length ? `<span class="history-process-pill error">${errors.length} Error</span>` : '',
        ].filter(Boolean).join('\n');
        if (stats.innerHTML) wrap.appendChild(stats);

        if (thoughtPreview) {
            const thought = createElement('div', 'history-thought-preview');
            thought.innerHTML =
                `<span class="history-thought-label">${escapeHtml(t('thought'))}</span>` +
                `<span class="history-thought-text">${escapeHtml(thoughtPreview)}</span>`;
            wrap.appendChild(thought);
        }

        if (tools.length > 0) {
            const toolRow = createElement('div', 'history-tool-chips');
            const shown = tools.slice(0, 10);
            const counts = new Map<string, number>();
            for (const tool of shown) {
                const name = String(tool.title || 'tool');
                counts.set(name, (counts.get(name) || 0) + 1);
            }
            for (const [name, count] of counts) {
                const chip = createElement('span', `history-tool-chip${errors.some(d => d.title === name && d.isError) ? ' error' : ''}`);
                chip.textContent = `${this.getToolLabel(name) || name}${count > 1 ? ` x${count}` : ''}`;
                toolRow.appendChild(chip);
            }
            if (tools.length > shown.length) {
                const more = createElement('span', 'history-tool-chip muted');
                more.textContent = `+${tools.length - shown.length}`;
                toolRow.appendChild(more);
            }
            wrap.appendChild(toolRow);
        }

        if (!wrap.children.length) {
            const empty = createElement('div', 'history-detail-empty');
            empty.textContent = 'No process summary was saved for this turn.';
            wrap.appendChild(empty);
        }
        return wrap;
    },

    previewHistoryDetail(detail: any, maxLen = 120): string {
        const sourceText = detail?.type === 'reasoning'
            ? sanitizeMessageReasoningForHistoryDisplay(String(detail?.body || ''), false)
            : String(detail?.body || '');
        const text = sourceText
            .replace(/\[reasoning compacted for context\]/gi, '')
            .replace(/\[reasoning omitted for context\]/gi, '')
            .replace(/\[Earlier reasoning trimmed[^\]]*\]/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) return '';
        return text.length > maxLen ? `${text.slice(0, maxLen).trim()}...` : text;
    },

    renderHistoryExecutionDetails(details: any[]): HTMLElement {
        const wrap = createElement('div', 'execution-details history-execution-details');
        if (!details || details.length === 0) {
            const empty = createElement('div', 'history-detail-empty');
            empty.textContent = 'No process details were saved for this turn.';
            wrap.appendChild(empty);
            return wrap;
        }

        for (const detail of details) {
            const item = createElement('details', `history-detail history-detail-${detail.type || 'item'}`) as HTMLDetailsElement;
            const summary = createElement('summary', 'history-detail-summary');
            const rawTitle = String(detail.title || detail.type || 'detail');
            const title = escapeHtml(detail.type === 'tool' ? (this.getToolLabel(rawTitle) || rawTitle) : (detail.type === 'reasoning' ? t('thought') : rawTitle));
            const elapsed = Number(detail.elapsedSec || 0);
            const preview = this.previewHistoryDetail(detail, 110);
            summary.innerHTML =
                `<span class="history-detail-title">${title}</span>` +
                (preview ? `<span class="history-detail-preview">${escapeHtml(preview)}</span>` : '') +
                (elapsed > 0 ? `<span class="history-detail-time">${this.formatDuration(elapsed)}</span>` : '');
            const bodyText = detail.type === 'reasoning'
                ? sanitizeMessageReasoningForHistoryDisplay(String(detail.body || ''), false)
                : String(detail.body || '').trim() || '(empty)';
            const isFriendlyError = !!detail.isError && looksLikeConfigOrApiError(bodyText);
            const body = isFriendlyError
                ? createElement('div', 'history-detail-body history-detail-body-rich')
                : createElement('pre', 'history-detail-body');
            body.textContent = bodyText;
            if (isFriendlyError) {
                body.innerHTML = renderFriendlyErrorHtml(bodyText);
            }
            if (detail.isError) item.classList.add('history-detail-error');
            item.appendChild(summary);
            item.appendChild(body);
            wrap.appendChild(item);
        }
        return wrap;
    },

    renderHistoryUserMessage(text: string, images?: ImageData[] | null): void {
        const messagesDiv = document.getElementById('messages')!;
        const delegatedBubble = createUserBubble(text, images, 'msg msg-user history-message');
        const hasDelegatedVisibleMessages = Array.from(messagesDiv.children)
            .some(child => !(child as HTMLElement).classList.contains('sticky-user-preview'));
        if (hasDelegatedVisibleMessages) {
            delegatedBubble.style.marginTop = '20px';
        }
        messagesDiv.appendChild(delegatedBubble);
        installUserBubbleCollapse(delegatedBubble, images, text);
    },

    handleTokenUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): void {
        // Update store
        const prev = store.get('tokenUsage');
        store.set('tokenUsage', {
            prompt: prev.prompt + usage.promptTokens,
            completion: prev.completion + usage.completionTokens,
            total: prev.total + usage.totalTokens,
            calls: prev.calls + 1,
        });

        // Update status bar with running total
        const total = store.get('tokenUsage').total;
        const statusEl = document.getElementById('token-counter');
        if (statusEl) {
            statusEl.textContent = formatTokenCount(total);
            statusEl.style.display = '';
        }
    },

    // Conversation usage summary
    handleConversationUsage(usage: { totalTokens: number; callCount: number }): void {
        // Update the token counter with final conversation total
        const statusEl = document.getElementById('token-counter');
        if (statusEl) {
            statusEl.textContent = formatTokenCount(usage.totalTokens);
            statusEl.style.display = '';
        }
    },

    // Workflow rendering
    getWorkflowState(): WorkflowUiState | null {
        const streamingMsg = store.get('streamingMsg') as any;
        return streamingMsg?._workflowState || null;
    },

    ensureWorkflowPhase(state: WorkflowUiState, phaseIndex: number): { title: string; mode: string; tasks: Array<{ label: string; result?: any }> } {
        while (state.phases.length <= phaseIndex) {
            state.phases.push({ title: `Phase ${state.phases.length + 1}`, mode: 'sequential', tasks: [] });
        }
        return state.phases[phaseIndex];
    },

    renderWorkflowSummary(state: WorkflowUiState, force = false): void {
        const now = Date.now();
        if (!force && now - state.lastRenderedAt < WORKFLOW_UPDATE_INTERVAL_MS) return;
        state.lastRenderedAt = now;
        const progressEl = state.card.querySelector('.workflow-progress') as HTMLElement | null;
        if (!progressEl) return;
        const elapsed = this.formatDuration(Math.max(0, (now - state.startedAt) / 1000));
        const usage = store.get('tokenUsage');
        const tokenText = usage.total > 0 ? `${formatTokenCount(usage.total)} tokens` : '0 tokens';
        const current = state.ended ? 'done' : `${state.completedTasks}/${state.totalTasks || '?'} running`;
        progressEl.textContent = `${tokenText} | ${elapsed || '0.0s'} | ${current}`;
    },

    renderWorkflowDetails(state: WorkflowUiState): void {
        const phasesDiv = state.card.querySelector('.workflow-phases') as HTMLElement | null;
        if (!phasesDiv || (phasesDiv as any)._renderedDetails) return;
        if (!state.ended && state.totalTasks > 18) {
            phasesDiv.innerHTML = `<div class="workflow-detail-placeholder">Live workflow details are deferred until the workflow finishes to keep the UI responsive.</div>`;
            (phasesDiv as any)._renderedDetails = true;
            return;
        }
        phasesDiv.replaceChildren();
        state.phases.forEach((phase, phaseIndex) => {
            const phaseDiv = createElement('div', 'workflow-phase');
            phaseDiv.setAttribute('data-phase', String(phaseIndex));
            phaseDiv.innerHTML = `<div class="workflow-phase-header">` +
                `<span class="workflow-phase-title">Phase ${phaseIndex + 1}: ${escapeHtml(phase.title)}</span>` +
                `<span class="workflow-phase-mode">${escapeHtml(phase.mode)}</span>` +
                `</div><div class="workflow-tasks"></div>`;
            const tasksDiv = phaseDiv.querySelector('.workflow-tasks') as HTMLElement;
            phase.tasks.forEach((task) => {
                const taskDiv = createElement('div', `workflow-task${task.result?.error ? ' task-error' : ''}`);
                const status = task.result ? (task.result.error ? 'error' : 'done') : 'running';
                const elapsed = task.result?.elapsed ? `${(task.result.elapsed / 1000).toFixed(1)}s` : '';
                taskDiv.innerHTML = `<span class="workflow-task-status">${status}</span>` +
                    `<span class="workflow-task-label">${escapeHtml(task.label)}</span>` +
                    `<span class="workflow-task-time">${elapsed}</span>`;
                tasksDiv.appendChild(taskDiv);
            });
            phasesDiv.appendChild(phaseDiv);
        });
        (phasesDiv as any)._renderedDetails = true;
    },

    handleWorkflowStart(totalPhases: number, totalTasks: number): void {
        let streamingMsg = store.get('streamingMsg');
        const messagesDiv = document.getElementById('messages')!;
        if (!streamingMsg) {
            streamingMsg = this.createAssistantMsg();
            const mc = createElement('div', 'md-content');
            streamingMsg.appendChild(mc);
            store.set('streamingMsg', streamingMsg);
            store.set('rawHtml', '');
        }

        const card = createElement('div', 'workflow-card');
        card.setAttribute('data-phase-count', String(totalPhases));
        card.setAttribute('data-task-count', String(totalTasks));
        card.innerHTML = `<div class="workflow-header">` +
            `<div class="workflow-title">Workflow <span class="workflow-progress">0 tokens | 0.0s | 0/${totalTasks} running</span></div>` +
            `</div><div class="workflow-phases"></div>`;
        streamingMsg.appendChild(card);
        const mdContent = streamingMsg.querySelector('.md-content');
        if (mdContent) streamingMsg.appendChild(mdContent);
        const state: WorkflowUiState = {
            card,
            phases: [],
            totalTasks,
            completedTasks: 0,
            startedAt: Date.now(),
            lastRenderedAt: 0,
            ended: false,
        };
        (streamingMsg as any)._workflowState = state;
        card.querySelector('.workflow-header')?.addEventListener('click', () => {
            card.classList.toggle('expanded');
            if (card.classList.contains('expanded')) this.renderWorkflowDetails(state);
        });
        this.renderWorkflowSummary(state, true);
        smartScroll(messagesDiv);
    },

    handleWorkflowPhaseStart(phaseIndex: number, title: string, mode: string, _taskCount: number): void {
        const state = this.getWorkflowState();
        if (!state) return;
        const phase = this.ensureWorkflowPhase(state, phaseIndex);
        phase.title = title;
        phase.mode = mode;
        this.renderWorkflowSummary(state);
    },

    handleWorkflowTaskStart(phaseIndex: number, taskIndex: number, label: string): void {
        const state = this.getWorkflowState();
        if (!state) return;
        const phase = this.ensureWorkflowPhase(state, phaseIndex);
        phase.tasks[taskIndex] = { label };
        this.renderWorkflowSummary(state);
    },

    handleWorkflowTaskEnd(phaseIndex: number, taskIndex: number, result: any): void {
        const state = this.getWorkflowState();
        if (!state) return;
        const phase = this.ensureWorkflowPhase(state, phaseIndex);
        const current = phase.tasks[taskIndex] || { label: `Task ${taskIndex + 1}` };
        if (!current.result) state.completedTasks++;
        current.result = result;
        phase.tasks[taskIndex] = current;
        const phasesDiv = state.card.querySelector('.workflow-phases') as HTMLElement | null;
        if (phasesDiv) (phasesDiv as any)._renderedDetails = false;
        this.renderWorkflowSummary(state);
    },

    handleWorkflowPhaseEnd(_phaseIndex: number, _result: any): void {
        const state = this.getWorkflowState();
        if (state) this.renderWorkflowSummary(state);
    },

    handleWorkflowEnd(result: any): void {
        const state = this.getWorkflowState();
        if (!state) return;
        state.ended = true;
        if (result?.phases) {
            state.totalTasks = result.phases.reduce((sum: number, phase: any) => sum + (phase.results?.length || 0), 0);
            state.completedTasks = state.totalTasks;
        }
        this.renderWorkflowSummary(state, true);
        if (state.card.classList.contains('expanded')) this.renderWorkflowDetails(state);
        smartScroll(document.getElementById('messages')!);
    },

    bindDeferredToolResult(card: HTMLElement, render: () => void): void {
        if ((card as any)._deferredToolBound) return;

        const ensureRendered = () => {
            if ((card as any)._deferredToolRendered || (card as any)._deferredToolRendering) return;
            (card as any)._deferredToolRendering = true;
            const result = card.querySelector<HTMLElement>('.tool-result');
            result?.classList.add('is-loading');
            requestAnimationFrame(() => {
                try {
                    render();
                    (card as any)._deferredToolRendered = true;
                } finally {
                    (card as any)._deferredToolRendering = false;
                    result?.classList.remove('is-loading');
                }
            });
        };

        card.addEventListener('cardCollapseChange', ((event: Event) => {
            const detail = (event as CustomEvent<{ collapsed?: boolean }>).detail;
            if (!detail?.collapsed) ensureRendered();
        }) as EventListener);

        if (!card.classList.contains('collapsed')) ensureRendered();
        (card as any)._deferredToolBound = true;
    },

    // Edit preview with Accept/Reject
    renderEditPreviewCard(
        previewId: string,
        filePath: string,
        oldText: string,
        newText: string,
        matchCount: number,
        lineStart?: number,
        _lineEnd?: number,
    ): void {
        const messagesDiv = document.getElementById('messages')!;
        const card = createElement('div', 'tool-card edit-preview-card');
        card.setAttribute('data-status', 'running');
        card.setAttribute('data-tool', 'edit_file');
        card.setAttribute('data-file', filePath);
        card.setAttribute('data-action', 'edit');
        {
            const oldLinesLite = oldText.split('\n');
            const newLinesLite = newText.split('\n');
            const canPrecomputeCounts = oldLinesLite.length * newLinesLite.length <= 4000
                && (oldText.length + newText.length) <= 24_000;
            const tinyDiff = canPrecomputeCounts ? this.computeDiff(oldLinesLite, newLinesLite) : [];
            const textChanged = oldText !== newText;
            const addedLite = tinyDiff.length > 0
                ? tinyDiff.filter(d => d.type === 'add').length
                : textChanged
                    ? Math.max(1, newLinesLite.length - oldLinesLite.length, 0)
                    : 0;
            const removedLite = tinyDiff.length > 0
                ? tinyDiff.filter(d => d.type === 'del').length
                : textChanged
                    ? Math.max(1, oldLinesLite.length - newLinesLite.length, 0)
                    : 0;
            card.setAttribute('data-added', String(addedLite));
            card.setAttribute('data-removed', String(removedLite));

            card.innerHTML = `<div class="tool-header">` +
                `<div class="tool-icon-wrapper"><div class="tool-icon">E</div><div class="tool-status-dot"></div></div>` +
                `<div class="tool-info"><span class="tool-name">edit_file</span><span class="tool-args">${escapeHtml(filePath)}</span></div>` +
                `<div class="tool-meta"><span class="tool-elapsed">Preview</span><span class="tool-chevron">鈻?/span></div>` +
                `</div><div class="tool-body"><div class="tool-result"><div class="diff-line"><span class="diff-info">Expand to render the edit preview.</span></div></div>` +
                `<div class="edit-preview-actions"><button class="edit-accept-btn">Accept</button><button class="edit-reject-btn">Reject</button></div></div>`;

            const renderDiff = () => {
                const result = card.querySelector<HTMLElement>('.tool-result');
                if (!result) return;

                const shouldRenderDetailedDiff = oldLinesLite.length * newLinesLite.length <= 20000
                    && (oldText.length + newText.length) <= 120000;
                const diffLite = shouldRenderDetailedDiff ? (tinyDiff.length > 0 ? tinyDiff : this.computeDiff(oldLinesLite, newLinesLite)) : [];
                const exactAdded = diffLite.length > 0
                    ? diffLite.filter(d => d.type === 'add').length
                    : addedLite;
                const exactRemoved = diffLite.length > 0
                    ? diffLite.filter(d => d.type === 'del').length
                    : removedLite;
                card.setAttribute('data-added', String(exactAdded));
                card.setAttribute('data-removed', String(exactRemoved));

                const startBaseLite = Number.isFinite(Number(lineStart)) && Number(lineStart) > 0 ? Math.floor(Number(lineStart)) - 1 : 0;
                let oldLineNumLite = startBaseLite;
                let newLineNumLite = startBaseLite;
                const maxShowLite = Math.min(diffLite.length, 12);
                let diffHtmlLite = `<div class="diff-header-line"><span class="diff-stats">+${exactAdded} -${exactRemoved}</span><span class="diff-match">${matchCount} match(es)</span></div>`;
                if (diffLite.length === 0) {
                    diffHtmlLite += `<div class="diff-line"><span class="diff-info">Large edit preview kept collapsed for performance.</span></div>`;
                } else {
                    for (const part of diffLite.slice(0, maxShowLite)) {
                        if (part.type === 'del') {
                            oldLineNumLite++;
                            diffHtmlLite += `<div class="diff-line"><span class="diff-ln">${oldLineNumLite}</span><span class="diff-del">- ${escapeHtml(part.text).substring(0, 140)}</span></div>`;
                        } else if (part.type === 'add') {
                            newLineNumLite++;
                            diffHtmlLite += `<div class="diff-line"><span class="diff-ln">${newLineNumLite}</span><span class="diff-add">+ ${escapeHtml(part.text).substring(0, 140)}</span></div>`;
                        } else {
                            oldLineNumLite++;
                            newLineNumLite++;
                            diffHtmlLite += `<div class="diff-line"><span class="diff-ln">${newLineNumLite}</span><span class="diff-ctx">${escapeHtml(part.text).substring(0, 140)}</span></div>`;
                        }
                    }
                    if (diffLite.length > maxShowLite) {
                        diffHtmlLite += `<div class="diff-line"><span class="diff-ln">...</span><span class="diff-info">... ${diffLite.length - maxShowLite} more lines</span></div>`;
                    }
                }
                result.innerHTML = diffHtmlLite;
            };

            const acceptBtnLite = card.querySelector('.edit-accept-btn');
            if (acceptBtnLite) acceptBtnLite.addEventListener('click', () => {
                vscode.editConfirm(previewId);
                card.setAttribute('data-status', 'success');
                const dot = card.querySelector('.tool-status-dot') as HTMLElement | null;
                if (dot) dot.style.background = 'var(--vscode-testing-iconPassed, #4ec9b0)';
                const elapsed = card.querySelector('.tool-elapsed') as HTMLElement | null;
                if (elapsed) elapsed.textContent = 'Applied';
                const actions = card.querySelector('.edit-preview-actions') as HTMLElement | null;
                actions?.remove();
                card.classList.add('collapsed');
            });

            const rejectBtnLite = card.querySelector('.edit-reject-btn');
            if (rejectBtnLite) rejectBtnLite.addEventListener('click', () => {
                vscode.editReject(previewId);
                card.setAttribute('data-status', 'error');
                card.classList.add('tool-error');
                const dot = card.querySelector('.tool-status-dot') as HTMLElement | null;
                if (dot) dot.style.background = 'var(--vscode-testing-iconFailed, #f44747)';
                const elapsed = card.querySelector('.tool-elapsed') as HTMLElement | null;
                if (elapsed) elapsed.textContent = 'Rejected';
                const actions = card.querySelector('.edit-preview-actions') as HTMLElement | null;
                actions?.remove();
                card.classList.add('collapsed');
            });

            messagesDiv.appendChild(card);
            this.makeCardCollapsible(card, '.tool-header', true);
            this.bindDeferredToolResult(card, renderDiff);
            smartScroll(messagesDiv);
            return;
        }

    },

    renderWritePreviewCard(previewId: string, filePath: string, content: string, isCreate: boolean, oldText?: string): void {
        const messagesDiv = document.getElementById('messages')!;
        const card = createElement('div', 'tool-card write-preview-card expanded');
        card.setAttribute('data-status', 'running');
        card.setAttribute('data-tool', 'write_file');
        card.setAttribute('data-file', filePath);
        card.setAttribute('data-action', isCreate ? 'create' : 'write');
        {
            const finishWriteCardLite = (status: 'success' | 'error', label: string) => {
                card.setAttribute('data-status', status);
                if (status === 'error') card.classList.add('tool-error');
                const dot = card.querySelector('.tool-status-dot') as HTMLElement | null;
                if (dot) {
                    dot.style.background = status === 'success'
                        ? 'var(--vscode-testing-iconPassed, #4ec9b0)'
                        : 'var(--vscode-testing-iconFailed, #f44747)';
                }
                const elapsed = card.querySelector('.tool-elapsed') as HTMLElement | null;
                if (elapsed) elapsed.textContent = label;
                const actions = card.querySelector('.edit-preview-actions') as HTMLElement | null;
                actions?.remove();
                card.classList.add('collapsed');
            };

            if (!isCreate && oldText) {
                const oldLinesLite = oldText.split('\n');
                const newLinesLite = content.split('\n');
                const canPrecomputeCounts = oldLinesLite.length * newLinesLite.length <= 4000
                    && (oldText.length + content.length) <= 24_000;
                const tinyDiff = canPrecomputeCounts ? this.computeDiff(oldLinesLite, newLinesLite) : [];
                const textChanged = oldText !== content;
                const addedLite = tinyDiff.length > 0
                    ? tinyDiff.filter(d => d.type === 'add').length
                    : textChanged
                        ? Math.max(1, newLinesLite.length - oldLinesLite.length, 0)
                        : 0;
                const removedLite = tinyDiff.length > 0
                    ? tinyDiff.filter(d => d.type === 'del').length
                    : textChanged
                        ? Math.max(1, oldLinesLite.length - newLinesLite.length, 0)
                        : 0;
                card.setAttribute('data-added', String(addedLite));
                card.setAttribute('data-removed', String(removedLite));
                card.classList.remove('expanded');
                card.innerHTML = `<div class="tool-header">` +
                    `<div class="tool-icon-wrapper"><div class="tool-icon">W</div><div class="tool-status-dot"></div></div>` +
                    `<div class="tool-info"><span class="tool-name">write_file</span><span class="tool-args">${escapeHtml(filePath)}</span></div>` +
                    `<div class="tool-meta"><span class="tool-elapsed">Preview</span><span class="tool-chevron">鈻?/span></div>` +
                    `</div><div class="tool-body"><div class="tool-result"><div class="diff-line"><span class="diff-info">Expand to render the overwrite preview.</span></div></div>` +
                    `<div class="edit-preview-actions"><button class="edit-accept-btn">Confirm</button><button class="edit-reject-btn">Reject</button></div></div>`;

                const renderDiff = () => {
                    const result = card.querySelector<HTMLElement>('.tool-result');
                    if (!result) return;
                    const shouldRenderDetailedDiff = oldLinesLite.length * newLinesLite.length <= 20000
                        && (oldText.length + content.length) <= 120000;
                    const diffLite = shouldRenderDetailedDiff ? (tinyDiff.length > 0 ? tinyDiff : this.computeDiff(oldLinesLite, newLinesLite)) : [];
                    const exactAdded = diffLite.length > 0
                        ? diffLite.filter(d => d.type === 'add').length
                        : addedLite;
                    const exactRemoved = diffLite.length > 0
                        ? diffLite.filter(d => d.type === 'del').length
                        : removedLite;
                    card.setAttribute('data-added', String(exactAdded));
                    card.setAttribute('data-removed', String(exactRemoved));

                    const maxShowLite = Math.min(diffLite.length, 10);
                    let htmlLite = `<div class="diff-header-line"><span class="diff-stats">+${exactAdded} -${exactRemoved}</span></div>`;
                    if (diffLite.length === 0) {
                        htmlLite += `<div class="diff-line"><span class="diff-info">Large overwrite preview kept collapsed for performance.</span></div>`;
                    } else {
                        for (const d of diffLite.slice(0, maxShowLite)) {
                            const cls = d.type === 'add' ? 'diff-add' : d.type === 'del' ? 'diff-del' : 'diff-ctx';
                            const prefix = d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' ';
                            htmlLite += `<div class="diff-line"><span class="${cls}">${prefix} ${escapeHtml(d.text).substring(0, 118)}</span></div>`;
                        }
                        if (diffLite.length > maxShowLite) {
                            htmlLite += `<div class="diff-line"><span class="diff-info">... ${diffLite.length - maxShowLite} more lines</span></div>`;
                        }
                    }
                    result.innerHTML = htmlLite;
                };

                card.querySelector('.edit-accept-btn')?.addEventListener('click', () => {
                    vscode.writeConfirm(previewId);
                    finishWriteCardLite('success', 'Applied');
                });
                card.querySelector('.edit-reject-btn')?.addEventListener('click', () => {
                    vscode.writeReject(previewId);
                    finishWriteCardLite('error', 'Rejected');
                });

                messagesDiv.appendChild(card);
                this.makeCardCollapsible(card, '.tool-header', true);
                this.bindDeferredToolResult(card, renderDiff);
                smartScroll(messagesDiv);
                return;
            }

            const linesLite = content.split('\n');
            card.setAttribute('data-added', String(linesLite.length));
            card.setAttribute('data-removed', '0');
            const maxShowLite = Math.min(linesLite.length, 10);
            let contentHtmlLite = '';
            for (const line of linesLite.slice(0, maxShowLite)) {
                contentHtmlLite += `<div class="diff-line"><span class="diff-add">${escapeHtml(line).substring(0, 120)}</span></div>`;
            }
            if (linesLite.length > maxShowLite) {
                contentHtmlLite += `<div class="diff-line"><span class="diff-info">... +${linesLite.length - maxShowLite} more lines</span></div>`;
            }

            card.classList.remove('expanded');
            card.innerHTML = `<div class="tool-header">` +
                `<div class="tool-icon-wrapper"><div class="tool-icon">W</div><div class="tool-status-dot"></div></div>` +
                `<div class="tool-info"><span class="tool-name">write_file</span><span class="tool-args">${escapeHtml(filePath)} (${linesLite.length} lines)</span></div>` +
                `<div class="tool-meta"><span class="tool-elapsed">Preview</span><span class="tool-chevron">鈻?/span></div>` +
                `</div><div class="tool-body"><div class="tool-result">${contentHtmlLite}</div>` +
                `<div class="edit-preview-actions"><button class="edit-accept-btn">Confirm</button><button class="edit-reject-btn">Reject</button></div></div>`;

            const writeAcceptBtnLite = card.querySelector('.edit-accept-btn');
            if (writeAcceptBtnLite) writeAcceptBtnLite.addEventListener('click', () => {
                vscode.writeConfirm(previewId);
                finishWriteCardLite('success', 'Applied');
            });

            const writeRejectBtnLite = card.querySelector('.edit-reject-btn');
            if (writeRejectBtnLite) writeRejectBtnLite.addEventListener('click', () => {
                vscode.writeReject(previewId);
                finishWriteCardLite('error', 'Rejected');
            });

            messagesDiv.appendChild(card);
            this.makeCardCollapsible(card, '.tool-header', true);
            smartScroll(messagesDiv);
            return;
        }

    },

    // System message
    addSystemMessage(text: string, variant: 'default' | 'manual-stop' = 'default'): void {
        const messagesDiv = document.getElementById('messages')!;
        const sys = createElement('div', 'msg msg-system');
        const normalizedVariant = variant === 'default' && /^(宸叉墜鍔ㄥ仠姝㈠綋鍓嶄换鍔°€倈Stopped this task manually\.)$/.test(String(text || '').trim())
            ? 'manual-stop'
            : variant;
        if (normalizedVariant !== 'default') {
            sys.classList.add(`msg-system-${normalizedVariant}`);
        }
        sys.textContent = text;
        messagesDiv.appendChild(sys);
        smartScroll(messagesDiv);
    },

    // Welcome screen i18n update
    updateWelcome(descOrSeed: string, hint?: string): void {
        const welcomeDesc = document.querySelector('.welcome-desc');
        const welcomeHint = document.querySelector('.welcome-hint');
        if (!hint && welcomeDesc) {
            // Seed-based: pick variant from i18n
            const { desc, hint: h } = getWelcomePair(descOrSeed);
            if (welcomeDesc) welcomeDesc.innerHTML = desc;
            if (welcomeHint) welcomeHint.innerHTML = h;
        } else if (welcomeDesc && hint) {
            welcomeDesc.innerHTML = descOrSeed;
            if (welcomeHint) welcomeHint.innerHTML = hint;
        }
    },

    // Plan Mode: Confirm/Reject

    makeCardCollapsible(card: HTMLElement, headerSelector: string, collapsed = false): void {
        const header = card.querySelector(headerSelector) as HTMLElement | null;
        if (!header) return;
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.classList.add('collapsible-card-header');
        const toggle = createElement('button', 'inline-collapse-toggle');
        toggle.type = 'button';
        toggle.textContent = collapsed ? 'Show' : 'Hide';
        header.appendChild(toggle);

        const setCollapsed = (value: boolean) => {
            card.classList.toggle('collapsed', value);
            toggle.textContent = value ? 'Show' : 'Hide';
            card.dispatchEvent(new CustomEvent('cardCollapseChange', { detail: { collapsed: value } }));
        };
        setCollapsed(collapsed);

        const onToggle = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
            setCollapsed(!card.classList.contains('collapsed'));
        };
        toggle.addEventListener('click', onToggle);
        header.addEventListener('dblclick', onToggle);
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') onToggle(e);
        });
    },

    showPlanConfirm(planContent?: string, planPath?: string): void {
        const messagesDiv = document.getElementById('messages')!;
        const card = createElement('div', 'plan-confirm-card');

        card.innerHTML = `
            <div class="plan-confirm-header">${escapeHtml(t('plan.ready'))}</div>
            <div class="plan-confirm-desc">${escapeHtml(t('plan.ready.desc'))}</div>
            <div class="plan-confirm-actions-row">
                <button class="plan-confirm-btn plan-open-btn" id="plan-open-btn">${escapeHtml(t('open.editor'))}</button>
            </div>
            <div class="plan-confirm-modify">
                <input type="text" class="plan-modify-input" id="plan-modify-input" placeholder="${escapeHtml(t('plan.modify.placeholder'))}" />
            </div>
            <div class="plan-confirm-actions">
                <button class="plan-confirm-btn plan-accept-btn" id="plan-accept-btn">${escapeHtml(t('confirm.execute'))}</button>
                <button class="plan-confirm-btn plan-modify-btn" id="plan-modify-btn">${escapeHtml(t('modify.execute'))}</button>
                <button class="plan-confirm-btn plan-reject-btn" id="plan-reject-btn">${escapeHtml(t('replan'))}</button>
            </div>
        `;
        messagesDiv.appendChild(card);
        this.makeCardCollapsible(card, '.plan-confirm-header', false);
        smartScroll(messagesDiv);

        const openBtn = card.querySelector('#plan-open-btn') as HTMLButtonElement;
        const acceptBtn = card.querySelector('#plan-accept-btn') as HTMLButtonElement;
        const rejectBtn = card.querySelector('#plan-reject-btn') as HTMLButtonElement;
        const modifyBtn = card.querySelector('#plan-modify-btn') as HTMLButtonElement;
        const modifyInput = card.querySelector('#plan-modify-input') as HTMLInputElement;

        if (planPath) {
            const openPlan = () => {
                vscode.openMarkdownPreviewBeside(planPath);
                openBtn.textContent = `${t('open.editor')}...`;
                openBtn.disabled = true;
                (openBtn as any)._openPath = planPath;
            };
            openBtn.addEventListener('click', openPlan);
            openPlan();
        } else {
            openBtn.style.display = 'none';
        }

        const disableAll = () => {
            acceptBtn.disabled = true;
            rejectBtn.disabled = true;
            modifyBtn.disabled = true;
            modifyInput.disabled = true;
            card.classList.add('plan-decided');
            card.classList.add('collapsed');
        };

        acceptBtn.addEventListener('click', () => {
            disableAll();
            acceptBtn.textContent = 'Confirmed, running...';
            store.set('planExecutionActive', true);
            vscode.post({ type: 'planConfirm' });
        });

        rejectBtn.addEventListener('click', () => {
            disableAll();
            rejectBtn.textContent = 'Rejected';
            vscode.post({ type: 'planReject' });
        });

        modifyBtn.addEventListener('click', () => {
            const feedback = modifyInput.value.trim();
            if (!feedback) {
                modifyInput.focus();
                modifyInput.placeholder = 'Enter feedback before revising';
                return;
            }
            disableAll();
            modifyBtn.textContent = 'Revising...';
            vscode.post({ type: 'planModify', feedback });
        });

        modifyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !modifyBtn.disabled) {
                modifyBtn.click();
            }
        });
    },

    handleFileOpenResult(msg: any): void {
        const path = String(msg?.path || '');
        const buttons = document.querySelectorAll<HTMLButtonElement>('.plan-open-btn');
        buttons.forEach((btn) => {
            if ((btn as any)._openPath !== path) return;
            if (msg.ok) {
                btn.textContent = 'Opened';
                btn.disabled = true;
            } else {
                btn.textContent = 'Open in editor';
                btn.disabled = false;
                btn.title = String(msg.error || 'Open failed');
            }
        });
    },

    // Ask User: Interactive Dialog

    renderAskUserCard(previewId: string, question: string, options: string[]): void {
        const messagesDiv = document.getElementById('messages')!;
        const card = createElement('div', 'ask-user-card');

        card.innerHTML = `
            <div class="ask-user-header">${escapeHtml(t('ask.confirmation'))}</div>
            <div class="ask-user-question">${escapeHtml(question)}</div>
            <div class="ask-user-options">${options.map(opt =>
                `<button class="ask-user-option-btn" data-answer="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`
            ).join('')}<button class="ask-user-option-btn ask-user-other-btn" data-other="true">${t('ask.other')}</button></div>
            <div class="ask-user-other-input" id="ask-user-other-${previewId}" style="display:none">
                <input type="text" class="ask-user-input" id="ask-user-input-${previewId}" placeholder="${escapeHtml(t('ask.input.placeholder'))}" />
                <button class="ask-user-submit-btn" id="ask-user-submit-${previewId}">OK</button>
            </div>
            <div class="ask-user-status" id="ask-user-status-${previewId}"></div>
        `;
        messagesDiv.appendChild(card);
        smartScroll(messagesDiv);

        this.makeCardCollapsible(card, '.ask-user-header', false);
        const statusEl = card.querySelector(`#ask-user-status-${previewId}`) as HTMLElement;
        const otherInput = card.querySelector(`#ask-user-other-${previewId}`) as HTMLElement;
        const input = card.querySelector(`#ask-user-input-${previewId}`) as HTMLInputElement;
        const submitBtn = card.querySelector(`#ask-user-submit-${previewId}`) as HTMLButtonElement;

        const submitAnswer = (answer: string) => {
            if (!answer.trim()) return;
            card.querySelectorAll('button').forEach(b => (b as HTMLButtonElement).disabled = true);
            if (input) input.disabled = true;
            statusEl.textContent = t('ask.answered').replace('{answer}', answer);
            card.classList.add('ask-user-answered');
            card.classList.add('collapsed');
            vscode.askUserConfirm(previewId, answer);
        };

        // Wire up option buttons
        card.querySelectorAll('.ask-user-option-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.getAttribute('data-other') === 'true') {
                    // Show inline input for "鍏朵粬"
                    otherInput.style.display = 'flex';
                    input.focus();
                } else {
                    submitAnswer(btn.getAttribute('data-answer') || '');
                }
            });
        });

        // Wire up submit button + Enter key
        submitBtn.addEventListener('click', () => submitAnswer(input.value));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submitAnswer(input.value);
        });
    },

    renderStopGuardCard(info: { round?: number; reason?: string; summary?: string }): void {
        this._markThinkingDone();
        const messagesDiv = document.getElementById('messages')!;
        const card = createElement('div', 'stop-guard-card');
        const round = Number.isFinite(info?.round) ? Number(info.round) : 0;
        const reason = String(info?.reason || 'Low-progress loop detected.');
        const continuePrompt = [
            'Continue the current task.',
            'Resume from the saved progress and prioritize unfinished work.',
            'Avoid repeating completed checks. If no new progress is possible, summarize and stop.'
        ].join('\n');

        card.innerHTML = `
            <div class="stop-guard-header">Pause Guard</div>
            <div class="stop-guard-body">
                <div class="stop-guard-title">MIMO saved the current progress. This pause is not treated as an error.</div>
                <div class="stop-guard-meta">
                    <span>Round ${round || '-'}</span>
                    <span>${escapeHtml(reason)}</span>
                </div>
            </div>
            <div class="stop-guard-actions">
                <button class="stop-guard-continue" type="button">Continue</button>
                <button class="stop-guard-dismiss" type="button">Stop here</button>
            </div>
            <div class="stop-guard-status"></div>
        `;

        messagesDiv.appendChild(card);
        smartScroll(messagesDiv);
        this.makeCardCollapsible(card, '.stop-guard-header', false);

        const continueBtn = card.querySelector<HTMLButtonElement>('.stop-guard-continue');
        const dismissBtn = card.querySelector<HTMLButtonElement>('.stop-guard-dismiss');
        const statusEl = card.querySelector<HTMLElement>('.stop-guard-status');
        const disableActions = (status: string) => {
            card.querySelectorAll('button').forEach(btn => (btn as HTMLButtonElement).disabled = true);
            if (statusEl) statusEl.textContent = status;
            card.classList.add('stop-guard-decided');
        };

        continueBtn?.addEventListener('click', () => {
            disableActions('Continue instruction sent.');
            vscode.send(continuePrompt);
        });
        dismissBtn?.addEventListener('click', () => {
            disableActions('Current result kept.');
            card.classList.add('collapsed');
        });
    },

    // Adversarial mode: programmer vs reviewer

    _currentAdversarialPersona: null as string | null,
    _currentAdversarialBlock: null as HTMLElement | null,
    _currentAdversarialContent: null as HTMLElement | null,
    _adversarialAccumText: '' as string,

    handleAdversarialTurn(persona: string, name: string, icon: string, phase: string, content: string, iteration: number): void {
        const messagesDiv = document.getElementById('messages')!;
        const displayName = persona === 'pm' ? t('adversarial.reviewer.name') : name;

        // If persona changed, create a new turn block
        if (this._currentAdversarialPersona !== persona) {
            // Finalize previous block's markdown render
            if (this._currentAdversarialContent && this._adversarialAccumText) {
                this._currentAdversarialContent.innerHTML = this._renderAdversarialMarkdown(this._adversarialAccumText);
            }
            if (this._currentAdversarialBlock) {
                this._currentAdversarialBlock.classList.add('collapsed');
            }

            this._currentAdversarialPersona = persona;
            this._adversarialAccumText = '';

            // Create adversarial turn container
            const turn = createElement('div', `adversarial-turn persona-${persona}`);
            turn.setAttribute('data-persona', persona);
            turn.setAttribute('data-iteration', String(iteration));

            // Header with avatar, name, and phase
            const header = createElement('div', 'adversarial-header');
            const avatar = createElement('span', 'adversarial-avatar');
            avatar.textContent = icon;
            avatar.style.cssText = persona === 'programmer'
                ? 'background:rgba(255,105,0,.15);color:#FF6900'
                : 'background:rgba(33,150,243,.15);color:#2196F3';
            const nameEl = createElement('span', 'adversarial-name');
            nameEl.textContent = displayName;
            nameEl.style.color = persona === 'programmer' ? '#FF6900' : '#2196F3';
            const phaseEl = createElement('span', 'adversarial-phase');
            phaseEl.textContent = phase === 'speak' ? '姝ｅ湪缂栫爜...' : phase === 'review' ? '姝ｅ湪瀹℃煡...' : phase === 'verdict' ? '瑁佸喅' : '';
            header.appendChild(avatar);
            header.appendChild(nameEl);
            const roundEl = createElement('span', 'adversarial-round');
            roundEl.textContent = `#${iteration}`;
            header.appendChild(roundEl);
            header.appendChild(phaseEl);

            // Body for content
            const body = createElement('div', 'adversarial-body md-content');

            turn.appendChild(header);
            turn.appendChild(body);
            messagesDiv.appendChild(turn);
            this.makeCardCollapsible(turn, '.adversarial-header', false);

            this._currentAdversarialBlock = turn;
            this._currentAdversarialContent = body;

            // Remove spinner from any existing assistant message
            const spinners = messagesDiv.querySelectorAll('.spinner');
            spinners.forEach(s => s.remove());
        }

        // Accumulate text and render
        this._adversarialAccumText += content;

        // Update phase text if it changed
        const phaseEl = this._currentAdversarialBlock?.querySelector('.adversarial-phase');
        if (phaseEl) {
            const phaseText = phase === 'speak' ? '姝ｅ湪缂栫爜...' : phase === 'review' ? '姝ｅ湪瀹℃煡...' : phase === 'verdict' ? '瑁佸喅' : '';
            (phaseEl as HTMLElement).textContent = phaseText;
        }

        // For verdict phase, render the full content as markdown
        if (phase === 'verdict' && this._currentAdversarialContent) {
            this._currentAdversarialContent.innerHTML = this._renderAdversarialMarkdown(this._adversarialAccumText);
            // Reset for next round
            this._currentAdversarialPersona = null;
            this._currentAdversarialContent = null;
            this._currentAdversarialBlock = null;
            this._adversarialAccumText = '';
        }

        smartScroll(messagesDiv);
    },

    handleAdversarialToolStart(persona: string, toolName: string, args: any): void {
        // Add tool card inside the current adversarial block
        const block = this._currentAdversarialBlock;
        if (!block) return;

        let toolsContainer = block.querySelector('.adversarial-tools') as HTMLElement;
        if (!toolsContainer) {
            toolsContainer = createElement('div', `adversarial-tools persona-${persona}`);
            block.appendChild(toolsContainer);
        }

        const summary = toolSummary(toolName, args);
        const icon = toolIcon(toolName);
        const line = createElement('div', 'tool-line');
        line.setAttribute('data-status', 'running');
        line.setAttribute('data-tool', toolName);

        const label = createElement('span', 'tool-label');
        label.textContent = icon;
        label.style.color = persona === 'programmer' ? '#FF6900' : '#2196F3';
        const pathEl = createElement('span', 'tool-path');
        pathEl.textContent = summary;
        const time = createElement('span', 'tool-time');
        time.textContent = '...';

        line.appendChild(label);
        line.appendChild(pathEl);
        line.appendChild(time);
        toolsContainer.appendChild(line);

        const messagesDiv = document.getElementById('messages')!;
        smartScroll(messagesDiv);
    },

    handleAdversarialToolEnd(persona: string, toolName: string, result: string, isError: boolean, elapsed: number): void {
        const block = this._currentAdversarialBlock;
        if (!block) return;

        const toolsContainer = block.querySelector('.adversarial-tools');
        if (!toolsContainer) return;

        // Find the last running tool-line for this tool
        const lines = toolsContainer.querySelectorAll('.tool-line[data-status="running"]');
        const line = lines[lines.length - 1] as HTMLElement;
        if (!line) return;

        line.setAttribute('data-status', isError ? 'error' : 'success');
        const timeEl = line.querySelector('.tool-time');
        if (timeEl) timeEl.textContent = elapsed < 1 ? `${(elapsed * 1000).toFixed(0)}ms` : `${elapsed.toFixed(1)}s`;

        // Show brief output for commands
        if (toolName === 'execute_command' && result && !isError) {
            const output = createElement('div', 'tool-output');
            output.textContent = result.length > 200 ? result.substring(0, 200) + '...' : result;
            line.appendChild(output);
        }
    },

    /** Improved markdown rendering for adversarial content */
    _renderAdversarialMarkdown(text: string): string {
        if (!text) return '';
        let html = escapeHtml(text);

        // Code blocks (preserve first, before other rules)
        const codeBlocks: string[] = [];
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
            const idx = codeBlocks.length;
            codeBlocks.push(`<div class="code-block"><div class="code-header"><span>${lang || 'code'}</span><button class="copy-btn">Copy</button></div><pre><code>${code}</code></pre></div>`);
            return `\n__CODE_${idx}__\n`;
        });

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Headers
        html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

        // Bold
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // Tables: lines starting with |
        html = html.replace(/((?:^\|.+\|?\n?)+)/gm, (_m: string, block: string) => {
            const lines = block.trim().split('\n');
            if (lines.length < 2) return block;
            const rows: string[][] = [];
            for (const line of lines) {
                const cells = line.split('|').map((c: string) => c.trim()).filter((c: string) => c !== '');
                if (cells.length > 0) rows.push(cells);
            }
            if (rows.length < 2) return block;
            const header = rows[0];
            let table = '<table><thead><tr>';
            for (const h of header) table += `<th>${h}</th>`;
            table += '</tr></thead><tbody>';
            for (let i = 1; i < rows.length; i++) {
                if (rows[i].every((c: string) => /^[-:\s|]+$/.test(c))) continue;
                table += '<tr>';
                for (let j = 0; j < header.length; j++) {
                    table += `<td>${rows[i][j] || ''}</td>`;
                }
                table += '</tr>';
            }
            table += '</tbody></table>';
            return '\n' + table + '\n';
        });

        // Unordered list items
        html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

        // Ordered list items
        html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
        html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
            // Only wrap in <ol> if not already wrapped in <ul> (avoid double-wrapping)
            if (match.includes('<ul>')) return match;
            return `<ol>${match}</ol>`;
        });

        // Line breaks - collapse 3+ consecutive newlines into a single <br> to reduce excessive blank lines
        html = html.replace(/\n{3,}/g, '\n\n');
        html = html.replace(/\n/g, '<br>');

        // Restore code blocks
        codeBlocks.forEach((block, i) => {
            html = html.replace(`__CODE_${i}__`, block);
        });

        return html;
    },

    // Message queue

    formatQueueTitle(count: number): string {
        return `${t('queue.waiting')} (${count})`;
    },

    syncQueueListState(container: HTMLElement | null): void {
        const list = container?.querySelector<HTMLElement>('.msg-queue-list');
        if (!container || !list) return;
        const scrollable = list.children.length > QUEUE_VISIBLE_ITEMS;
        container.classList.toggle('msg-queue-scrollable', scrollable);
        list.classList.toggle('is-scrollable', scrollable);
    },

    getTaskChangesToggleLabel(hiddenCount: number, expanded: boolean): string {
        const showLabel = t('show');
        const hideLabel = t('hide');
        if (expanded) {
            return `${hideLabel} extra files`;
        }
        return `${showLabel} ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}`;
    },

    syncTaskChangeListState(card: HTMLElement): void {
        const list = card.querySelector<HTMLElement>('.task-changes-list');
        const toggle = card.querySelector<HTMLButtonElement>('.task-changes-files-toggle');
        if (!list || !toggle) return;
        const expanded = toggle.dataset.expanded === 'true';
        list.classList.toggle('task-changes-list-expanded', expanded);
        toggle.textContent = this.getTaskChangesToggleLabel(Number(toggle.dataset.hiddenCount || '0'), expanded);
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    },

    bindTaskChangeListToggle(card: HTMLElement): void {
        const toggle = card.querySelector<HTMLButtonElement>('.task-changes-files-toggle');
        if (!toggle || toggle.dataset.bound === 'true') return;
        this.syncTaskChangeListState(card);
        toggle.addEventListener('click', () => {
            toggle.dataset.expanded = toggle.dataset.expanded === 'true' ? 'false' : 'true';
            this.syncTaskChangeListState(card);
        });
        toggle.dataset.bound = 'true';
    },

    localizeTaskChangesDisplay(root: ParentNode = document): void {
        root.querySelectorAll<HTMLElement>('.task-changes-card').forEach(card => {
            this.syncTaskChangeListState(card);
        });
    },

    localizeQueueDisplay(): void {
        const inputArea = document.getElementById('input-area');
        const container = inputArea?.querySelector('.msg-queue-container') as HTMLElement | null;
        if (!container) return;
        const items = container.querySelectorAll('.msg-queue-item');
        const title = container.querySelector('.queue-title');
        if (title) title.textContent = this.formatQueueTitle(items.length);
        container.querySelectorAll<HTMLButtonElement>('.queue-item-edit').forEach(btn => {
            btn.textContent = t('queue.edit');
            btn.title = t('queue.edit');
        });
        container.querySelectorAll<HTMLButtonElement>('.queue-item-run').forEach(btn => {
            btn.textContent = t('queue.run.now');
            btn.title = t('queue.run.now.title');
        });
        container.querySelectorAll<HTMLButtonElement>('.queue-item-del').forEach(btn => {
            btn.title = t('remove');
            btn.setAttribute('aria-label', t('remove'));
        });
        container.querySelectorAll<HTMLElement>('.queue-img-badge').forEach(badge => {
            const count = badge.getAttribute('data-count') || '';
            badge.textContent = `+${count} ${t('queue.image.short')}`;
        });
        this.syncQueueListState(container);
    },

    showQueuedMessage(text: string, queueLength: number): void {
        const inputArea = document.getElementById('input-area')!;
        let container = inputArea.querySelector('.msg-queue-container') as HTMLElement;

        // Create container if not exists
        if (!container) {
            container = createElement('div', 'msg msg-queue-container');
            const header = createElement('div', 'msg-queue-header');
            header.innerHTML = `<span class="queue-icon">Q</span><span class="queue-title">${escapeHtml(this.formatQueueTitle(queueLength))}</span>`;
            container.appendChild(header);
            const list = createElement('div', 'msg-queue-list');
            container.appendChild(list);
            inputArea.prepend(container);
        }

        // Add item to list
        const list = container.querySelector('.msg-queue-list')!;
        const idx = list.children.length;
        const item = createElement('div', 'msg-queue-item');
        const images = store.get('queuedMsgs')[idx]?.images || null;
        const imageBadge = images && images.length > 0 ? `<span class="queue-img-badge" data-count="${images.length}">+${images.length} ${escapeHtml(t('queue.image.short'))}</span>` : '';
        item.innerHTML = `<span class="queue-item-num">#${idx + 1}</span>` +
            `<span class="queue-item-text">${escapeHtml(text.length > 80 ? text.substring(0, 80) + '...' : text)}</span>` +
            imageBadge +
            `<button class="queue-item-run" title="${escapeHtml(t('queue.run.now.title'))}">${escapeHtml(t('queue.run.now'))}</button>` +
            `<button class="queue-item-edit" title="${escapeHtml(t('queue.edit'))}">${escapeHtml(t('queue.edit'))}</button>` +
            `<button class="queue-item-del" title="${escapeHtml(t('remove'))}" aria-label="${escapeHtml(t('remove'))}">x</button>`;
        const refreshQueueItems = () => {
            const items = list.querySelectorAll('.msg-queue-item');
            for (let i = 0; i < items.length; i++) {
                const num = items[i].querySelector('.queue-item-num');
                if (num) num.textContent = `#${i + 1}`;
            }
            const title = container.querySelector('.queue-title');
            if (title) title.textContent = this.formatQueueTitle(items.length);
            this.syncQueueListState(container);
            if (items.length === 0) container.remove();
        };
        const getCurrentIndex = () => Array.from(list.children).indexOf(item);
        item.querySelector('.queue-item-run')!.addEventListener('click', () => {
            const queued = store.get('queuedMsgs');
            const currentIdx = getCurrentIndex();
            const target = queued[currentIdx];
            if (!target) return;
            const remaining = queued.filter((_: any, i: number) => i !== currentIdx);
            store.set('queuedMsgs', remaining);
            store.set('skipNextQueueAutoSend', true);
            vscode.interruptAndSend(target.text, target.images || null);
            item.remove();
            refreshQueueItems();
        });
        item.querySelector('.queue-item-edit')!.addEventListener('click', () => {
            const queued = store.get('queuedMsgs');
            const currentIdx = getCurrentIndex();
            const target = queued[currentIdx];
            if (!target) return;
            store.set('queuedMsgs', queued.filter((_: any, i: number) => i !== currentIdx));
            bus.emit('editQueuedMessage', target.text, target.images || null);
            item.remove();
            refreshQueueItems();
        });
        // Delete button handler
        item.querySelector('.queue-item-del')!.addEventListener('click', () => {
            // Remove from store
            const queued = store.get('queuedMsgs');
            const currentIdx = getCurrentIndex();
            if (currentIdx >= 0 && currentIdx < queued.length) {
                store.set('queuedMsgs', queued.filter((_: any, i: number) => i !== currentIdx));
            }
            item.remove();
            refreshQueueItems();
        });
        list.appendChild(item);
        const title = container.querySelector('.queue-title');
        if (title) title.textContent = this.formatQueueTitle(list.children.length);
        this.syncQueueListState(container);
    },

    updateQueueDisplay(remaining: number): void {
        const inputArea = document.getElementById('input-area')!;
        const container = inputArea.querySelector('.msg-queue-container');
        if (!container) return;
        if (remaining === 0) {
            container.remove();
        } else {
            const title = container.querySelector('.queue-title');
            if (title) title.textContent = this.formatQueueTitle(remaining);
            // Remove first item (it was just processed)
            const list = container.querySelector('.msg-queue-list');
            if (list && list.children.length > 0) {
                list.children[0].remove();
                // Re-number
                const items = list.querySelectorAll('.msg-queue-item');
                for (let i = 0; i < items.length; i++) {
                    const num = items[i].querySelector('.queue-item-num');
                    if (num) num.textContent = `#${i + 1}`;
                }
            }
            this.syncQueueListState(container as HTMLElement);
            if (remaining === 0) container.remove();
        }
    },

    clearQueueDisplay(): void {
        const inputArea = document.getElementById('input-area')!;
        const container = inputArea.querySelector('.msg-queue-container');
        if (container) container.remove();
    },

    // Clear
    clearMessages(): void {
        const messagesDiv = document.getElementById('messages')!;
        Array.from(messagesDiv.children).forEach(child => {
            if (!(child as HTMLElement).classList.contains('sticky-user-preview')) child.remove();
        });
        const stickyPrompt = messagesDiv.querySelector('.sticky-user-preview') as HTMLElement | null;
        if (stickyPrompt) {
            stickyPrompt.classList.add('hidden');
            stickyPrompt.replaceChildren();
        }
        messagesDiv.style.removeProperty('--sticky-user-height');
        store.set('tokenUsage', { prompt: 0, completion: 0, total: 0, calls: 0 });
        const statusEl = document.getElementById('token-counter');
        if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
    },

    // Helpers
    createAssistantMsg(): HTMLElement {
        const messagesDiv = document.getElementById('messages')!;
        const div = createElement('div', 'msg msg-assistant');
        (div as any)._startedAt = Date.now();
        (div as any)._startedTokenTotal = store.get('tokenUsage').total || 0;
        const sp = createElement('span', 'spinner');
        div.appendChild(sp);
        messagesDiv.appendChild(div);
        smartScroll(messagesDiv);
        return div;
    },
};
