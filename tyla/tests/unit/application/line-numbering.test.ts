/**
 * Unit Tests: line-numbering (plan 2026-06-11 §2.1)
 *
 * add/strip roundtrip, CRLF, empty input, and the strictness of
 * parseNumberedLines (all lines numbered AND consecutive, else null).
 */

import { describe, it, expect } from 'vitest';
import { addLineNumbers, stripLineNumberPrefixes, parseNumberedLines } from '../../../src/application/services/line-numbering';

describe('addLineNumbers', () => {
    it('prefixes each line with its 1-based number', () => {
        expect(addLineNumbers('a\nb\nc')).toBe('1| a\n2| b\n3| c');
    });

    it('right-aligns numbers to the widest line number', () => {
        const text = Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n');
        const out = addLineNumbers(text);
        expect(out.startsWith(' 1| l1\n')).toBe(true);
        expect(out.endsWith('10| l10')).toBe(true);
    });

    it('preserves a trailing newline without numbering a phantom line', () => {
        expect(addLineNumbers('a\nb\n')).toBe('1| a\n2| b\n');
    });

    it('returns empty for an empty file', () => {
        expect(addLineNumbers('')).toBe('');
    });

    it('keeps CRLF line endings intact', () => {
        expect(addLineNumbers('a\r\nb\r\n')).toBe('1| a\r\n2| b\r\n');
    });
});

describe('stripLineNumberPrefixes', () => {
    it('roundtrips with addLineNumbers', () => {
        const original = 'library(ggplot2)\nd123 <- rnorm(100)\nquantile(d123)\n';
        expect(stripLineNumberPrefixes(addLineNumbers(original))).toBe(original);
    });

    it('roundtrips CRLF content', () => {
        const original = 'x <- 1\r\ny <- 2\r\n';
        expect(stripLineNumberPrefixes(addLineNumbers(original))).toBe(original);
    });

    it('leaves unnumbered lines untouched', () => {
        expect(stripLineNumberPrefixes('plain code\nx | y')).toBe('plain code\nx | y');
    });

    it('strips mixed numbered/unnumbered lines defensively', () => {
        expect(stripLineNumberPrefixes(' 3| numbered\nplain')).toBe('numbered\nplain');
    });

    it('does not touch R pipe operators mid-line', () => {
        expect(stripLineNumberPrefixes('1| d |> filter(x > 2)')).toBe('d |> filter(x > 2)');
    });
});

describe('parseNumberedLines', () => {
    it('parses fully numbered consecutive lines', () => {
        expect(parseNumberedLines(' 9| a\n10| b\n11| c')).toEqual([
            { lineNo: 9, text: 'a' },
            { lineNo: 10, text: 'b' },
            { lineNo: 11, text: 'c' },
        ]);
    });

    it('tolerates a trailing newline', () => {
        expect(parseNumberedLines('1| a\n2| b\n')).toEqual([
            { lineNo: 1, text: 'a' },
            { lineNo: 2, text: 'b' },
        ]);
    });

    it('returns null when any line lacks a number', () => {
        expect(parseNumberedLines('1| a\nb\n3| c')).toBeNull();
    });

    it('returns null when numbers are not consecutive', () => {
        expect(parseNumberedLines('1| a\n3| c')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(parseNumberedLines('')).toBeNull();
    });

    it('captures empty line content', () => {
        expect(parseNumberedLines('4| ')).toEqual([{ lineNo: 4, text: '' }]);
    });
});
