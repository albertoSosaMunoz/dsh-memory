/**
 * Pure unit tests: no MongoDB, no plugin activation.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bufferToVector,
  cosine,
  embed,
  normalizeText,
  tokenize,
  vectorToBuffer,
  EMBEDDING_DIM,
} from '../lib/embed.mjs'
import { clip, messageText, textHash } from '../lib/store.mjs'

test('embed is deterministic and dimension-stable', () => {
  const a = embed('el plugin guarda recuerdos en mongodb')
  const b = embed('el plugin guarda recuerdos en mongodb')
  assert.equal(a.length, EMBEDDING_DIM)
  assert.deepEqual(Array.from(a), Array.from(b))
})

test('embed honours a custom dim', () => {
  assert.equal(embed('texto cualquiera', { dim: 64 }).length, 64)
})

test('embed is L2-normalised and self-cosine is 1', () => {
  const vector = embed('despliegue con docker compose y credenciales')
  let norm = 0
  for (const value of vector) norm += value * value
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5, `norm was ${Math.sqrt(norm)}`)
  assert.ok(Math.abs(cosine(vector, vector) - 1) < 1e-5)
})

test('embed separates unrelated texts', () => {
  const a = embed('columnas y orden de la tabla de pedidos')
  const b = embed('certificado ssl del proxy inverso')
  assert.ok(cosine(a, b) < 0.9, 'unrelated texts should not be near-identical')
})

test('empty text yields a zero vector, not NaN', () => {
  const vector = embed('')
  assert.equal(vector.length, EMBEDDING_DIM)
  assert.ok(Array.from(vector).every((value) => value === 0))
  assert.equal(cosine(vector, embed('algo')), 0)
})

test('normalizeText strips accents and case', () => {
  assert.equal(normalizeText('Configuración ÁRBOL'), 'configuracion arbol')
})

test('tokenize drops stopwords and normalises', () => {
  const tokens = tokenize('Los pedidos de la tienda están en MongoDB')
  assert.ok(tokens.includes('pedidos'))
  assert.ok(tokens.includes('tienda'))
  assert.ok(tokens.includes('mongodb'))
  assert.ok(!tokens.includes('los'))
  assert.ok(!tokens.includes('de'))
})

test('vectorToBuffer/bufferToVector round-trip float32', () => {
  const vector = embed('ida y vuelta del vector')
  const restored = bufferToVector(vectorToBuffer(vector))
  assert.ok(restored)
  assert.equal(restored.length, vector.length)
  assert.ok(Math.abs(cosine(vector, restored) - 1) < 1e-5)
})

test('bufferToVector accepts a plain array and rejects junk', () => {
  assert.equal(bufferToVector([1, 0, 0]).length, 3)
  assert.equal(bufferToVector(null), null)
  assert.equal(bufferToVector({}), null)
})

test('clip truncates with an ellipsis and leaves short text alone', () => {
  assert.equal(clip('corto', 20), 'corto')
  const clipped = clip('x'.repeat(50), 10)
  assert.equal(clipped.length, 10)
  assert.ok(clipped.endsWith('…'))
})

test('textHash ignores case, accents and whitespace runs', () => {
  const a = textHash('Configuración   del  Plugin')
  const b = textHash('configuracion del plugin')
  assert.equal(a, b)
  assert.notEqual(a, textHash('otra cosa'))
})

test('messageText keeps text blocks only', () => {
  const message = {
    content: [
      { type: 'text', text: 'primera' },
      { type: 'image', attachment: { id: 'x' } },
      { type: 'text', text: 'segunda' },
    ],
  }
  assert.equal(messageText(message), 'primera\nsegunda')
  assert.equal(messageText({ content: [{ type: 'image' }] }), '')
  assert.equal(messageText(null), '')
  assert.equal(messageText({}), '')
})
