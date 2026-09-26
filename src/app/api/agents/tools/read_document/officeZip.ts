import JSZip from 'jszip';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_TOTAL_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_ENTRY_NAME_BYTES = 1_024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;

function preflightCentralDirectory(buffer: Buffer): void {
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Office document has an invalid ZIP central directory.');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const diskEntries = buffer.readUInt16LE(eocd + 8);
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entries) throw new Error('Multi-disk ZIP archives are not supported.');
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 Office documents are not supported.');
  if (entries > MAX_ENTRIES) throw new Error(`Office document exceeds the ${MAX_ENTRIES} ZIP entry limit.`);
  if (centralOffset + centralSize !== eocd || centralOffset > buffer.length) throw new Error('Office document has an invalid ZIP central directory.');
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== CENTRAL_FILE_SIGNATURE) throw new Error('Office document has a malformed ZIP entry.');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    if (nameLength > MAX_ENTRY_NAME_BYTES) throw new Error('Office document contains an excessively long ZIP entry name.');
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > eocd) throw new Error('Office document has a malformed ZIP entry.');
  }
  if (offset !== eocd) throw new Error('Office document has an inconsistent ZIP entry count.');
}

type ZipData = { compressedSize?: number; uncompressedSize?: number };

export type SafeOfficeZip = {
  zip: JSZip;
  expandedSizes: Map<string, number>;
};

function finiteSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function loadOfficeZip(buffer: Buffer): Promise<SafeOfficeZip> {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Office document exceeds the 20 MB archive limit.');
  preflightCentralDirectory(buffer);
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const files = Object.values(zip.files);

  const expandedSizes = new Map<string, number>();
  let totalCompressed = 0;
  let totalExpanded = 0;
  for (const file of files) {
    if (Buffer.byteLength(file.name, 'utf8') > MAX_ENTRY_NAME_BYTES) throw new Error('Office document contains an excessively long ZIP entry name.');
    if (file.dir) continue;
    const data = (file as unknown as { _data?: ZipData })._data;
    if (!finiteSize(data?.compressedSize) || !finiteSize(data?.uncompressedSize)) {
      throw new Error('Office document contains invalid ZIP size metadata.');
    }
    const compressed = data.compressedSize;
    const expanded = data.uncompressedSize;
    if (expanded > MAX_ENTRY_EXPANDED_BYTES) throw new Error(`ZIP entry ${file.name} exceeds the 32 MB expanded limit.`);
    if (expanded > 0 && (compressed === 0 || expanded / compressed > MAX_COMPRESSION_RATIO)) {
      throw new Error(`ZIP entry ${file.name} exceeds the compression ratio limit.`);
    }
    totalCompressed += compressed;
    totalExpanded += expanded;
    if (totalExpanded > MAX_TOTAL_EXPANDED_BYTES) throw new Error('Office document exceeds the 128 MB total expanded limit.');
    expandedSizes.set(file.name, expanded);
  }
  if (totalExpanded > 0 && (totalCompressed === 0 || totalExpanded / totalCompressed > MAX_COMPRESSION_RATIO)) {
    throw new Error('Office document exceeds the aggregate compression ratio limit.');
  }
  return { zip, expandedSizes };
}