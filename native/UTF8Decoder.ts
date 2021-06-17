export function parseUTF8(input: Uint8Array, offset: number, length: number): string {
  let output = '';
  let utf16;
  let pos = offset;

  while (pos < offset + length) {
    let byte1 = input[pos++];
    if (byte1 < 128) {
      utf16 = byte1;
    } else {
      let byte2 = input[pos++] - 128;
      if (byte2 < 0) {
        throw new Error(`AMQJS0009E Malformed UTF data:${byte1.toString(16)} ${byte2.toString(16)}.`)
      }
      if (byte1 < 0xE0)             // 2 byte character
      {
        utf16 = 64 * (byte1 - 0xC0) + byte2;
      } else {
        let byte3 = input[pos++] - 128;
        if (byte3 < 0) {
          throw new Error(`AMQJS0009E Malformed UTF data:${byte1.toString(16)} ${byte2.toString(16)} ${byte3.toString(16)}.`)
        }
        if (byte1 < 0xF0)        // 3 byte character
        {
          utf16 = 4096 * (byte1 - 0xE0) + 64 * byte2 + byte3;
        } else {
          let byte4 = input[pos++] - 128;
          if (byte4 < 0) {
            throw new Error(`AMQJS0009E Malformed UTF data:${byte1.toString(16)} ${byte2.toString(16)} ${byte3.toString(16)} ${byte4.toString(16)}.`)
          }
          if (byte1 < 0xF8)        // 4 byte character
          {
            utf16 = 262144 * (byte1 - 0xF0) + 4096 * byte2 + 64 * byte3 + byte4;
          } else                     // longer encodings are not supported
          {
            throw new Error(`AMQJS0009E Malformed UTF data:${byte1.toString(16)} ${byte2.toString(16)} ${byte3.toString(16)} ${byte4.toString(16)}.`)
          }
        }
      }
    }

    if (utf16 > 0xFFFF)   // 4 byte character - express as a surrogate pair
    {
      utf16 -= 0x10000;
      output += String.fromCharCode(0xD800 + (utf16 >> 10)); // lead character
      utf16 = 0xDC00 + (utf16 & 0x3FF);  // trail character
    }
    output += String.fromCharCode(utf16);
  }
  return output;
}


class UTF8Decoder {
  decode(bytes: Uint8Array): string {
    return parseUTF8(bytes, bytes.byteOffset, bytes.byteLength)
  }
}

export default UTF8Decoder