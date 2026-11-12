interface Box { type: string; payload: Buffer }
function boxes(buffer: Buffer): Box[] {
  const found: Box[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length || found.length > 10000) throw new Error('Invalid MP4 boxes');
    let size = buffer.readUInt32BE(offset), header = 8;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > buffer.length) throw new Error('Truncated MP4 box');
      const large = buffer.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized MP4 box');
      size = Number(large); header = 16;
    }
    if (size === 0) size = buffer.length - offset;
    if (size < header || offset + size > buffer.length) throw new Error('Truncated MP4 box');
    found.push({ type, payload: buffer.subarray(offset + header, offset + size) });
    offset += size;
  }
  return found;
}
function required(items: Box[], type: string, min = 0) {
  const matching = items.filter(box => box.type === type);
  if (matching.length !== 1 || matching[0].payload.length < min) throw new Error(`Invalid MP4 ${type}`);
  return matching[0].payload;
}

/** Non-fragmented sample tables with real, bounded media ranges; not bitstream decoding. */
function samples(table: Box[], entries: Box[], buffer: Buffer, media: Box[]) {
  for (const entry of entries) {
    const config = boxes(entry.payload.subarray(78));
    // Deliberately support AVC only until other codec configurations are validated.
    if (!['avc1', 'avc3'].includes(entry.type)) throw new Error('Unsupported MP4 codec');
    const avc = required(config, 'avcC', 7);
    if (avc[0] !== 1 || !(avc[5] & 31)) throw new Error('Missing AVC parameter sets');
    let at = 6;
    const parameterSets = (count: number) => {
      if (!count) throw new Error('Missing AVC parameter sets');
      for (let i = 0; i < count; i++) {
        if (at + 2 > avc.length) throw new Error('Truncated AVC configuration');
        const size = avc.readUInt16BE(at); at += 2;
        if (!size || at + size > avc.length) throw new Error('Truncated AVC configuration');
        at += size;
      }
    };
    parameterSets(avc[5] & 31);
    if (at >= avc.length) throw new Error('Missing AVC picture parameters');
    parameterSets(avc[at++]);
  }
  const sizes = required(table, 'stsz', 12), count = sizes.readUInt32BE(8), fixed = sizes.readUInt32BE(4);
  if (!count || count > buffer.length || sizes.length !== 12 + (fixed ? 0 : count * 4)) throw new Error('Invalid MP4 sample sizes');
  const timing = required(table, 'stts', 8), times = timing.readUInt32BE(4);
  if (!times || timing.length !== 8 + times * 8) throw new Error('Invalid MP4 timing');
  let timed = 0;
  for (let at = 8; at < timing.length; at += 8) {
    if (!timing.readUInt32BE(at) || !timing.readUInt32BE(at + 4)) throw new Error('Empty MP4 timing');
    timed += timing.readUInt32BE(at);
  }
  if (timed !== count) throw new Error('MP4 sample count mismatch');
  const offsets = table.some(box => box.type === 'co64') ? required(table, 'co64', 8) : required(table, 'stco', 8);
  const wide = table.some(box => box.type === 'co64'), width = wide ? 8 : 4, chunks = offsets.readUInt32BE(4);
  if (!chunks || offsets.length !== 8 + chunks * width) throw new Error('Invalid MP4 chunks');
  const mapping = required(table, 'stsc', 8), mappings = mapping.readUInt32BE(4);
  if (!mappings || mapping.length !== 8 + mappings * 12 || mapping.readUInt32BE(8) !== 1) throw new Error('Invalid MP4 chunk mapping');
  for (let i = 0; i < mappings; i++) {
    const at = 8 + i * 12, first = mapping.readUInt32BE(at);
    if (first > chunks || (i && first <= mapping.readUInt32BE(at - 12))
        || !mapping.readUInt32BE(at + 4) || !mapping.readUInt32BE(at + 8)
        || mapping.readUInt32BE(at + 8) > entries.length) throw new Error('Invalid MP4 chunk mapping');
  }
  let sample = 0, map = 0;
  for (let chunk = 1; chunk <= chunks; chunk++) {
    if (map + 1 < mappings && mapping.readUInt32BE(8 + (map + 1) * 12) === chunk) map++;
    const perChunk = mapping.readUInt32BE(12 + map * 12);
    if (sample + perChunk > count) throw new Error('MP4 sample count mismatch');
    const at = 8 + (chunk - 1) * width;
    const start = wide ? Number(offsets.readBigUInt64BE(at)) : offsets.readUInt32BE(at);
    let length = 0;
    for (let i = 0; i < perChunk; i++, sample++) {
      const size = fixed || sizes.readUInt32BE(12 + sample * 4);
      if (!size) throw new Error('Empty MP4 sample');
      length += size;
    }
    if (!Number.isSafeInteger(start) || !media.some(box => {
      const begin = box.payload.byteOffset - buffer.byteOffset;
      return start >= begin && start + length <= begin + box.payload.length;
    })) throw new Error('MP4 sample outside media');
  }
  if (sample !== count) throw new Error('MP4 sample count mismatch');
}

/** Structural ISO-BMFF validation, not a codec decoder or visual quality check. */
export function validateCustomerMp4(buffer: Buffer) {
  const top = boxes(buffer);
  const ftyp = required(top, 'ftyp', 12);
  const brands: string[] = [ftyp.toString('ascii', 0, 4)];
  for (let at = 8; at + 4 <= ftyp.length; at += 4) brands.push(ftyp.toString('ascii', at, at + 4));
  if (ftyp.length % 4 || !brands.some(brand => ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand))) {
    throw new Error('Unsupported MP4 brand');
  }
  if (!top.some(box => box.type === 'mdat' && box.payload.length > 0)) throw new Error('Empty MP4 media');
  const movie = boxes(required(top, 'moov'));
  required(movie, 'mvhd', 20);
  const tracks = movie.filter(box => box.type === 'trak');
  let video = false;
  for (const track of tracks) {
    const children = boxes(track.payload);
    required(children, 'tkhd', 20);
    const media = boxes(required(children, 'mdia'));
    required(media, 'mdhd', 20);
    const handler = required(media, 'hdlr', 12).toString('ascii', 8, 12);
    const info = boxes(required(media, 'minf'));
    const table = boxes(required(info, 'stbl'));
    const descriptions = required(table, 'stsd', 8);
    const entries = boxes(descriptions.subarray(8));
    if (descriptions.readUInt32BE(4) !== entries.length || !entries.length) throw new Error('Invalid MP4 sample descriptions');
    if (handler === 'vide') {
      if (!entries.every(entry => ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09'].includes(entry.type)
          && entry.payload.length >= 78 && entry.payload.readUInt16BE(24) > 0 && entry.payload.readUInt16BE(26) > 0)) {
        throw new Error('Unsupported MP4 video samples');
      }
      samples(table, entries, buffer, top.filter(box => box.type === 'mdat'));
      video = true;
    }
  }
  if (!video) throw new Error('Missing MP4 video track');
}