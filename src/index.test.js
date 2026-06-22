const request = require('supertest');
const app = require('./index');

test('GET /health returns ok', async () => {
  const res = await request(app).get('/health');
  expect(res.statusCode).toBe(200);
  expect(res.body.status).toBe('ok');
});

test('GET /items returns array', async () => {
  const res = await request(app).get('/items');
  expect(res.statusCode).toBe(200);
  expect(Array.isArray(res.body)).toBe(true);
});

test('POST /items adds item', async () => {
  const res = await request(app).post('/items').send({ name: 'test' });
  expect(res.statusCode).toBe(201);
  expect(res.body.name).toBe('test');
});
