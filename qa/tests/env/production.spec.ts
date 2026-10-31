import { test, expect } from '../../fixtures/test.js';
test('ENV-006 生产页面和深链接返回 HTML，API 404 保持 JSON', async ({ api }) => {
  for (const path of ['/', '/login', '/c/unknown', '/plans']) {
    const response = await api.request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    expect(await response.text()).toMatch(/<html/i);
  }
  await api.login();
  const response = await api.request.get('/api/qa-not-a-route');
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  expect((await response.json()).error.code).toBe('NOT_FOUND');
});
