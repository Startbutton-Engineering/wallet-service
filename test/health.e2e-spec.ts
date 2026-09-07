import { createTestApp, TestApp } from "./utils/app"
import request from 'supertest';

describe('Health', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close()
  })

  it('reports ok and confirms the app is connected to a database replica set', async() => {
    const res = await request(ctx.app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database.connected).toBe(true);
     expect(res.body.database.replicaSet).toBe(true)
  })

  it('allows the health endpoint without an API key (public route)', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  })
})