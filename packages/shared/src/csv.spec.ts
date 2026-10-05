import { describe, expect, it } from 'vitest';
import {
  alignRow,
  csvCell,
  unguardCell,
  parseCsv,
  rowToRecord,
  sniffDelimiter,
  stripBom,
  writeCsv,
} from './csv.js';

describe('parsing the CSV people actually upload', () => {
  it('reads a plain file', () => {
    const table = parseCsv('name,phone\nAnita,+919812390001\nRakesh,+919812390002\n');
    expect(table.header).toEqual(['name', 'phone']);
    expect(table.rows).toEqual([
      ['Anita', '+919812390001'],
      ['Rakesh', '+919812390002'],
    ]);
  });

  it('keeps a comma inside a quoted field', () => {
    // The failure this prevents: "Patel, Shah & Co" becoming two columns and shifting every value
    // in the row one place to the right, which an importer then stores without complaint.
    const table = parseCsv('name,company\nAnita,"Patel, Shah & Co"\n');
    expect(table.rows[0]).toEqual(['Anita', 'Patel, Shah & Co']);
  });

  it('keeps a newline inside a quoted field', () => {
    const table = parseCsv('name,address\nAnita,"12 MG Road\nPune"\n');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.[1]).toBe('12 MG Road\nPune');
  });

  it('unescapes a doubled quote', () => {
    const table = parseCsv('name,note\nAnita,"she said ""yes"" twice"\n');
    expect(table.rows[0]?.[1]).toBe('she said "yes" twice');
  });

  it('treats a stray quote mid-field as data, because hand-edited files contain them', () => {
    const table = parseCsv('name,size\nPipe,6" diameter\n');
    expect(table.rows[0]).toEqual(['Pipe', '6" diameter']);
  });

  it('handles CRLF without inventing a blank row between them', () => {
    const table = parseCsv('name,phone\r\nAnita,1\r\nRakesh,2\r\n');
    expect(table.rows).toEqual([
      ['Anita', '1'],
      ['Rakesh', '2'],
    ]);
  });

  it('handles a file with no trailing newline', () => {
    const table = parseCsv('name,phone\nAnita,1');
    expect(table.rows).toEqual([['Anita', '1']]);
  });

  it('strips the BOM Excel on Windows prepends', () => {
    // An unstripped BOM glues itself to the first header, so that column silently
    // fails to map and nobody can see why.
    const table = parseCsv('﻿name,phone\nAnita,1\n');
    expect(table.header[0]).toBe('name');
    expect(stripBom('﻿x')).toBe('x');
  });

  it('keeps a blank line, because dropping one renumbers every row after it', () => {
    const table = parseCsv('name,phone\nAnita,1\n\n\nRakesh,2\n');
    // Rakesh is on line 5 of the file and must still be row 5 here. Tidying the blank lines away
    // would make him row 3, so an error report would point at somebody else's row — and the
    // further down the file, the further out the number.
    expect(table.rows).toEqual([['Anita', '1'], [''], [''], ['Rakesh', '2']]);
  });

  it('keeps a short row and a long row, both of which are normal', () => {
    const table = parseCsv('name,phone,city\nAnita,1\nRakesh,2,Pune,extra\n');
    expect(table.rows[0]).toEqual(['Anita', '1']);
    expect(table.rows[1]).toEqual(['Rakesh', '2', 'Pune', 'extra']);
  });

  it('keeps a row whose cells are empty but present', () => {
    const table = parseCsv('name,phone\n,\nAnita,1\n');
    // It carries no data, and it is still line 2. Deciding it is noise is the importer's job —
    // which it does by reporting the row as skipped, under the number the person can see.
    expect(table.rows).toEqual([
      ['', ''],
      ['Anita', '1'],
    ]);
  });

  it('trims the header but not the data', () => {
    const table = parseCsv('  name , phone \n  Anita  , 1 \n');
    expect(table.header).toEqual(['name', 'phone']);
    // Leading space in a value may be meaningful; trimming is the importer's decision, per field.
    expect(table.rows[0]).toEqual(['  Anita  ', ' 1 ']);
  });

  it('stops at maxRows and says it did', () => {
    const table = parseCsv('name\na\nb\nc\nd\n', { maxRows: 2 });
    expect(table.rows).toHaveLength(2);
    expect(table.truncated).toBe(true);
  });

  it('reports an empty file as empty rather than throwing', () => {
    expect(parseCsv('').header).toEqual([]);
    expect(parseCsv('').rows).toEqual([]);
    // A file of nothing but newlines has a blank header and blank rows, which is what it is. The
    // import refuses it before this point, with a sentence rather than a header of one empty name.
    expect(parseCsv('\n\n').header).toEqual(['']);
    expect(parseCsv('\n\n').rows).toEqual([['']]);
  });

  it('reads a header-only file as no rows', () => {
    const table = parseCsv('name,phone\n');
    expect(table.header).toEqual(['name', 'phone']);
    expect(table.rows).toEqual([]);
  });
});

