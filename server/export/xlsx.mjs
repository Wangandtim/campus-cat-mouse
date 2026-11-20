import { crc32, deflateRawSync } from 'node:zlib';

const columns = [
  ['rank', '排名', 8],
  ['name', '姓名', 16],
  ['studentId', '学号', 20],
  ['grade', '年级', 12],
  ['college', '学院', 26],
  ['className', '班级', 26],
  ['phone', '电话', 18],
  ['email', '邮箱', 32],
  ['meters', '有效里程（米）', 16],
  ['points', '积分', 10],
  ['captures', '抓捕数', 10],
  ['sessions', '参与场次', 12],
  ['flags', '异常标记', 32],
];
const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const spreadsheetNs = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNs = 'http://schemas.openxmlformats.org/package/2006';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const sheetWidths = columns.map(([, , width], index) =>
  `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');

function xmlText(value) {
  return value.replace(/[&<>"']/g, (char) => entities[char]);
}

function sheetName(value, maxLength = 31) {
  return value.toWellFormed().replace(/[\[\]:*?\/\\\u0000-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, '')
    .trim().slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, '').replace(/^[\s']+|[\s']+$/g, '') || '未分班';
}

export function classSheets(rows) {
  const groups = new Map();
  const nameCounts = new Map();
  for (const row of rows) {
    const college = row.college || '';
    const grade = row.grade || '';
    const className = row.className || '';
    const key = JSON.stringify([college, grade, className]);
    if (!groups.has(key)) {
      const base = sheetName(className);
      groups.set(key, { college, grade, className, base, rows: [] });
      const folded = base.toLowerCase();
      nameCounts.set(folded, (nameCounts.get(folded) ?? 0) + 1);
    }
    groups.get(key).rows.push(row);
  }
  const sheets = [{ name: '总榜', rows }];
  const used = new Set(['总榜', 'history']);
  for (const group of groups.values()) {
    const key = group.base.toLowerCase();
    const title = used.has(key) || nameCounts.get(key) > 1
      ? `${group.college || '未填学院'}-${group.grade || '未填年级'}-${group.className || '未分班'}`
      : group.base;
    let name = sheetName(title);
    for (let number = 2; used.has(name.toLowerCase()); number++) {
      const suffix = `-${number}`;
      name = sheetName(title, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    sheets.push({ name, rows: group.rows });
  }
  return sheets;
}

function rowXml(number, values) {
  const cells = values.map((value, column) => {
    const address = `${String.fromCharCode(65 + column)}${number}`;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new RangeError('Invalid numeric value in workbook.');
      return `<c r="${address}" t="n"><v>${value}</v></c>`;
    }
    let text = String(value ?? '').toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
    if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
    // Preserve literal text that resembles an OOXML character escape.
    text = text.replace(/_x(?=[0-9a-fA-F]{4}_)/g, '_x005F_x');
    return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
  });
  return `<row r="${number}">${cells.join('')}</row>`;
}

function* workbookParts(sheets) {
  const sheetParts = sheets.map(({ name, rows }, index) => ({
    name, rows, id: index + 1, path: `worksheets/sheet${index + 1}.xml`,
  }));
  yield ['[Content_Types].xml', `${declaration}<Types xmlns="${packageNs}/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/xl/workbook.xml" ContentType="${workbookType}.sheet.main+xml"/>
    ${sheetParts.map(({ path }) => `<Override PartName="/xl/${path}" ContentType="${workbookType}.worksheet+xml"/>`).join('')}
    </Types>`];
  yield ['_rels/.rels', `${declaration}<Relationships xmlns="${packageNs}/relationships">
    <Relationship Id="rId1" Type="${relationshipNs}/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>`];
  yield ['xl/workbook.xml', `${declaration}<workbook xmlns="${spreadsheetNs}" xmlns:r="${relationshipNs}"><sheets>
    ${sheetParts.map(({ name, id }) => `<sheet name="${xmlText(name)}" sheetId="${id}" r:id="rId${id}"/>`).join('')}
    </sheets></workbook>`];
  yield ['xl/_rels/workbook.xml.rels', `${declaration}<Relationships xmlns="${packageNs}/relationships">
    ${sheetParts.map(({ id, path }) => `<Relationship Id="rId${id}" Type="${relationshipNs}/worksheet" Target="${path}"/>`).join('')}
    </Relationships>`];
  const header = rowXml(1, columns.map(([, label]) => label));
  for (const { path, rows } of sheetParts) {
    const data = rows.map((row, index) => rowXml(index + 2, columns.map(([key]) => row[key]))).join('');
    yield [`xl/${path}`, `${declaration}<worksheet xmlns="${spreadsheetNs}"><cols>${sheetWidths}</cols>
      <sheetData>${header}${data}</sheetData></worksheet>`];
  }
}

export function createWorkbook(sheets) {
  const files = [];
  const directory = [];
  let fileOffset = 0;
  let directorySize = 0;
  for (const [path, xml] of workbookParts(sheets)) {
    const name = Buffer.from(path);
    const data = Buffer.from(xml);
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // ZIP 2.0 supports Deflate.
    local.writeUInt16LE(8, 8); // Deflate compression method.
    local.writeUInt16LE(0x21, 12); // January 1, 1980, the minimum DOS date.
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4); // Version needed through extra field length.
    central.writeUInt32LE(fileOffset, 42);
    directory.push(central, name);
    fileOffset += local.length + name.length + compressed.length;
    directorySize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(fileOffset, 16);
  return Buffer.concat([...files, ...directory, end]);
}
