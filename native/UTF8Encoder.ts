/**
 * Takes a String and writes it into an array as UTF8 encoded bytes.
 * @private
 */
export function stringToUTF8(input: string, output: Uint8Array, start: number): Uint8Array {
  let pos = start;
  for (let i = 0; i < input.length; i++) {
    let charCode = input.charCodeAt(i);

    // Check for a surrogate pair.
    if (charCode >= 0xD800 && charCode <= 0xDBFF) {
      const lowCharCode = input.charCodeAt(++i);
      if (isNaN(lowCharCode)) {
        throw new Error(`AMQJS0017E Malformed Unicode string: ${charCode} ${lowCharCode}.`);
      }

      charCode = ((charCode - 0xD800) << 10) + (lowCharCode - 0xDC00) + 0x10000;
    }

    if (charCode <= 0x7F) {
      output[pos++] = charCode;
    } else if (charCode <= 0x7FF) {
      output[pos++] = charCode >> 6 & 0x1F | 0xC0;
      output[pos++] = charCode & 0x3F | 0x80;
    } else if (charCode <= 0xFFFF) {
      output[pos++] = charCode >> 12 & 0x0F | 0xE0;
      output[pos++] = charCode >> 6 & 0x3F | 0x80;
      output[pos++] = charCode & 0x3F | 0x80;
    } else {
      output[pos++] = charCode >> 18 & 0x07 | 0xF0;
      output[pos++] = charCode >> 12 & 0x3F | 0x80;
      output[pos++] = charCode >> 6 & 0x3F | 0x80;
      output[pos++] = charCode & 0x3F | 0x80;
    }
  }
  return output;
}

class UTF8Encoder {
  encode(str: string): Uint8Array {
    const out = new Uint8Array(0)
    return stringToUTF8(str, out, 0)
  }
}

export default UTF8Encoder