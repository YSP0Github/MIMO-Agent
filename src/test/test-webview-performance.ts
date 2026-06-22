import { describe, it, expect } from './test-runner';
import { shouldDeferStreamingRender } from '../webview/components/messages/StreamingRenderer';

describe('webview performance helpers', () => {
    it('defers tiny streaming updates for long responses', () => {
        const previous = 'x'.repeat(25000);
        const next = previous + ' more';
        expect(shouldDeferStreamingRender(next, previous, 1000, 1800)).toBe(true);
    });

    it('allows larger streaming jumps through without delay', () => {
        const previous = 'x'.repeat(25000);
        const next = previous + 'y'.repeat(2000);
        expect(shouldDeferStreamingRender(next, previous, 1000, 1800)).toBe(false);
    });

    it('does not defer the first streaming preview', () => {
        expect(shouldDeferStreamingRender('hello', '', 0, 1)).toBe(false);
    });
});
