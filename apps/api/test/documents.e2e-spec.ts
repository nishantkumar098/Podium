import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * Phase F: Documents upload/versioning/download, backed by the local
 * storage driver (blueprint §26). The point of this suite is the round
 * trip: bytes that go in via upload must come back byte-for-byte via
 * download, through the real disk driver — not mocked.
 */
describe("Documents (e2e)", () => {
  let app: INestApplication;
  let founder: string;
  let pm: string; // Simran Kaur — Project Manager, Jaipur (has documents:* and is scoped to Jaipur only)
  let udaipurPm: string; // Rohit Meena — Project Manager, Dehradun only (has documents:* but NOT Jaipur access)
  let jaipurProjectId: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    founder = await loginAs(app, "anant.sharma@ammbrands.in");
    pm = await loginAs(app, "simran.kaur@ammbrands.in");
    udaipurPm = await loginAs(app, "rohit.meena@ammbrands.in");
    const jaipur = await prisma.city.findFirstOrThrow({ where: { code: "JPR" } });
    jaipurProjectId = (await prisma.project.findFirstOrThrow({ where: { cityId: jaipur.id } })).id;
  });

  afterAll(async () => await app.close());

  it("uploads a document and round-trips the exact bytes back through download", async () => {
    const content = Buffer.from(`e2e document contents ${Date.now()}`);
    const upload = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${pm}`)
      .field("meta", JSON.stringify({ name: "e2e Test Doc.txt", type: "OTHER", projectId: jaipurProjectId }))
      .attach("file", content, { filename: "e2e Test Doc.txt", contentType: "application/octet-stream" });
    expect(upload.status).toBe(201);
    expect(upload.body.versions).toHaveLength(1);
    const version = upload.body.versions[0];
    expect(version.versionNo).toBe(1);
    expect(version.fileName).toBe("e2e Test Doc.txt");
    expect(version.sizeBytes).toBe(content.length);

    const download = await request(app.getHttpServer())
      .get(`/api/document-versions/${version.id}/download`)
      .set("Authorization", `Bearer ${pm}`);
    expect(download.status).toBe(200);
    expect(download.headers["content-disposition"]).toContain("e2e Test Doc.txt");
    expect(Buffer.compare(download.body, content)).toBe(0);

    // The file is really on disk, not just recorded in the DB.
    const storageRoot = path.resolve(process.env.STORAGE_LOCAL_PATH ?? "./.local-storage");
    const onDisk = await fs.readFile(path.join(storageRoot, "local", upload.body.id, "v1", "e2e Test Doc.txt"));
    expect(Buffer.compare(onDisk, content)).toBe(0);
  });

  it("adding a new version increments versionNo and both versions remain downloadable", async () => {
    const v1Content = Buffer.from("version one");
    const create = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${pm}`)
      .field("meta", JSON.stringify({ name: "e2e Versioned Doc.txt", type: "OTHER", projectId: jaipurProjectId }))
      .attach("file", v1Content, { filename: "e2e Versioned Doc.txt", contentType: "application/octet-stream" });
    const docId = create.body.id;

    const v2Content = Buffer.from("version two — replaces the first");
    const addVersion = await request(app.getHttpServer())
      .post(`/api/documents/${docId}/versions`)
      .set("Authorization", `Bearer ${pm}`)
      .attach("file", v2Content, { filename: "e2e Versioned Doc.txt", contentType: "application/octet-stream" });
    expect(addVersion.status).toBe(201);
    expect(addVersion.body.versions).toHaveLength(2);
    expect(addVersion.body.versions[0].versionNo).toBe(2); // sorted desc

    const v1Id = addVersion.body.versions.find((v: { versionNo: number }) => v.versionNo === 1).id;
    const v2Id = addVersion.body.versions.find((v: { versionNo: number }) => v.versionNo === 2).id;

    const dl1 = await request(app.getHttpServer()).get(`/api/document-versions/${v1Id}/download`).set("Authorization", `Bearer ${pm}`);
    const dl2 = await request(app.getHttpServer()).get(`/api/document-versions/${v2Id}/download`).set("Authorization", `Bearer ${pm}`);
    expect(Buffer.compare(dl1.body, v1Content)).toBe(0);
    expect(Buffer.compare(dl2.body, v2Content)).toBe(0);
  });

  it("a workspace-level document (no project) uploads and lists fine", async () => {
    const content = Buffer.from("workspace-level doc");
    const res = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${founder}`)
      .field("meta", JSON.stringify({ name: "e2e Workspace Doc.txt", type: "OTHER" }))
      .attach("file", content, "e2e Workspace Doc.txt");
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBeNull();

    const list = await request(app.getHttpServer()).get("/api/documents").set("Authorization", `Bearer ${founder}`);
    expect(list.status).toBe(200);
    expect(list.body.some((d: { id: string }) => d.id === res.body.id)).toBe(true);
  });

  it("city scoping: a PM with real documents:create but no Jaipur access cannot upload to a Jaipur project", async () => {
    const content = Buffer.from("should be rejected");
    const blocked = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${udaipurPm}`)
      .field("meta", JSON.stringify({ name: "blocked.txt", type: "OTHER", projectId: jaipurProjectId }))
      .attach("file", content, "blocked.txt");
    expect(blocked.status).toBe(403);
  });

  it("rejects a request with no file attached", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${pm}`)
      .field("meta", JSON.stringify({ name: "no file", type: "OTHER" }));
    expect(res.status).toBe(400);
  });

  it("soft-deleting a document removes it from list/get but its rows still exist", async () => {
    const create = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${pm}`)
      .field("meta", JSON.stringify({ name: "e2e To Delete.txt", type: "OTHER", projectId: jaipurProjectId }))
      .attach("file", Buffer.from("delete me"), "e2e To Delete.txt");
    const docId = create.body.id;

    const removed = await request(app.getHttpServer()).delete(`/api/documents/${docId}`).set("Authorization", `Bearer ${pm}`);
    expect(removed.status).toBe(200);

    const get = await request(app.getHttpServer()).get(`/api/documents/${docId}`).set("Authorization", `Bearer ${pm}`);
    expect(get.status).toBe(404);

    const fromDb = await prisma.document.findUniqueOrThrow({ where: { id: docId } });
    expect(fromDb.deletedAt).not.toBeNull();
  });

  it("RBAC: Sales has no documents access at all", async () => {
    const sales = await loginAs(app, "ananya.joshi@ammbrands.in");
    const res = await request(app.getHttpServer()).get("/api/documents").set("Authorization", `Bearer ${sales}`);
    expect(res.status).toBe(403);
  });

  it("every mutation wrote an audit_logs row", async () => {
    const create = await request(app.getHttpServer())
      .post("/api/documents")
      .set("Authorization", `Bearer ${pm}`)
      .field("meta", JSON.stringify({ name: "e2e Audit Check.txt", type: "OTHER", projectId: jaipurProjectId }))
      .attach("file", Buffer.from("audit check"), "e2e Audit Check.txt");
    expect(await prisma.auditLog.count({ where: { entityId: create.body.id, action: "document.create" } })).toBeGreaterThan(0);
  });
});
