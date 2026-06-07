/**
 * Tool: PdfReadTool
 *
 * Reads a PDF file from disk, extracts plain text via pdf-parse,
 * and returns the text so the LLM can analyse it.
 *
 * Binary PDF bytes cannot be read with fs.readFileSync('utf8');
 * this tool handles that correctly using the pdf-parse v2 class API.
 */

import path from 'path';
import { AgentTool, ToolInput, ToolResult, ToolSchema } from '../../domain/types/agent-tool';
import { IFileSystem } from '../../domain/types/file-system';
import { MAX_FILE_CONTENT_CHARS } from '../../domain/policies/agent-file-policy';
import { extractPdfText } from '../../infrastructure/pdf/pdf-text-extractor';

export class PdfReadTool implements AgentTool {
    readonly name = 'pdf_read';

    readonly schema: ToolSchema = {
        name: 'pdf_read',
        description:
            'Read a PDF file from disk and extract its plain text. Use this instead of file_read for .pdf files.',
        parameters: {
            path: {
                type: 'string',
                description: 'The PDF file path to read (absolute or relative to cwd)',
                required: true,
            },
        },
        example: '[ACTION {"tool":"pdf_read","input":{"path":"report.pdf"}}]',
    };

    constructor(private readonly fileSystem: IFileSystem) {}

    async execute(input: ToolInput): Promise<ToolResult> {
        const filePath = input.path as string | undefined;
        if (!filePath?.trim()) {
            return { content: 'No file path provided.', isError: true };
        }

        const absPath = path.resolve(filePath);

        if (path.extname(absPath).toLowerCase() !== '.pdf') {
            return {
                content: 'pdf_read only accepts .pdf files. For other files use file_read.',
                isError: true,
            };
        }

        if (!this.fileSystem.exists(absPath)) {
            return { content: `File not found: ${absPath}`, isError: true };
        }

        let buffer: Buffer;
        try {
            buffer = this.fileSystem.readBuffer(absPath);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to read file: ${msg}`, isError: true };
        }

        let text: string;
        try {
            text = await extractPdfText(buffer);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: `Failed to parse PDF: ${msg}`, isError: true };
        }

        if (!text.trim()) {
            return {
                content: `PDF contains no extractable text (may be image-only or encrypted): ${path.basename(absPath)}`,
                isError: true,
            };
        }

        if (text.length > MAX_FILE_CONTENT_CHARS) {
            const kb = (text.length / 1_000).toFixed(1);
            return {
                content: `PDF text (${kb}k chars) exceeds ${MAX_FILE_CONTENT_CHARS / 1_000}k limit. Try a shorter document or specific pages.`,
                isError: true,
            };
        }

        return {
            content: `--- ${path.basename(absPath)} (PDF) ---\n${text}`,
            data: text,
            isError: false,
            estimatedTokens: Math.ceil(text.length / 4),
        };
    }
}
