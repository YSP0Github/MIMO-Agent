import { describe, it, expect } from './test-runner';
import { extractHttpErrorCode, getFriendlyError, MIMO_ERROR_CODES } from '../agentErrors';

describe('MiMo API friendly errors', () => {
    it('stores the documented MiMo API error codes', () => {
        expect(Object.keys(MIMO_ERROR_CODES)).toEqual(['400', '401', '402', '403', '404', '421', '429', '500', '503']);
    });

    it('formats MiMo 401 errors with reason and suggestions', () => {
        const text = getFriendlyError(new Error('API error 401: invalid api key'), {
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        });

        expect(text).toContain('MiMo API 返回 401');
        expect(text).toContain('问题归因：');
        expect(text).toContain('用户配置或账户凭证问题');
        expect(text).toContain('原因：');
        expect(text).toContain('建议：');
        expect(text).toContain('Token Plan');
    });

    it('turns aborted MiMo streams into an actionable interruption message', () => {
        const text = getFriendlyError(new Error('aborted'), {
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        });

        expect(text).toContain('MiMo 请求已中断');
        expect(text).toContain('问题归因：');
        expect(text).toContain('暂不能单凭 aborted 判定');
        expect(text).toContain('建议：');
        expect(text).not.toBe('FAILED: aborted');
    });

    it('classifies MiMo max token rejections as request/config problems', () => {
        const text = getFriendlyError(new Error('field MaxTokens invalid, should be in range'), {
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
        });

        expect(text).toContain('MiMo API 返回 400');
        expect(text).toContain('问题归因：');
        expect(text).toContain('Agent 请求参数或用户生成设置问题');
    });

    it('extracts documented HTTP error codes from provider messages', () => {
        expect(extractHttpErrorCode('API error 429: too many requests')).toBe('429');
        expect(extractHttpErrorCode('socket hang up')).toBeNull();
    });

    it('explains write-followed-by-500 as a likely replay overload instead of generic server failure', () => {
        const text = getFriendlyError(new Error('API error 500: tool_calls.function.arguments too long after write_file; request too large'), {
            model: 'mimo-v2.5-pro',
            baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
            requestSummary: 'model=mimo-v2.5-pro, endpoint=chat_completions, messages=18, assistant_tool_calls=3, tool_messages=3, reasoning_messages=2, image_messages=0, body_chars=42137',
        });

        expect(text).toContain('MiMo API 返回 500');
        expect(text).toContain('write_file');
        expect(text).toContain('请求体过大');
        expect(text).toContain('先检查目标文件是否其实已经写成成功');
        expect(text).toContain('Request summary: model=mimo-v2.5-pro');
    });
});
