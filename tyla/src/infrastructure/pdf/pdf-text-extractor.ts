/**
 * Infrastructure: PDF text extractor
 *
 * Owns the pdf-parse v2 object lifecycle so no other file needs to repeat
 * the `new PDFParse → getText → destroy` sequence. Two callers share this:
 *
 *   - PdfReadTool   (ask / ReAct path, 100k-char cap applied by the tool)
 *   - ContinuationFileLoader  (B3 path, per-turn token cap applied by the loader)
 *
 * Throws on parse failure; callers are responsible for catching and surfacing
 * the error in a way that fits their own error-reporting contract.
 */

import { PDFParse } from 'pdf-parse';

/**
 * Extracts plain text from a PDF buffer.
 * Returns the raw text string (may be empty for image-only / encrypted PDFs).
 * Throws if pdf-parse fails to parse the buffer.
 */
export async function extractPdfText(buf: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    await parser.destroy();
    return result.text;
}
