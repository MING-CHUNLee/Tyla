/**
 * Tool: FileReadTool
 *
 * Validates the LLM's tool-call input and delegates all fs I/O to
 * FileReadService — no filesystem calls live here.
 */

import path from 'path';
import { AgentTool, ToolInput, ToolResult, ToolSchema } from '../../domain/types/agent-tool';
import { FileReadService } from '../services/file-read-service';

export class FileReadTool implements AgentTool {
    readonly name = 'file_read';

    constructor(private readonly fileReadService: FileReadService) {}

    readonly schema: ToolSchema = {
        name: 'file_read',
        description: 'Read the full content of a file from disk. Returns the file content as text.',
        parameters: {
            path: {
                type: 'string',
                description: 'The file path to read (relative to the workspace root)',
                required: true,
            },
        },
        example: '[ACTION {"tool":"file_read","input":{"path":"analysis.R"}}]',
    };

    async execute(input: ToolInput): Promise<ToolResult> {
        const filePath = input.path as string | undefined;
        if (!filePath?.trim()) return { content: 'No file path provided.', isError: true };

        const result = this.fileReadService.read(filePath);
        if ('error' in result) return { content: result.error, isError: true };

        return {
            content: `--- ${path.basename(result.absPath)} ---\n${result.content}`,
            data: result.content,
            isError: false,
            estimatedTokens: Math.ceil(result.content.length / 4),
        };
    }
}
