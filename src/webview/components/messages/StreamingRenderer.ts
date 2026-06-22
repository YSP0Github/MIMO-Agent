/**
 * Streaming HTML post-processing.
 */

import { parseTodoItems, renderTaskChecklist } from '../taskChecklist';

export function shouldDeferStreamingRender(nextText: string, lastRenderedText: string, lastRenderedAt: number, now: number): boolean {
    if (nextText === lastRenderedText) return true;
    if (!lastRenderedText) return false;
    const deltaChars = Math.abs(nextText.length - lastRenderedText.length);
    const minDeltaChars = nextText.length > 40_000 ? 2_400 : nextText.length > 18_000 ? 1_200 : 320;
    const minIntervalMs = nextText.length > 40_000 ? 2_200 : nextText.length > 18_000 ? 1_300 : 450;
    return deltaChars < minDeltaChars && (now - lastRenderedAt) < minIntervalMs;
}

export function enhanceTaskChecklists(html: string): string {
    let enhanced = html.replace(
        /<div class="task-checklist">([\s\S]*?)<\/div>\s*<\/div>/g,
        (_: string, inner: string) => {
            const items = parseTodoItems(inner);
            if (items.length === 0) return '';
            return renderTaskChecklist(items);
        }
    );
    enhanced = enhanced.replace(/<ul>\s*((?:<li\s+class="todo(?:\s+done)?"[^>]*>[\s\S]*?<\/li>\s*){2,})<\/ul>/gi, (_: string, listItems: string) => {
        const items = parseTodoItems(listItems);
        return items.length >= 2 ? renderTaskChecklist(items) : `<ul>${listItems}</ul>`;
    });
    return enhanced;
}

/**
 * Strip raw tool_call XML that the model leaked into its text response.
 */
export function stripRawToolCalls(html: string): string {
    return html
        .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, '')
        .replace(/<tool_call\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<\/?(?:tool_call|function|parameter|parameters|arguments|argument|name)\b[^>]*>/gi, '')
        .replace(/&lt;\/?(?:tool_call|function|parameter|parameters|arguments|argument|name)\b[^&]*?&gt;/gi, '');
}
