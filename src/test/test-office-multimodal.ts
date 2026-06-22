import { describe, it, expect, summary } from './test-runner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSystemPrompt } from '../prompt';
import { detectOfficeDocumentKind, detectZipCapableDocumentKind, extractFormulaTextFromOfficeXml, extractVisibleTextFromOfficeXml } from '../mcpMultimodalServer';

const DOCX_FIXTURE_BASE64 = 'UEsDBBQAAAAIAJWL1lwoBMFMxAAAAF0BAAARAAAAd29yZFxkb2N1bWVudC54bWyNkE0OwiAQhfdNvAPpAUS7cNG0rNS48QomSOlPwjAEaKpnc+GRvIKA7a4LNy9vfvjmhc/rXU1lg2IEqT15gNKunOq8996UlDrRS+Bui0bqMGvRAvehtB2d0DbGopDODboDRYvd7kCBDzqfMfAPBtt2EPI4B1ggvs9ZRkiIdsfmGW0qDAtio3h2kUohiahRcRLSqKaicRDVJjXzQyjxGpAsGBvFs1MN4lZUFNJ+atNla+3YeehGK8l+9UI0v5jRLX/JNtkXUEsDBBQAAAAIAJWL1lxiwOduPwAAAEQAAAAVAAAAd29yZFxtZWRpYVxpbWFnZTEucG5n6wzwc+flkuJiYGDg9fRwCQLSjCDMwQIkt8rwMAEpbk8Xx5CKW8l//sszMDMzMbx/nxsPFGbwdPVzWeeU0AQAUEsBAhQAFAAAAAgAlYvWXCgEwUzEAAAAXQEAABEAAAAAAAAAAAAAAAAAAAAAAHdvcmRcZG9jdW1lbnQueG1sUEsBAhQAFAAAAAgAlYvWXGLA524/AAAARAAAABUAAAAAAAAAAAAAAAAA8wAAAHdvcmRcbWVkaWFcaW1hZ2UxLnBuZ1BLBQYAAAAAAgACAIIAAABlAQAAAAA=';

describe('office multimodal helpers', () => {
    it('detects office document kinds by extension', () => {
        expect(detectOfficeDocumentKind('paper.pdf')).toBe('pdf');
        expect(detectOfficeDocumentKind('report.docx')).toBe('docx');
        expect(detectOfficeDocumentKind('slides.pptx')).toBe('pptx');
        expect(detectOfficeDocumentKind('sheet.xlsx')).toBe('xlsx');
        expect(detectOfficeDocumentKind('notes.rtf')).toBe('rtf');
        expect(detectOfficeDocumentKind('blob.bin')).toBe('unknown');
    });

    it('detects zip-capable document kinds for archive-style tools', () => {
        expect(detectZipCapableDocumentKind('book.epub')).toBe('epub');
        expect(detectZipCapableDocumentKind('bundle.zip')).toBe('zip');
        expect(detectZipCapableDocumentKind('plugin.jar')).toBe('jar');
        expect(detectZipCapableDocumentKind('comic.cbz')).toBe('cbz');
        expect(detectZipCapableDocumentKind('blob.bin')).toBe('unknown');
    });

    it('extracts visible office xml text and formulas', () => {
        const xml = `
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t>World</w:t></w:r></w:p>
    <m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath>
    <w:p><w:r><w:t>Figure 1</w:t></w:r></w:p>
  </w:body>
</w:document>`;

        const text = extractVisibleTextFromOfficeXml(xml);
        const formulas = extractFormulaTextFromOfficeXml(xml);

        expect(text).toContain('Hello');
        expect(text).toContain('World');
        expect(text).toContain('Figure 1');
        expect(formulas).toContain('E=mc^2');
    });

    it('documents the new office MCP guidance in the system prompt', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-office-prompt-'));
        const prompt = buildSystemPrompt(workspace);
        expect(prompt).toContain('mcp_mimo_multimodal_analyze_office_document');
        expect(prompt).toContain('mcp_mimo_multimodal_inspect_office_archive');
        expect(prompt).toContain('mcp_mimo_multimodal_render_office_pages');
        expect(prompt).toContain('mcp_mimo_multimodal_analyze_epub');
        expect(prompt).toContain('mcp_mimo_multimodal_preview_tabular_data');
        expect(prompt).toContain('mcp_mimo_multimodal_preview_archive');
        expect(prompt).toContain('mcp_mimo_multimodal_extract_document_images');
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('keeps a minimal docx fixture available for archive-based office testing', () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-office-fixture-'));
        const docxPath = path.join(workspace, 'fixture.docx');
        fs.writeFileSync(docxPath, Buffer.from(DOCX_FIXTURE_BASE64, 'base64'));
        expect(fs.existsSync(docxPath)).toBe(true);
        expect(fs.statSync(docxPath).size).toBeGreaterThan(100);
        fs.rmSync(workspace, { recursive: true, force: true });
    });
});

summary();
