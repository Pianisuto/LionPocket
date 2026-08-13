import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export type XlsxCellValue = string | number | boolean | null;

type XmlNode = Record<string, unknown>;

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const columnNumber = (address: string): number => {
  const letters = address.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? 'A';
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
};

const richText = (node: unknown): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(richText).join('');
  const record = node as XmlNode;
  if (record.t !== undefined) return richText(record.t);
  if (record.r !== undefined) return richText(record.r);
  if (record['#text'] !== undefined) return richText(record['#text']);
  return '';
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});

export class XlsxWorksheet {
  private readonly cells = new Map<string, XlsxCellValue>();

  constructor(readonly name: string) {}

  setCell(row: number, column: number, value: XlsxCellValue) {
    this.cells.set(`${row}:${column}`, value);
  }

  getCell(row: number, column: number) {
    return { value: this.cells.get(`${row}:${column}`) ?? null };
  }
}

export class XlsxWorkbook {
  private readonly worksheets = new Map<string, XlsxWorksheet>();

  addWorksheet(sheet: XlsxWorksheet) {
    this.worksheets.set(sheet.name, sheet);
  }

  getWorksheet(name: string) {
    return this.worksheets.get(name);
  }
}

const parseSharedStrings = async (zip: JSZip): Promise<string[]> => {
  const file = zip.file('xl/sharedStrings.xml');
  if (!file) return [];
  const xml = parser.parse(await file.async('text')) as XmlNode;
  const table = xml.sst as XmlNode | undefined;
  return asArray(table?.si).map(richText);
};

const readCell = (cell: XmlNode, sharedStrings: string[]): XlsxCellValue => {
  const type = String(cell['@_t'] ?? 'n');
  if (type === 'inlineStr') return richText(cell.is);
  const raw = richText(cell.v);
  if (type === 's') return sharedStrings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1';
  if (type === 'str') return raw;
  if (type === 'e') return null;
  if (raw === '') return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
};

export const readXlsx = async (filePath: string): Promise<XlsxWorkbook> => {
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const workbookFile = zip.file('xl/workbook.xml');
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookFile || !relsFile) throw new Error('A planilha não possui uma estrutura XLSX válida.');

  const workbookXml = parser.parse(await workbookFile.async('text')) as XmlNode;
  const relsXml = parser.parse(await relsFile.async('text')) as XmlNode;
  const workbookNode = workbookXml.workbook as XmlNode;
  const sheetsNode = workbookNode.sheets as XmlNode;
  const relationshipsNode = relsXml.Relationships as XmlNode;
  const relationships = new Map(
    asArray(relationshipsNode.Relationship as XmlNode | XmlNode[] | undefined).map((relationship) => [
      String(relationship['@_Id']),
      String(relationship['@_Target']),
    ]),
  );
  const sharedStrings = await parseSharedStrings(zip);
  const workbook = new XlsxWorkbook();

  for (const sheetNode of asArray(sheetsNode.sheet as XmlNode | XmlNode[] | undefined)) {
    const name = String(sheetNode['@_name']);
    const relationshipId = String(sheetNode['@_id']);
    const target = relationships.get(relationshipId);
    if (!target) continue;
    const normalizedTarget = target.startsWith('/')
      ? target.slice(1)
      : path.posix.normalize(path.posix.join('xl', target));
    const sheetFile = zip.file(normalizedTarget);
    if (!sheetFile) continue;
    const sheetXml = parser.parse(await sheetFile.async('text')) as XmlNode;
    const worksheetNode = sheetXml.worksheet as XmlNode;
    const sheetData = worksheetNode.sheetData as XmlNode | undefined;
    const worksheet = new XlsxWorksheet(name);

    for (const rowNode of asArray(sheetData?.row as XmlNode | XmlNode[] | undefined)) {
      const rowNumber = Number(rowNode['@_r']);
      for (const cellNode of asArray(rowNode.c as XmlNode | XmlNode[] | undefined)) {
        const address = String(cellNode['@_r'] ?? 'A1');
        worksheet.setCell(rowNumber, columnNumber(address), readCell(cellNode, sharedStrings));
      }
    }
    workbook.addWorksheet(worksheet);
  }

  return workbook;
};

