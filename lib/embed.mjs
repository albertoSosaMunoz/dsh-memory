/**
 * Deterministic, dependency-free text embedding.
 *
 * The goal is NOT to imitate a neural embedding model. It is a compact
 * feature-hashed representation (word unigrams, bigrams and character
 * 4-grams, sublinear term frequency, signed hashing, L2 normalisation) that
 * lives in MongoDB as a real float32 vector and supports cosine ranking.
 *
 * Properties that matter here:
 *  - no network, no model download, no API key, no provider lock-in;
 *  - deterministic across processes and machines (same text -> same vector);
 *  - tolerant to Spanish accents and inflection through char n-grams;
 *  - works for code identifiers because `-`, `_` and `.` split tokens.
 *
 * Semantic generalisation is limited; lexical recall carries most of the
 * weight. An optional OpenAI-compatible embedding endpoint can be configured
 * to replace these vectors without touching the rest of the plugin.
 */

const DIM = 1024;
const MAX_TOKENS = 4000;

const STOPWORDS = new Set([
  // Spanish
  'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por',
  'un', 'para', 'con', 'no', 'una', 'su', 'al', 'lo', 'como', 'mas', 'pero',
  'sus', 'le', 'ya', 'o', 'este', 'si', 'porque', 'esta', 'entre', 'cuando',
  'muy', 'sin', 'sobre', 'tambien', 'me', 'hasta', 'hay', 'donde', 'quien',
  'desde', 'todo', 'nos', 'durante', 'todos', 'uno', 'les', 'ni', 'contra',
  'otros', 'ese', 'eso', 'ante', 'ellos', 'e', 'esto', 'mi', 'antes', 'algunos',
  'que', 'unos', 'yo', 'otro', 'otras', 'otra', 'el', 'tanto', 'esa', 'estos',
  'mucho', 'quienes', 'nada', 'muchos', 'cual', 'poco', 'ella', 'estar',
  'estas', 'algunas', 'algo', 'nosotros', 'mi', 'mis', 'tu', 'te', 'ti', 'tus',
  'ellas', 'nosotras', 'vosotros', 'os', 'mio', 'mia', 'mios', 'mias', 'tuyo',
  'tuya', 'suyo', 'suya', 'nuestro', 'nuestra', 'nuestros', 'nuestras',
  'esos', 'esas', 'estoy', 'estas', 'esta', 'estamos', 'estais', 'estan',
  'ser', 'es', 'son', 'era', 'eran', 'fue', 'fueron', 'sea', 'sean', 'he',
  'has', 'ha', 'hemos', 'han', 'habia', 'habian', 'tiene', 'tienen', 'tenia',
  'puede', 'pueden', 'puedo', 'hacer', 'hace', 'hacen', 'asi', 'aqui', 'alli',
  'ahora', 'entonces', 'luego', 'despues', 'bien', 'mal', 'cada', 'otro',
  'mismo', 'misma', 'solo', 'tan', 'ser', 'esta', 'estaba', 'estaban',
  // English
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were',
  'be', 'been', 'for', 'on', 'with', 'that', 'this', 'it', 'as', 'at', 'by',
  'from', 'we', 'you', 'they', 'he', 'she', 'not', 'no', 'do', 'does', 'did',
  'have', 'has', 'had', 'can', 'will', 'would', 'should', 'could', 'i', 'my',
  'your', 'our', 'their', 'if', 'then', 'than', 'so', 'but', 'about', 'into',
  'over', 'under', 'up', 'down', 'out', 'just', 'also', 'there', 'here',
])

/** FNV-1a 32-bit. */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Lowercase, strip diacritics, keep token boundaries for identifiers. */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Tokenise normalised text. `_`, `-`, `.` and `/` are boundaries. */
export function tokenize(text) {
  const tokens = normalizeText(text).match(/[a-z0-9_]{2,}/g) ?? []
  return tokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token))
}

/** Character 4-grams of one token, only when long enough to be useful. */
function charGrams(token) {
  if (token.length < 6) return []
  const grams = []
  for (let i = 0; i + 4 <= token.length; i += 1) grams.push(token.slice(i, i + 4))
  return grams
}

/**
 * Build a signed feature-hashed vector for one text.
 *
 * @param {string} text - any user/assistant/code text.
 * @param {{ dim?: number }} [options]
 * @returns {Float32Array} L2-normalised vector of `dim` dimensions.
 */
export function embed(text, options = {}) {
  const dim = options.dim ?? DIM
  const vector = new Float32Array(dim)
  const tokens = tokenize(text).slice(0, MAX_TOKENS)
  if (tokens.length === 0) return vector

  /** @type {Map<string, number>} */
  const features = new Map()
  const add = (feature, weight) => {
    features.set(feature, (features.get(feature) ?? 0) + weight)
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    add(`w:${token}`, 1)
    if (i + 1 < tokens.length) add(`b:${token}_${tokens[i + 1]}`, 0.6)
    for (const gram of charGrams(token)) add(`c:${gram}`, 0.25)
  }

  for (const [feature, frequency] of features) {
    const hash = fnv1a(feature)
    const index = hash % dim
    const sign = (hash & 0x80000000) === 0 ? 1 : -1
    vector[index] += sign * (1 + Math.log1p(frequency))
  }

  let norm = 0
  for (let i = 0; i < dim; i += 1) norm += vector[i] * vector[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) vector[i] /= norm
  }
  return vector
}

/** Cosine similarity of two L2-normalised vectors (plain dot product). */
export function cosine(a, b) {
  if (!a || !b) return 0
  const length = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i]
  return dot
}

/** Serialise a vector for BSON storage as float32 binary. */
export function vectorToBuffer(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4)
  for (let i = 0; i < vector.length; i += 1) buffer.writeFloatLE(vector[i], i * 4)
  return buffer
}

/** Deserialise a stored vector (number array, Buffer or BSON Binary). */
export function bufferToVector(value) {
  if (!value) return null
  if (Array.isArray(value)) return Float32Array.from(value)
  const buffer = Buffer.isBuffer(value) ? value : value.buffer ?? value.value?.()
  if (!buffer || !Buffer.isBuffer(buffer)) return null
  const copy = Buffer.from(buffer)
  const vector = new Float32Array(copy.length / 4)
  for (let i = 0; i < vector.length; i += 1) vector[i] = copy.readFloatLE(i * 4)
  return vector
}

export const EMBEDDING_DIM = DIM
