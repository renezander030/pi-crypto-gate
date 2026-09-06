// Approval grants. A grant authorises exactly one action, once, for a bounded
// window, and carries a signature the gate can check without the signing key.
//
// The grant store and the approver key live outside the agent's working root,
// so an agent can request an approval but cannot mint one.
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { canonicalJson } from "./canonical.js";
import { signMessage, verifyMessage } from "./signing.js";

/** Where grants and the approver key live. */
export function approvalDir() {
  return process.env.PI_CRYPTO_GATE_APPROVAL_DIR || join(homedir(), ".pi-crypto-gate", "approvals");
}

/** Approver private key path. */
export function approverKeyPath() {
  return process.env.PI_CRYPTO_GATE_APPROVER_KEY || join(approvalDir(), "approver.key");
}

function grantPath(actionHash, dir = approvalDir()) {
  return join(dir, `${actionHash}.grant.json`);
}

function consumedPath(actionHash, dir = approvalDir()) {
  return join(dir, `${actionHash}.consumed`);
}

/**
 * Canonical absolute form of a path: symlinks resolved over the longest
 * existing prefix, the rest appended as written. Two spellings of one place
 * compare equal, so an alias (macOS `/var` -> `/private/var`, a symlinked
 * directory) cannot slip an approval store past the boundary check.
 */
export function canonicalPath(path) {
  const abs = resolve(path);
  const tail = [];
  let head = abs;
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

/** True when `child` sits inside `parent`, comparing canonical paths. */
export function isInside(parent, child) {
  const p = canonicalPath(parent);
  const c = canonicalPath(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Mint a signed grant for one action. `privateKey` is the approver key; without
 * it the grant is unsigned and a policy carrying `approverPublicKey` rejects it.
 */
export function issueGrant(
  { actionHash, decisionId = null, policyVersion = null, ttlSeconds = 900, approver = "human", privateKey = null },
  { dir = approvalDir(), now = new Date() } = {},
) {
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const payload = { actionHash, decisionId, policyVersion, issuedAt, expiresAt, approver };
  const grant = {
    ...payload,
    signature: privateKey ? signMessage(canonicalJson(payload), privateKey) : null,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(grantPath(actionHash, dir), JSON.stringify(grant, null, 2) + "\n", { mode: 0o600 });
  return grant;
}

/** Read a grant. Returns null when absent or unparseable. */
export function readGrant(actionHash, { dir = approvalDir() } = {}) {
  const path = grantPath(actionHash, dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** True once a grant has been spent. */
export function isConsumed(actionHash, { dir = approvalDir() } = {}) {
  return existsSync(consumedPath(actionHash, dir));
}

/**
 * Check a grant against an action. Returns `{ valid, reason }`; `reason` is a
 * stable machine-readable code.
 */
export function verifyGrant(grant, { actionHash, approverPublicKey = null, now = new Date() } = {}) {
  if (!grant) return { valid: false, reason: "grant_missing" };
  if (grant.actionHash !== actionHash) return { valid: false, reason: "grant_action_mismatch" };
  if (!grant.expiresAt || Date.parse(grant.expiresAt) <= now.getTime()) {
    return { valid: false, reason: "grant_expired" };
  }
  if (approverPublicKey) {
    const { signature, ...payload } = grant;
    if (!signature) return { valid: false, reason: "grant_unsigned" };
    if (!verifyMessage(canonicalJson(payload), signature, approverPublicKey)) {
      return { valid: false, reason: "grant_bad_signature" };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Spend a grant. The marker is created with O_EXCL, so of two concurrent
 * callers exactly one succeeds. A spent grant stays spent whatever happens
 * next — a failed broadcast needs a fresh approval, never a retry of this one.
 */
export function consumeGrant(actionHash, { dir = approvalDir(), now = new Date() } = {}) {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(
      consumedPath(actionHash, dir),
      JSON.stringify({ actionHash, consumedAt: now.toISOString() }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return { ok: true, reason: null };
  } catch (err) {
    if (err && err.code === "EEXIST") return { ok: false, reason: "grant_already_consumed" };
    throw err;
  }
}

/**
 * Full check-and-spend used before execution: verify, then consume atomically.
 */
export function claimGrant({ actionHash, approverPublicKey = null, dir = approvalDir(), now = new Date() } = {}) {
  const grant = readGrant(actionHash, { dir });
  const verdict = verifyGrant(grant, { actionHash, approverPublicKey, now });
  if (!verdict.valid) return { ok: false, reason: verdict.reason, grant };
  const consumed = consumeGrant(actionHash, { dir, now });
  if (!consumed.ok) return { ok: false, reason: consumed.reason, grant };
  return { ok: true, reason: null, grant };
}

/** List grants in the store, newest first. */
export function listGrants({ dir = approvalDir() } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".grant.json"))
    .map((f) => {
      const actionHash = f.replace(/\.grant\.json$/, "");
      return { ...readGrant(actionHash, { dir }), consumed: isConsumed(actionHash, { dir }) };
    })
    .filter((g) => g && g.actionHash)
    .sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
}
