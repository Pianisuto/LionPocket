import { expect, it } from 'vitest';
import JSZip = require('jszip/dist/jszip.min.js');
import { readXlsxBase64 } from './xlsx';
import { planFinancialSpreadsheet } from './spreadsheet-import';

it('decodifica XLSX binário, shared/inline strings, fórmulas em cache e nomes das abas', async () => {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="urn:r"><sheets><sheet name="Set" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file('xl/sharedStrings.xml', '<sst><si><r><t>Compra </t></r><r><t>XLSX</t></r></si></sst>');
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Setembro 2026</t></is></c></row><row r="32"><c r="B32"><v>30</v></c><c r="C32" t="s"><v>0</v></c><c r="F32"><f>10+20</f><v>30</v></c></row></sheetData></worksheet>',
  );
  const workbook = await readXlsxBase64(
    await zip.generateAsync({ type: 'base64', compression: 'DEFLATE' }),
  );
  const plan = planFinancialSpreadsheet(workbook, 'financeiro.xlsx', '2026-09');
  expect(plan.transactions[0]).toMatchObject({
    input: { description: 'Compra XLSX', plannedAmount: 30, dueDate: '2026-09-30' },
    sourceKey: 'xlsx:financeiro.xlsx:Set:32',
  });
});
it('recusa arquivo que não é XLSX', async () => {
  await expect(readXlsxBase64('aW52YWxpZG8=')).rejects.toThrow();
  const zip = new JSZip();
  zip.file('abc.txt', 'sem workbook');
  await expect(readXlsxBase64(await zip.generateAsync({ type: 'base64' }))).rejects.toThrow('XLSX');
});
