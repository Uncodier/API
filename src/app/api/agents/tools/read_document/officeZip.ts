import JSZip from 'jszip';

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const MAX_TOTAL_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_ENTRY_NAME_BYTES = 1_024;

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
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const files = Object.values(zip.files).filter(file => !file.dir);
  if (files.length > MAX_ENTRIES) throw new Error(`Office document exceeds the ${MAX_ENTRIES} ZIP entry limit.`);

  const expandedSizes = new Map<string, number>();
  let totalCompressed = 0;
  let totalExpanded = 0;
  for (const file of files) {
    if (Buffer.byteLength(file.name, 'utf8') > MAX_ENTRY_NAME_BYTES) throw new Error('Office document contains an excessively long ZIP entry name.');
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