import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function postDistance(payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/distance',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

describe('API — happy path', () => {
  it('GET /api/health responds ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns the exact distance when within k', async () => {
    const res = await postDistance({ a: [1, 2, 3], b: [1, 3, 4], k: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      distance: 2,
      k: 5,
      lengths: { a: 3, b: 3 },
    });
  });

  it('returns only the exceeded signal when beyond k', async () => {
    const res = await postDistance({ a: [1, 2, 3], b: [4, 5, 6], k: 5 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('exceeded');
    expect(body).not.toHaveProperty('distance');
    expect(body).toEqual({ status: 'exceeded', k: 5, lengths: { a: 3, b: 3 } });
  });

  it('handles empty arrays and int32 extremes', async () => {
    const res = await postDistance({
      a: [],
      b: [-2147483648, 2147483647],
      k: 2,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', distance: 2 });
  });
});

describe('API — stable validation errors', () => {
  it('malformed JSON -> 400 INVALID_JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/distance',
      headers: { 'content-type': 'application/json' },
      payload: '{"a": [1, 2],',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
  });

  it('non-object body -> 400 INVALID_BODY', async () => {
    const res = await postDistance([1, 2, 3]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });

  it('missing field -> 400 with stable code', async () => {
    const res = await postDistance({ a: [1], b: [1] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_K');
  });

  it.each([
    [{ a: [1.5], b: [], k: 0 }, 'non-integer element'],
    [{ a: ['1'], b: [], k: 0 }, 'string element'],
    [{ a: [null], b: [], k: 0 }, 'null element'],
    [{ a: [true], b: [], k: 0 }, 'boolean element'],
    [{ a: [2147483648], b: [], k: 0 }, 'element above int32 max'],
    [{ a: [-2147483649], b: [], k: 0 }, 'element below int32 min'],
  ])('invalid element %o -> 400 INVALID_ELEMENT', async (payload, _label) => {
    const res = await postDistance(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ELEMENT');
  });

  it.each([
    [{ a: [], b: [], k: 501 }, 'k above max'],
    [{ a: [], b: [], k: -1 }, 'negative k'],
    [{ a: [], b: [], k: 1.5 }, 'non-integer k'],
    [{ a: [], b: [], k: '3' }, 'string k'],
  ])('invalid k %o -> 400 INVALID_K', async (payload, _label) => {
    const res = await postDistance(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_K');
  });

  it('array longer than 50_000 -> 400 ARRAY_TOO_LONG', async () => {
    const res = await postDistance({
      a: new Array(50_001).fill(0),
      b: [],
      k: 0,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ARRAY_TOO_LONG');
  });

  it('accepts exactly 50_000 elements', async () => {
    const res = await postDistance({
      a: new Array(50_000).fill(9),
      b: new Array(50_000).fill(9),
      k: 0,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', distance: 0 });
  });
});
