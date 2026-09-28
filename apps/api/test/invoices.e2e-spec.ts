import type { INestApplication } from "@nestjs/common";
import { prisma } from "@podium/db";
import request from "supertest";
import { bootstrapTestApp, loginAs } from "./support";

/**
 * GST correctness (blueprint §17) is exactly the kind of financial
 * calculation that must never regress silently: intra-state invoices split
 * 9%/9% into CGST+SGST, inter-state invoices are 18% IGST, and an ISSUED
 * invoice's number is minted once, sequentially, and never reused.
 */
describe("Invoices — GST engine (e2e)", () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
    token = await loginAs(app, "neha.agarwal@ammbrands.in"); // Finance Manager
  });

  afterAll(async () => {
    await app.close();
  });

  function post(path: string, body?: unknown) {
    return request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${token}`).send(body ?? {});
  }

  it("splits an intra-state invoice into equal CGST + SGST, no IGST", async () => {
    // Cognizant (client) is Jaipur/Rajasthan (08); billing from Jaipur -> intra-state.
    const jaipur = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    const cognizant = await prisma.client.findFirstOrThrow({ where: { name: { contains: "Cognizant" } } });
    const project = await prisma.project.findFirstOrThrow({ where: { clientId: cognizant.id } });

    const draft = await post("/api/invoices", {
      clientId: cognizant.id,
      projectId: project.id,
      cityId: jaipur.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: [{ description: "Test line item", qty: 1, rate: 100000 }],
    });
    expect(draft.status).toBe(201);

    const issued = await post(`/api/invoices/${draft.body.id}/issue`);
    expect(issued.status).toBe(201);
    expect(Number(issued.body.cgst)).toBe(9000);
    expect(Number(issued.body.sgst)).toBe(9000);
    expect(Number(issued.body.igst)).toBe(0);
    expect(Number(issued.body.total)).toBe(118000);
    expect(issued.body.invoiceNo).toMatch(/^AMM\/JPR\/\d{2}-\d{2}\/\d{4}$/);
  });

  it("splits an inter-state invoice into pure IGST, no CGST/SGST", async () => {
    // Bansal Group is Goa (30); billing from Jaipur (08) -> inter-state.
    const jaipur = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    const bansal = await prisma.client.findFirstOrThrow({ where: { name: { contains: "Bansal" } } });
    const project = await prisma.project.findFirstOrThrow({ where: { clientId: bansal.id } });

    const draft = await post("/api/invoices", {
      clientId: bansal.id,
      projectId: project.id,
      cityId: jaipur.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: [{ description: "Test line item", qty: 1, rate: 200000 }],
    });
    const issued = await post(`/api/invoices/${draft.body.id}/issue`);
    expect(issued.status).toBe(201);
    expect(Number(issued.body.cgst)).toBe(0);
    expect(Number(issued.body.sgst)).toBe(0);
    expect(Number(issued.body.igst)).toBe(36000);
    expect(Number(issued.body.total)).toBe(236000);
  });

  it("mints strictly increasing, never-reused sequence numbers per city per FY", async () => {
    const jaipur = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    // Query from the project side, not the client side: a Jaipur client with
    // no project at all is a real possibility in this shared, ever-growing
    // test database (findFirstOrThrow on the client table has no guaranteed
    // order and no filter for "has a project"), whereas a project always has
    // a real client attached.
    const project = await prisma.project.findFirstOrThrow({ where: { cityId: jaipur.id } });

    const mint = async () => {
      const draft = await post("/api/invoices", {
        clientId: project.clientId,
        projectId: project.id,
        cityId: jaipur.id,
        dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
        items: [{ description: "seq test", qty: 1, rate: 1000 }],
      });
      const issued = await post(`/api/invoices/${draft.body.id}/issue`);
      return issued.body.invoiceNo as string;
    };
    const seqOf = (no: string) => Number(no.split("/").pop());

    const first = await mint();
    const second = await mint();
    expect(seqOf(second)).toBe(seqOf(first) + 1);
  });

  it("refuses to issue an already-issued invoice a second time", async () => {
    const jaipur = await prisma.city.findFirstOrThrow({ where: { name: "Jaipur" } });
    const project = await prisma.project.findFirstOrThrow({ where: { cityId: jaipur.id } });
    const draft = await post("/api/invoices", {
      clientId: project.clientId, projectId: project.id, cityId: jaipur.id,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
      items: [{ description: "double issue test", qty: 1, rate: 1000 }],
    });
    await post(`/api/invoices/${draft.body.id}/issue`).expect(201);
    await post(`/api/invoices/${draft.body.id}/issue`).expect(409);
  });
});
