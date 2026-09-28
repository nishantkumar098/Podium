import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { bootstrapTestApp } from "./support";

/**
 * The probe local setup (and any future container platform) uses to answer
 * "is the API actually up?". Reachable without credentials by design — a
 * probe that needs a login cannot be used by the things that probe.
 */
describe("Health check (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });

  afterAll(async () => await app.close());

  it("answers without authentication and reports the database as reachable", async () => {
    const res = await request(app.getHttpServer()).get("/api/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.database).toBe("up");
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });

  it("is not behind the auth guard (a bad token doesn't change the answer)", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/health")
      .set("Authorization", "Bearer definitely-not-a-valid-token")
      .expect(200);
    expect(res.body.status).toBe("ok");
  });
});
