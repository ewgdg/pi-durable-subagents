import { crc32, deflateSync } from "node:zlib";

import type { ImageContent } from "@earendil-works/pi-ai";

// Pi's default inline limit is 2000px per side, so this image is always resized
// and Pi appends a dimension hint to the persisted user text.
const OVERSIZED_IMAGE_WIDTH = 2400;

/** A valid grayscale PNG wider than Pi's inline image limit. */
export function oversizedPngImage(): ImageContent {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(OVERSIZED_IMAGE_WIDTH, 0);
	header.writeUInt32BE(1, 4);
	header.writeUInt8(8, 8); // bit depth
	header.writeUInt8(0, 9); // grayscale
	const scanline = Buffer.alloc(1 + OVERSIZED_IMAGE_WIDTH, 0x80);
	scanline[0] = 0; // no filter
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanline)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, checksum]);
}
