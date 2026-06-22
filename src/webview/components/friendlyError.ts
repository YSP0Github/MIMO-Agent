import { escapeHtml } from '../utils/dom';

function escapeHtmlPreservingBreaks(text: string): string {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function extractErrorCode(text: string): string {
    const match = String(text || '').match(/\b(400|401|402|403|404|421|429|500|503)\b/);
    return match?.[1] || '';
}

export function looksLikeConfigOrApiError(text: string): boolean {
    const value = String(text || '');
    const hasProviderSignal = /MiMo API|Authentication failed|API Key|Base URL|task interrupted by API or runtime error|invalid api key|unauthorized|forbidden|rate limit|service unavailable|status code|http(?:\s+error)?/i.test(value);
    const hasErrorSignal = /\berror\b|\bfailed\b|\bfailure\b|\bexception\b|\binvalid\b|\bunauthorized\b|\bforbidden\b|\bunavailable\b|\brate limit\b|^failed:/i.test(value) || !!extractErrorCode(value);
    return hasProviderSignal && hasErrorSignal;
}

const FRIENDLY_ERROR_SECTION_LABELS = [
    'Task status',
    'Goal',
    'Completed tool calls',
    'Progress',
    'Soft budget',
    'Changed files',
    'Latest model output',
    'Recent tool results',
    'Next action',
    '问题归因',
    '原因',
    '建议',
    '原始信息',
    'Request summary',
] as const;

function normalizeFriendlyErrorLines(text: string): string[] {
    const raw = String(text || '').trim();
    if (!raw) return [];

    let normalized = raw.replace(/\r\n/g, '\n');
    const labels = FRIENDLY_ERROR_SECTION_LABELS
        .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|');

    normalized = normalized.replace(new RegExp(`\\s+(?=(?:${labels})\\s*[:：])`, 'g'), '\n');
    normalized = normalized.replace(/\s+(?=MiMo API 返回\s+\d{3}|FAILED:)/g, '\n');

    return normalized
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

function getFriendlyErrorTitle(lines: string[]): string {
    for (const line of lines) {
        if (/^(?:Task status|Goal|Completed tool calls|Progress|Soft budget|Changed files|Latest model output|Recent tool results|Next action|问题归因|原因|建议|原始信息|Request summary)\s*[:：]/i.test(line)) {
            continue;
        }
        if (/^(?:MiMo API 返回\s+\d{3}|FAILED:|Authentication failed|Request was aborted)/i.test(line)) {
            return line;
        }
    }
    return lines[0] || 'API / runtime error';
}

export function renderFriendlyErrorHtml(text: string): string {
    const raw = String(text || '').trim();
    if (!raw) return '';

    const code = extractErrorCode(raw);
    const lines = normalizeFriendlyErrorLines(raw);
    const title = getFriendlyErrorTitle(lines);
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
        .flatMap(item => item.split(/[；;]+/))
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
        title,
        ...taskStatus,
        ...taskStatus.map(v => `Task status: ${v}`),
        ...reasons,
        ...suggestions,
        ...nextActions,
        ...nextActions.map(v => `Next action: ${v}`),
    ]);
    const sectionLabels = ['问题归因', '原因', '建议', 'Next action', 'Task status'];
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
