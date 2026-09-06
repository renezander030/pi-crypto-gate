// The sealed policy, cryptographic core.
//
// Scheme: BFV (Microsoft SEAL via node-seal), a homomorphic encryption scheme
// that lets a party add and subtract sealed numbers, and multiply them by
// numbers it knows, without the key. That is all the gate's numeric checks
// need:
//
//   cap - amount              within the per-transaction cap when >= 0
//   daily - (spent + amount)  within the daily cap when >= 0
//   amount - threshold        held for a human when >= 0
//
// The agent host (the evaluator) computes those three sealed differences and
// the sealed running total. It holds no key: it cannot read the cap, the daily
// cap, the threshold or the total. Before a difference leaves the host it is
// multiplied by a random factor, so the key box that opens it learns the sign,
// which is the verdict, and nothing about the size.
//
// Numbers: values live below 2^36 base units (68,719 USDC with 6 decimals) and
// the blinding factor below 2^12, so a blinded difference stays below 2^48 in
// absolute value, well inside the 50-bit plaintext modulus where the sign is
// unambiguous.
//
// What this does not do: it cannot stop a fully compromised host from lying
// about a verdict. Homomorphic encryption gives confidentiality of the rules,
// not integrity of the computation; that is what the zk path and a signed
// verdict are for.
import { randomInt } from "node:crypto";
import { loadSeal } from "./deps.js";

export const POLY_MODULUS_DEGREE = 8192;
export const PLAIN_MODULUS_BITS = 50;
export const VALUE_BITS = 36;
export const MAX_VALUE = (1n << BigInt(VALUE_BITS)) - 1n;
export const BLIND_BITS = 12;

function compr(seal) {
  const c = seal.ComprModeType;
  return c.zstd ?? c.zlib ?? c.none;
}

/** Fresh encryption parameters, serialized. Every key and ciphertext refers to them. */
export async function makeParams() {
  const seal = await loadSeal();
  const parms = new seal.EncryptionParameters(seal.SchemeType.bfv);
  parms.setPolyModulusDegree(POLY_MODULUS_DEGREE);
  parms.setCoeffModulus(seal.CoeffModulus.BFVDefault(POLY_MODULUS_DEGREE, seal.SecLevelType.tc128));
  parms.setPlainModulus(seal.PlainModulus.Batching(POLY_MODULUS_DEGREE, PLAIN_MODULUS_BITS));
  return parms.saveToBase64(compr(seal));
}

async function contextFrom(paramsB64) {
  const seal = await loadSeal();
  const parms = new seal.EncryptionParameters(seal.SchemeType.bfv);
  parms.loadFromBase64(paramsB64);
  const context = new seal.SEALContext(parms, true, seal.SecLevelType.tc128);
  if (!context.parametersSet()) throw new Error("sealed policy: the encryption parameters are not valid");
  return { seal, parms, context, encoder: new seal.BatchEncoder(context) };
}

export function checkValue(v, label = "value") {
  const n = BigInt(v);
  if (n < 0n || n > MAX_VALUE) throw new RangeError(`${label} must be between 0 and ${MAX_VALUE} base units (2^${VALUE_BITS} - 1)`);
  return n;
}

function encodeScalar(ctx, v) {
  const arr = new BigInt64Array(ctx.encoder.slotCount());
  arr[0] = BigInt(v);
  const pt = new ctx.seal.Plaintext();
  ctx.encoder.encode(arr, pt);
  return pt;
}

function decodeScalar(ctx, pt) {
  return BigInt(ctx.encoder.decodeBigInt64(pt)[0]);
}

function loadCipher(ctx, b64) {
  const ct = new ctx.seal.Ciphertext();
  ct.loadFromBase64(ctx.context, b64);
  return ct;
}

/** The owner's key material: parameters, secret key, public key, all serialized. */
export async function generateKeys() {
  const params = await makeParams();
  const ctx = await contextFrom(params);
  const kg = new ctx.seal.KeyGenerator(ctx.context);
  return {
    params,
    secretKey: kg.secretKey().saveToBase64(compr(ctx.seal)),
    publicKey: kg.createPublicKey().saveToBase64(compr(ctx.seal)),
  };
}

