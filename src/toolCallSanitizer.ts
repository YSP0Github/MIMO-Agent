import { ChatMessage, ToolCall } from './api';

const TOOL_ARG_LIMITS: Record<string, Record<string, number>> = {
    write_file: { content: 4096 },
    edit_file: { old_text: 4096, new_text: 4096 },
    execute_command: { command: 12000 },
    edit_notebook_cell: { content: 4096 },
    insert_notebook_cell: { content: 4096 },
};

function compactToolArgValue(toolName: string, fieldName: string, value: string, threshold: number): string {
    if (value.length <= threshold) {
        return value;
    }
    const lineCount = value.split('\n').length;
    const head = value.slice(0, 320);
    const tail = value.slice(-180);
    return [
        `[${toolName}.${fieldName} omitted from conversation replay; ${value.length} chars across ${lineCount} lines. The original tool call already used the full payload.]`,
        `Preview (start):`,
        head,
        '...',
        `Preview (end):`,
        tail,
    ].join('\n');
}

export function sanitizeToolCallForConversation(toolCall: ToolCall): ToolCall {
    const limits = TOOL_ARG_LIMITS[toolCall.function.name];
    if (!limits) {
        return toolCall;
    }
    let args: Record<string, any> = {};
    try {
        args = JSON.parse(toolCall.function.arguments || '{}');
    } catch {
        return toolCall;
    }
    let changed = false;
    const nextArgs: Record<string, any> = { ...args };
    for (const [fieldName, threshold] of Object.entries(limits)) {
        const value = nextArgs[fieldName];
        if (typeof value !== 'string' || value.length <= threshold) {
            continue;
        }
        nextArgs[fieldName] = compactToolArgValue(toolCall.function.name, fieldName, value, threshold);
        changed = true;
    }
    if (!changed) {
        return toolCall;
    }
    return {
        ...toolCall,
        function: {
            ...toolCall.function,
            arguments: JSON.stringify(nextArgs),
        },
    };
}

export function sanitizeToolCallsForConversation(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
    if (!toolCalls?.length) {
        return toolCalls;
    }
    let changed = false;
    const sanitized = toolCalls.map((toolCall) => {
        const next = sanitizeToolCallForConversation(toolCall);
        if (next !== toolCall) {
            changed = true;
        }
        return next;
    });
    return changed ? sanitized : toolCalls;
}

export function sanitizeMessageToolCallsForConversation(message: ChatMessage): ChatMessage {
    const sanitizedToolCalls = sanitizeToolCallsForConversation(message.tool_calls);
    if (sanitizedToolCalls === message.tool_calls) {
        return message;
    }
    return {
        ...message,
        tool_calls: sanitizedToolCalls,
    };
}
