import crypto from 'node:crypto'

// v3.1 follow-up 9 (ADR-016): protects sensitive ShopSettings fields
// (currently just the Gmail app password) at rest in Postgres. This app has
// no other secret-management/KMS infrastructure, so this is the minimum
// viable "not plaintext in the database" bar, not a full secrets-manager
// replacement — see ADR-016 for the threat model and its limits (single
// static key, no rotation support). SETTINGS_ENCRYPTION_KEY itself lives
// only in env vars, same as every other credential in this app.
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH_BYTES = 12
const ENCRYPTED_PARTS_COUNT = 3

function getKey(): Buffer {
  const { env } = process
  const { SETTINGS_ENCRYPTION_KEY: raw } = env
  if (raw === undefined || raw === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY is not set — cannot encrypt/decrypt stored credentials')
  }
  // SHA-256 gives a stable 32-byte AES-256 key regardless of the raw env
  // var's length. Deliberately not scrypt/PBKDF2: those exist to slow down
  // brute-forcing a low-entropy *human* password, but the input here is
  // already expected to be a long random secret, not something guessable —
  // stretching it further buys nothing.
  return crypto.createHash('sha256').update(raw).digest()
}

export function isEncryptionConfigured(): boolean {
  const { env } = process
  const { SETTINGS_ENCRYPTION_KEY: raw } = env
  return raw !== undefined && raw !== ''
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES)
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(':')
  if (parts.length !== ENCRYPTED_PARTS_COUNT) {
    throw new Error('Malformed encrypted value')
  }
  const [ivB64, tagB64, ciphertextB64] = parts
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()])
  return plaintext.toString('utf8')
}
