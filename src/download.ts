const extensionTypes: Record<string, string> = {
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
  html: 'text/html', htm: 'text/html', xml: 'application/xml', css: 'text/css', js: 'text/javascript',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', bin: 'application/octet-stream',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip'
};

export function downloadType(info: { name: string; type: string }): string {
  const type = info.type.split(';', 1)[0].trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) &&
      !['application/octet-stream', 'binary/octet-stream', 'application/binary'].includes(type)) return type;
  const extension = info.name.includes('.') ? info.name.split('.').pop()!.toLowerCase() : '';
  // Unknown types stay unspecified rather than advertising every file as .bin.
  return Object.prototype.hasOwnProperty.call(extensionTypes, extension) ? extensionTypes[extension] : '';
}