describe('the delimiter is not always a comma', () => {
  it('sniffs a semicolon file, which is what Excel writes in most of Europe', () => {
    // An importer that assumes a comma reads this as one column and tells the user their file is
    // empty — the single most common support ticket an import feature produces.
    const table = parseCsv('name;phone;city\nAnita;1;Pune\n');
    expect(table.delimiter).toBe(';');
    expect(table.rows[0]).toEqual(['Anita', '1', 'Pune']);
  });

  it('sniffs a tab file', () => {
    expect(parseCsv('name\tphone\nAnita\t1\n').delimiter).toBe('\t');
  });

  it('sniffs a pipe file', () => {
    expect(parseCsv('name|phone\nAnita|1\n').delimiter).toBe('|');
  });

  it('counts delimiters outside quotes only', () => {
    // Three commas inside one quoted cell must not beat the two real semicolons.
    expect(sniffDelimiter('"a,b,c,d";x;y')).toBe(';');
  });

  it('is not confused by a newline inside a quoted header cell', () => {
    expect(sniffDelimiter('"first\nname";phone')).toBe(';');
  });

  it('reads a single-column file as one column', () => {
    const table = parseCsv('phone\n+919812390001\n');
    expect(table.header).toEqual(['phone']);
    expect(table.rows).toEqual([['+919812390001']]);
  });

  it('honours a forced delimiter over the sniff', () => {
    const table = parseCsv('a;b,c\n1;2,3\n', { delimiter: ',' });
    expect(table.header).toEqual(['a;b', 'c']);
  });
});

describe('rows become records for mapping', () => {
  it('pads a short row and trims a long one to the header width', () => {
    expect(alignRow(['a'], 3)).toEqual(['a', '', '']);
    expect(alignRow(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
  });

  it('keys a row by its header', () => {
    expect(rowToRecord(['name', 'phone'], ['Anita'])).toEqual({ name: 'Anita', phone: '' });
  });
});

describe('writing CSV', () => {
  it('quotes only what needs it', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has,comma')).toBe('"has,comma"');
    expect(csvCell('has"quote')).toBe('"has""quote"');
    expect(csvCell('has\nnewline')).toBe('"has\nnewline"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('neutralises a formula, so an export cannot attack the spreadsheet that opens it', () => {
    // `=cmd|…` in a lead's name is executed on open in Excel and Sheets. The tab prefix stops that
    // while leaving the value readable.
    expect(csvCell('=1+1')).toBe('"\t=1+1"');
    expect(csvCell('+41 22 000')).toBe('"\t+41 22 000"');
    expect(csvCell('-5')).toBe('"\t-5"');
    expect(csvCell('@user')).toBe('"\t@user"');
    // A plain phone number in E.164 starts with `+`, so it is guarded too — correct, and visible.
    expect(csvCell('+919812390001')).toContain('+919812390001');
  });

  it('undoes the guard on the way back in, so a corrected export re-imports as itself', () => {
    // FR-IO-1 requires re-importing a corrected failed-rows file, so the guard must be reversible.
    for (const value of ['=1+1', '+919812390001', '-5', '@user']) {
      const written = csvCell(value);
      const parsed = parseCsv(`h\n${written}\n`).rows[0]?.[0] ?? '';
      expect(unguardCell(parsed)).toBe(value);
    }
  });

  it('leaves an ordinary value alone, and a tab that is really data', () => {
    expect(unguardCell('Anita')).toBe('Anita');
    // Only a tab followed by a formula character is a guard; a tab before a letter is data.
    expect(unguardCell('\tAnita')).toBe('\tAnita');
  });

  it('round-trips everything it wrote, through the guard', () => {
    const header = ['name', 'company', 'note', 'phone'];
    const rows = [
      ['Anita', 'Patel, Shah & Co', 'said "yes"', '+919812390001'],
      ['Rakesh', 'Line\nBreak Ltd', '', '=SUM(A1)'],
    ];
    const parsed = parseCsv(writeCsv(header, rows), { delimiter: ',' });
    expect(parsed.header).toEqual(header);
    expect(parsed.rows.map((row) => row.map(unguardCell))).toEqual(rows);
  });

  it('writes the BOM by default, because Excel needs it to read UTF-8', () => {
    expect(writeCsv(['naam'], [['अनिता']])).toMatch(/^\uFEFF/);
    expect(writeCsv(['naam'], [['अनिता']], { bom: false })).not.toMatch(/^\uFEFF/);
  });

  it('ends every line with CRLF by default', () => {
    expect(writeCsv(['a'], [['1']])).toBe('﻿a\r\n1\r\n');
  });
});
