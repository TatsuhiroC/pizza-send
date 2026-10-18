export function safeName(name: string): string {
  let clean = name.replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = '_' + clean;
  const dot = clean.lastIndexOf('.');
  const extension = dot > 0 && clean.length - dot <= 20 ? clean.slice(dot) : '';
  const stem = extension ? clean.slice(0, dot) : clean;
  const encoder = new TextEncoder();
  let length = encoder.encode(extension).length, result = '';
  // Bound both UTF-16 and UTF-8 lengths, reserving space for collision prefixes.
  // Iterate code points so shortening cannot split an emoji surrogate pair.
  for (const character of stem) {
    const size = encoder.encode(character).length;
    if (result.length + character.length + extension.length > 180 || length + size > 240) break;
    result += character; length += size;
  }
  return result + extension || 'received-file';
}
