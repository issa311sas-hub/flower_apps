/**
 * 暗号まわり（Web Crypto のみを使う。外部ライブラリなし）
 *
 * - Beds24 のトークンを D1 に保存する際の暗号化（AES-GCM）
 * - ログインパスワードのハッシュ化（PBKDF2-SHA256）
 *
 * Beds24 のトークンを Cloudflare の Secret に置けないのは、
 * トークンが使うたびにローテーションされる一方、Secret は実行中に書き換えられないため。
 * そのため「暗号鍵だけを Secret に置き、トークン本体は暗号化して D1 に置く」構成にしている。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ------------------------------------------------------------------
// base64（Workers に Buffer はないので自前で用意する）
// ------------------------------------------------------------------
export function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** URLに載せられる乱数トークン（セッションIDなどに使う） */
export function randomToken(bytes = 32) {
  return toBase64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ------------------------------------------------------------------
// AES-GCM（Beds24 トークンの保管用）
// ------------------------------------------------------------------
async function importAesKey(base64Key) {
  if (!base64Key) {
    throw new Error('TOKEN_ENC_KEY が設定されていません。Cloudflare の Settings → Variables and Secrets で登録してください。');
  }
  const raw = fromBase64(base64Key);
  if (raw.length !== 32) {
    throw new Error(`TOKEN_ENC_KEY は32バイト（base64）である必要があります。現在 ${raw.length} バイトです。`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 文字列を暗号化して 'base64(iv):base64(暗号文)' の形で返す */
export async function encryptSecret(plainText, base64Key) {
  const key = await importAesKey(base64Key);
  const iv = randomBytes(12);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plainText));
  return `${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

/** encryptSecret で作った文字列を復号する */
export async function decryptSecret(stored, base64Key) {
  if (!stored) return null;
  const [ivPart, dataPart] = String(stored).split(':');
  if (!ivPart || !dataPart) throw new Error('暗号化されたデータの形式が正しくありません。');

  const key = await importAesKey(base64Key);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(ivPart) },
    key,
    fromBase64(dataPart)
  );
  return decoder.decode(plain);
}

// ------------------------------------------------------------------
// PBKDF2（ログインパスワード用。M4の認証で使う）
// ------------------------------------------------------------------
export const DEFAULT_PBKDF2_ITERATIONS = 100000;

/**
 * パスワードをハッシュ化する。
 * Workers では bcrypt / argon2 が使えない（WASMなしでは動かない）ため PBKDF2-SHA256 を使う。
 * 反復回数は利用者ごとにDBへ保存し、後から引き上げられるようにしている。
 */
export async function hashPassword(password, { salt, iterations = DEFAULT_PBKDF2_ITERATIONS } = {}) {
  const saltBytes = salt ? fromBase64(salt) : randomBytes(16);
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return {
    salt: toBase64(saltBytes),
    hash: toBase64(new Uint8Array(bits)),
    iterations
  };
}

/** 保存済みのハッシュと突き合わせる（比較時間を一定に保つ） */
export async function verifyPassword(password, stored) {
  const candidate = await hashPassword(password, { salt: stored.salt, iterations: stored.iterations });
  return timingSafeEqual(candidate.hash, stored.hash);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** セッショントークンの保存用ハッシュ（生のトークンはDBに置かない） */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
