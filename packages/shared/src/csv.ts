/**
 * CSV, parsed and written properly (`FR-IO-1`).
 *
 * Hand-written rather than taken from a dependency because the hard parts are not the parsing —
 * they are the decisions, and a library would make them silently:
 *
 *  * **a quoted field may contain commas, newlines and doubled quotes**, which is most of RFC 4180
 *    and the half that naive `split(',')` importers get wrong;
 *  * **the delimiter is not always a comma.** A spreadsheet exported from Excel in most of Europe
 *    and much of Latin America uses `;`, and one from a database export often uses a tab. An
 *    importer that assumes a comma reads such a file as a single column and tells the user their
 *    file is empty, which is the single most common support ticket an import feature produces;
 *  * **a UTF-8 BOM** is prepended by Excel on Windows, and an unstripped BOM turns the first header
 *    into a `name` with a byte-order mark glued to its front, so the first column
 *    silently fails to map;
 *  * **rows are ragged.** Real files have trailing commas, short rows and a stray blank line at the
 *    end. Each of those is normal and none of them should fail an import.
 *
 * Everything here is pure and synchronous: a 10 000-row file is a few megabytes, and streaming
 * would buy nothing while making the error reporting harder.
 */

/** The delimiters worth sniffing. Order matters only for a tie, which is vanishingly unlikely. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export interface CsvParseOptions {
  /** Forced delimiter. Omitted means sniff. */
  readonly delimiter?: CsvDelimiter;
  /** Rows to read, after the header. Guards against a file far larger than expected. */
  readonly maxRows?: number;
}

export interface CsvTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: CsvDelimiter;
  /** True when `maxRows` stopped the read before the end of the file. */
  readonly truncated: boolean;
}

const BOM = '﻿';

/**
 * Guesses the delimiter from the first line.
 *
 * Counts candidates **outside quotes**, because `"Patel, Shah & Co";42` has more commas than
 * semicolons and is semicolon-delimited. The winner is the one that appears most; a file with none
 * of them is a single-column file and reads fine as a comma file.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const firstLine = firstPhysicalLine(stripBom(text));
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const candidate of CSV_DELIMITERS) {
    const count = countOutsideQuotes(firstLine, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function firstPhysicalLine(text: string): string {
  // Only up to the first newline that is not inside quotes: a quoted header cell may contain one.
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (character === '\n' || character === '\r')) {
      return text.slice(0, index);
    }
  }
  return text;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && character === delimiter) {
      count += 1;
    }
  }
  return count;
}

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Parses a whole file.
 *
 * A row of entirely empty cells is dropped: a trailing newline is universal, and an importer that
 * reported "row 1001 is invalid: name is required" for the blank line at the end of every file
 * would be wrong about its own input.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvTable {
  const content = stripBom(text);
  const delimiter = options.delimiter ?? sniffDelimiter(content);
  const limit = options.maxRows;

  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let truncated = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): boolean => {
    endField();
    // **Every** physical row is kept, including one that is nothing but separators.
    //
    // Dropping blank rows is the obvious tidiness and it is wrong: the row number an import reports
    // is the number the person's own spreadsheet shows them, and silently removing row 300 renumbers
    // every row after it — so "row 412 has a bad phone number" points at the wrong line, and the
    // further down the file the mistake is, the further out the number. A caller that wants to
    // ignore blank rows can see they are blank; a caller that has lost them cannot get them back.
    rows.push(row);
    row = [];
    // The header is row 0, so the limit applies to what follows it.
    if (limit !== undefined && rows.length > limit) {
      truncated = true;
      return false;
    }
    return true;
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;

    if (inQuotes) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field === '') {
      // Only an *opening* quote at the start of a field opens a quoted field; a stray quote
      // mid-field is data, which is what a hand-edited file tends to contain.
      inQuotes = true;
    } else if (character === delimiter) {
      endField();
    } else if (character === '\n') {
      if (!endRow()) break;
    } else if (character === '\r') {
      // CRLF: the \n is consumed here so an empty row is not invented between them.
      if (content[index + 1] === '\n') index += 1;
      if (!endRow()) break;
    } else {
      field += character;
    }
  }

  // A file with no trailing newline still has a last row.
  if (!truncated && (field !== '' || row.length > 0)) endRow();

  const [header = [], ...rest] = rows;
  return {
    header: header.map((cell) => cell.trim()),
    rows: limit === undefined ? rest : rest.slice(0, limit),
    delimiter,
    truncated,
  };
}

/** One row by index, padded or trimmed to the header's width so a ragged file reads evenly. */
export function alignRow(row: readonly string[], width: number): string[] {
  const aligned = row.slice(0, width);
  while (aligned.length < width) aligned.push('');
  return aligned;
}

/** A row as `{ header: cell }`, which is what a mapping is applied to. */
export function rowToRecord(
  header: readonly string[],
  row: readonly string[],
): Record<string, string> {
  const record: Record<string, string> = {};
  const aligned = alignRow(row, header.length);
  header.forEach((name, index) => {
    record[name] = aligned[index] ?? '';
  });
  return record;
}

/**
 * Writes a cell, quoting only when it must.
 *
 * The `=`/`+`/`-`/`@` guard is the one non-obvious rule: a cell beginning with those is executed as
 * a formula when the file is opened in Excel or Sheets, so an exported lead called `=cmd|…` becomes
 * a CSV injection in somebody else's spreadsheet. Prefixing a tab neutralises it while leaving the
 * value readable — the file is data we hand to a person, and it must not carry an attack.
 */
export function csvCell(value: unknown, delimiter: string = ','): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  const guarded = FORMULA_START.test(text) ? `\t${text}` : text;
  const mustQuote =
    guarded !== text ||
    guarded.includes('"') ||
    guarded.includes('\n') ||
    guarded.includes('\r') ||
    guarded.includes(delimiter);
  return mustQuote ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** Cells a spreadsheet would execute. `+` matters because every E.164 phone number starts with it. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Undoes the formula guard on the way back in.
 *
 * The pair matters: `FR-IO-1` requires re-importing a corrected export, so a value this module
 * guarded on the way out has to come back as itself. A single leading tab is never meaningful in a
 * CSV cell — a spreadsheet does not produce one and nobody types one — so stripping exactly one is
 * safe, and it is the inverse of the guard rather than a guess at the writer's intent.
 */
export function unguardCell(value: string): string {
  return value.startsWith('\t') && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

export interface CsvWriteOptions {
  readonly delimiter?: string;
  /** Excel on Windows needs the BOM to read UTF-8; everything else tolerates it. */
  readonly bom?: boolean;
  /** CRLF is what every spreadsheet writes, and some older tools require. */
  readonly newline?: '\n' | '\r\n';
}

/**
 * One line, terminated.
 *
 * Exported because a large export is written a page at a time: the generator appends each page's
 * text and lets the page's cell arrays go, instead of holding every cell of every row until the
 * end. It is the same function `writeCsv` uses, so the two cannot disagree about quoting, the
 * formula guard or the line ending.
 */
export function csvRow(cells: readonly unknown[], options: CsvWriteOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const newline = options.newline ?? '\r\n';
  return `${cells.map((cell) => csvCell(cell, delimiter)).join(delimiter)}${newline}`;
}

/** The byte-order mark alone, for a file assembled a line at a time. */
export function csvPrelude(options: CsvWriteOptions = {}): string {
  return options.bom === false ? '' : BOM;
}

export function writeCsv(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: CsvWriteOptions = {},
): string {
  let text = csvPrelude(options) + csvRow(header, options);
  for (const row of rows) text += csvRow(row, options);
  return text;
}