/** Owner side: can seal numbers and open them. */
export async function ownerSession({ params, secretKey, publicKey }) {
  const ctx = await contextFrom(params);
  const sk = new ctx.seal.SecretKey();
  sk.loadFromBase64(ctx.context, secretKey);
  const pk = new ctx.seal.PublicKey();
  pk.loadFromBase64(ctx.context, publicKey);
  return {
    ...ctx,
    encryptor: new ctx.seal.Encryptor(ctx.context, pk),
    decryptor: new ctx.seal.Decryptor(ctx.context, sk),
  };
}

/** Evaluator side: parameters only, no key. Can compute, cannot read. */
export async function evaluatorSession({ params }) {
  const ctx = await contextFrom(params);
  return { ...ctx, evaluator: new ctx.seal.Evaluator(ctx.context) };
}

export function sealValue(session, v, label = "value") {
  const n = checkValue(v, label);
  const ct = new session.seal.Ciphertext();
  session.encryptor.encrypt(encodeScalar(session, n), ct);
  return ct.saveToBase64(compr(session.seal));
}

export function openValue(session, b64) {
  const ct = loadCipher(session, b64);
  const pt = new session.seal.Plaintext();
  session.decryptor.decrypt(ct, pt);
  return decodeScalar(session, pt);
}

/** Bits of noise budget left in a ciphertext; below 0 it no longer decrypts. */
export function noiseBudget(session, b64) {
  return session.decryptor.invariantNoiseBudget(loadCipher(session, b64));
}

export function randomBlind() {
  return 1n + BigInt(randomInt(1 << BLIND_BITS));
}

/**
 * The evaluator's step. `sealed` holds base64 ciphertexts of cap, daily,
 * threshold and spent; `amount` is the clear proposal amount in base units.
 * Returns three blinded sealed differences plus the sealed next total.
 */
export function evaluateSealed(session, sealed, amount, { blind = randomBlind } = {}) {
  const a = encodeScalar(session, checkValue(amount, "amount"));
  const cap = loadCipher(session, sealed.cap);
  const daily = loadCipher(session, sealed.daily);
  const threshold = loadCipher(session, sealed.threshold);
  const spent = loadCipher(session, sealed.spent);
  const ev = session.evaluator;
  const fresh = () => new session.seal.Ciphertext();

  const dCap = fresh();
  ev.subPlain(cap, a, dCap); // cap - amount
  const spentNext = fresh();
  ev.addPlain(spent, a, spentNext); // spent + amount, stays sealed
  const dDay = fresh();
  ev.sub(daily, spentNext, dDay); // daily - (spent + amount)
  const negThreshold = fresh();
  ev.negate(threshold, negThreshold);
  const dHold = fresh();
  ev.addPlain(negThreshold, a, dHold); // amount - threshold

  const blinded = (ct) => {
    const r = BigInt(blind());
    if (r < 1n || r > 1n << BigInt(BLIND_BITS)) throw new RangeError("blinding factor out of range");
    const out = fresh();
    ev.multiplyPlain(ct, encodeScalar(session, r), out);
    return out.saveToBase64(compr(session.seal));
  };
  return {
    dCap: blinded(dCap),
    dDay: blinded(dDay),
    dHold: blinded(dHold),
    spentNext: spentNext.saveToBase64(compr(session.seal)),
  };
}

/** The key box's step: three signs, nothing else. */
export function openVerdict(session, { dCap, dDay, dHold }) {
  const sign = (b64) => openValue(session, b64) >= 0n;
  return { withinCap: sign(dCap), withinDay: sign(dDay), hold: sign(dHold) };
}

/** Same decision names and reason codes as the clear gate. */
export function decide({ withinCap, withinDay, hold }) {
  const reasons = [];
  if (!withinCap) reasons.push("per-tx-cap-exceeded");
  if (!withinDay) reasons.push("daily-cap-exceeded");
  if (reasons.length) return { decision: "block", reasons };
  if (hold) return { decision: "needs_approval", reasons: ["approval-required-over-threshold"] };
  return { decision: "allow", reasons: [] };
}
