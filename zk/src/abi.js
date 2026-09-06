// Minimal ABI encoding for the ERC-8366 envelope, with no dependencies.
//
//   signature      = abi.encode(bytes proof, bytes authorization)
//   proof          = abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c)      // Groth16
//   authorization  = abi.encode(address to, uint256 value, uint256 validAfter,
//                               uint256 validBefore, bytes32 nonce)
//
// Every shape is fixed, so this is a few dozen lines rather than an ABI
// library. The decoders let `zk verify` read an envelope back and let the
// tests round-trip it. Reference vectors in zk/test/abi.test.js were produced
// with `cast abi-encode`.
const MAX_UINT256 = (1n << 256n) - 1n;

export function isHexAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function isHexBytes32(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}

export function toUint256(v, label = "value") {
  let n;
  try {
    n = BigInt(v);
  } catch {
    throw new TypeError(`${label}: not an integer: ${v}`);
  }
  if (n < 0n || n > MAX_UINT256) throw new RangeError(`${label}: outside uint256: ${v}`);
  return n;
}

/** One 32-byte big-endian word. */
export function word(v, label) {
  return Buffer.from(toUint256(v, label).toString(16).padStart(64, "0"), "hex");
}

export function addressWord(addr) {
  if (!isHexAddress(addr)) throw new TypeError(`not an address: ${addr}`);
  return word(BigInt(addr), "address");
}

export function bytes32Word(hex) {
  if (!isHexBytes32(hex)) throw new TypeError(`not bytes32: ${hex}`);
  return Buffer.from(hex.slice(2), "hex");
}

export function toHex(buf) {
  return "0x" + Buffer.from(buf).toString("hex");
}

export function fromHex(hex) {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new TypeError(`not hex bytes: ${hex}`);
  return Buffer.from(hex.slice(2), "hex");
}

/** abi.encode(uint256[2] a, uint256[2][2] b, uint256[2] c): eight static words. */
export function encodeProof({ a, b, c } = {}) {
  const flat = [a?.[0], a?.[1], b?.[0]?.[0], b?.[0]?.[1], b?.[1]?.[0], b?.[1]?.[1], c?.[0], c?.[1]];
  if (flat.some((x) => x === undefined)) throw new TypeError("proof needs a[2], b[2][2], c[2]");
  return Buffer.concat(flat.map((x, i) => word(x, `proof[${i}]`)));
}

export function decodeProof(buf) {
  const b = Buffer.from(buf);
  if (b.length !== 256) throw new TypeError(`proof: expected 256 bytes, got ${b.length}`);
  const w = (i) => "0x" + b.subarray(i * 32, i * 32 + 32).toString("hex");
  return { a: [w(0), w(1)], b: [[w(2), w(3)], [w(4), w(5)]], c: [w(6), w(7)] };
}

/** abi.encode(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce). */
export function encodeAuthorization({ to, value, validAfter, validBefore, nonce }) {
  return Buffer.concat([
    addressWord(to),
    word(value, "value"),
    word(validAfter, "validAfter"),
    word(validBefore, "validBefore"),
    bytes32Word(nonce),
  ]);
}

export function decodeAuthorization(buf) {
  const b = Buffer.from(buf);
  if (b.length !== 160) throw new TypeError(`authorization: expected 160 bytes, got ${b.length}`);
  const u = (i) => BigInt("0x" + b.subarray(i * 32, i * 32 + 32).toString("hex"));
  const toWord = b.subarray(0, 32);
  if (!toWord.subarray(0, 12).equals(Buffer.alloc(12))) throw new TypeError("authorization: address word has high bytes set");
  return {
    to: "0x" + toWord.subarray(12).toString("hex"),
    value: u(1),
    validAfter: u(2),
    validBefore: u(3),
    nonce: "0x" + b.subarray(128, 160).toString("hex"),
  };
}

function padded(buf) {
  const rem = buf.length % 32;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(32 - rem)]);
}

/** abi.encode(bytes x, bytes y): two offsets, then each length-prefixed, padded tail. */
export function encodeBytesPair(x, y) {
  const xb = Buffer.from(x);
  const yb = Buffer.from(y);
  const xTail = Buffer.concat([word(xb.length), padded(xb)]);
  const yTail = Buffer.concat([word(yb.length), padded(yb)]);
  return Buffer.concat([word(64), word(64 + xTail.length), xTail, yTail]);
}

export function decodeBytesPair(buf) {
  const b = Buffer.from(buf);
  if (b.length < 64) throw new TypeError("bytes pair: too short");
  const u = (off) => {
    if (off + 32 > b.length) throw new TypeError("bytes pair: truncated");
    return Number(BigInt("0x" + b.subarray(off, off + 32).toString("hex")));
  };
  const offX = u(0);
  const offY = u(32);
  const lenX = u(offX);
  const lenY = u(offY);
  if (offX + 32 + lenX > b.length || offY + 32 + lenY > b.length) throw new TypeError("bytes pair: truncated");
  return [b.subarray(offX + 32, offX + 32 + lenX), b.subarray(offY + 32, offY + 32 + lenY)];
}
