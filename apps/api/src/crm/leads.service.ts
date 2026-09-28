import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { ConvertLeadInput, CreateLeadInput, PlaybookTaskInput } from "@podium/shared-types";
import { AutomationService } from "../automation/automation.service";
import { CityScopeService } from "../common/city-scope/city-scope.service";
import { PrismaService } from "../common/prisma/prisma.service";
import type { RequestUser } from "../common/types";

/** The `tx` handle Prisma hands an interactive transaction callback. */
type PrismaTransaction = Parameters<Parameters<PrismaService["client"]["$transaction"]>[0]>[0];
import { FlowsService } from "../flows/flows.service";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

export interface ListLeadsOptions {
  cityId?: string;
  kind?: "PIPELINE" | "COLD_PROSPECT";
  stage?: "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION" | "WON" | "LOST";
  sourceSheet?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cityScope: CityScopeService,
    private readonly automation: AutomationService,
    private readonly flows: FlowsService,
  ) {}

  /**
   * LEADS ARE NOT CITY-SCOPED, and that is deliberate.
   *
   * Everything else in Podium is: a Delhi project belongs to Delhi, and a
   * Goa City Head has no business reading it. A lead is different, because
   * it is not yet anybody's work. It is an enquiry that arrived — from the
   * website, from Meta, from a phone call — and quite often it arrives with
   * no city at all, or with a city nobody has mapped yet ("Gurgaon",
   * "NCR", "near Manesar").
   *
   * Under city scoping those leads were invisible to everyone except
   * all-cities users, which is how 11,911 of the 12,756 leads in this
   * database ended up unreachable by the Sales team that is meant to work
   * them. An enquiry that no one can see is a lost sale, and losing it to an
   * access rule is worse than losing it to a competitor.
   *
   * So the pipeline is a company-wide pool: anyone with `leads:view` sees
   * every lead. The city boundary re-asserts itself the moment a lead
   * becomes real work — `convert()` below still refuses to create a project
   * in a city the caller has no access to, because a project IS somebody's
   * work and does belong to a city.
   *
   * Defaults to the PIPELINE kind — the CRM board is about the real,
   * human-worked opportunities, not the thousands of cold prospecting rows.
   * Cold lists are reachable with `kind=COLD_PROSPECT`, paged.
   */
  async list(user: RequestUser, opts: ListLeadsOptions = {}) {
    const take = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const where = {
      workspaceId: user.workspaceId,
      deletedAt: null,
      kind: opts.kind ?? ("PIPELINE" as const),
      ...(opts.stage ? { stage: opts.stage } : {}),
      ...(opts.sourceSheet ? { sourceSheet: opts.sourceSheet } : {}),
      ...(opts.search ? { name: { contains: opts.search, mode: "insensitive" as const } } : {}),
      // A city here NARROWS the view because the person asked it to. It is
      // not a permission boundary — see the note on the class.
      ...(opts.cityId ? { cityId: opts.cityId } : {}),
    };
    // In parallel, not a batch $transaction: that runs its queries one after
    // another on one connection plus BEGIN/COMMIT, each a ~320 ms trip to the
    // Sydney database. A list count need not be transactionally exact.
    const [total, rows] = await Promise.all([
      this.prisma.client.lead.count({ where }),
      this.prisma.client.lead.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take,
        skip: opts.offset ?? 0,
      }),
    ]);
    return { total, limit: take, offset: opts.offset ?? 0, rows };
  }

  async get(user: RequestUser, id: string) {
    const lead = await this.prisma.client.lead.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!lead) throw new NotFoundException("Lead not found.");
    return lead;
  }

  async create(user: RequestUser, input: CreateLeadInput) {
    return this.prisma.client.lead.create({
      data: { ...input, stage: "LEAD", workspaceId: user.workspaceId, createdById: user.id, updatedById: user.id },
    });
  }

  async updateStage(user: RequestUser, id: string, stage: "LEAD" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION" | "WON" | "LOST") {
    const lead = await this.prisma.client.lead.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!lead) throw new NotFoundException("Lead not found.");
    if (stage === "WON") {
      throw new BadRequestException("Use POST /leads/:id/convert to move a lead to Won — it needs project details automation au1 can't infer.");
    }
    const updated = await this.prisma.client.lead.update({ where: { id: lead.id }, data: { stage, updatedById: user.id } });

    // Fire the event triggers inline, after the write has committed, so an
    // automation failure can never roll back the stage change that caused it.
    await this.automation.emit({
      trigger: `lead.stage_changed:${stage}`,
      workspaceId: user.workspaceId,
      entityId: lead.id,
      entityType: "lead",
    });
    return updated;
  }

  /**
   * BUG-007. The one definition of "this lead has already been converted".
   *
   * Live means the project has not been soft-deleted. A project deleted in
   * error must not lock its lead out of ever being converted again, which is
   * why the invariant is "at most one VALID ACTIVE conversion" rather than
   * "at most one ever" — and why the database index behind it is partial.
   *
   * `tx` lets the transaction re-ask the same question under its row lock, so
   * the check that decides and the check that raced cannot drift apart.
   */
  private async existingConversion(user: RequestUser, leadId: string, tx?: PrismaTransaction) {
    const db = tx ?? this.prisma.client;
    const project = await db.project.findFirst({
      where: { convertedFromLeadId: leadId, workspaceId: user.workspaceId, deletedAt: null },
      include: { client: true },
    });
    if (!project) return null;
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    const { client, ...bare } = project;
    return { lead, client, project: bare, alreadyConverted: true as const };
  }

  /**
   * Automation au1, "Deal Won -> Project Auto-Creation" (blueprint §5A):
   * marks the lead Won, creates (or reuses) the client, creates the project,
   * and creates its chat channel — atomically, so a failure partway through
   * never leaves a Won lead with no project. If a playbook was chosen,
   * Phase E applies its defaults (tasks + flow instances) as a follow-up
   * step after this transaction commits — same "never roll back the write
   * that already succeeded" convention as updateStage()'s automation.emit()
   * below: a playbook-application failure surfaces to the caller as an
   * error, but the project/client/channel it should have decorated already
   * exists and is usable.
   */
  async convert(user: RequestUser, id: string, input: ConvertLeadInput) {
    const lead = await this.prisma.client.lead.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!lead) throw new NotFoundException("Lead not found.");

    /**
     * BUG-007, layer 1 of 3: answer a repeat without doing any work.
     *
     * This runs BEFORE the field validation below on purpose. A retry after a
     * dropped response, or a browser refresh on the success screen, resends
     * whatever body it sent the first time; if that body is now judged
     * incomplete the caller gets a 400 for a conversion that in fact
     * succeeded, and the UI shows a failure over a real project.
     *
     * It is an optimisation, not the guarantee — two simultaneous requests
     * both reach here before either has written anything. Layers 2 and 3 are
     * inside the transaction.
     */
    const done = await this.existingConversion(user, lead.id);
    if (done) return done;

    if (!input.clientId && !input.clientName) {
      throw new BadRequestException("Provide clientId (existing) or clientName (to create one).");
    }

    // Imported leads often have no city and no value (the source sheets had
    // free-text locations and no quoted amount). A project needs both, so the
    // converting user supplies what's missing rather than the system guessing.
    const cityId = lead.cityId ?? input.cityId ?? null;
    if (!cityId) {
      throw new BadRequestException("This lead has no city assigned — pass cityId to say which city the project belongs to.");
    }
    this.cityScope.assertCanAccessCity(user, cityId);
    const value = lead.value ?? (input.value !== undefined ? input.value : null);
    if (value === null) {
      throw new BadRequestException("This lead has no estimated value — pass value to set the project's revenue.");
    }

    const result = await this.prisma.client.$transaction(async (tx) => {
      /**
       * Layer 2: serialise. Two conversions of the SAME lead now queue behind
       * this row lock, so the loser reads the winner's committed project
       * rather than racing it. Locking the lead (not the project) is what
       * makes this work — the project it must not duplicate does not exist
       * yet, so there is nothing else to lock.
       *
       * Prisma has no `FOR UPDATE`, hence raw SQL. It is parameterised, and
       * the id is a uuid that came from a row we just read.
       */
      await tx.$queryRaw`SELECT "id" FROM "leads" WHERE "id" = ${lead.id}::uuid FOR UPDATE`;
      const raced = await this.existingConversion(user, lead.id, tx);
      if (raced) return raced;

      const client = input.clientId
        ? await tx.client.findUniqueOrThrow({ where: { id: input.clientId } })
        : await tx.client.create({
            data: {
              workspaceId: user.workspaceId,
              name: input.clientName!,
              type: input.clientType ?? "INDIVIDUAL",
              cityId,
              ltv: value,
              since: new Date(),
              createdById: user.id,
              updatedById: user.id,
            },
          });

      const project = await tx.project.create({
        data: {
          workspaceId: user.workspaceId,
          name: input.projectName,
          clientId: client.id,
          playbookId: input.playbookId,
          type: input.projectType,
          cityId,
          eventDate: input.eventDate,
          pmId: input.pmId,
          status: "PLANNING",
          revenue: value,
          // Layer 3: the invariant itself. Partial unique index
          // projects_one_live_conversion_per_lead rejects a second live
          // conversion even if layers 1 and 2 are bypassed entirely — by a
          // future code path, a background job, or a hand-written INSERT.
          convertedFromLeadId: lead.id,
          createdById: user.id,
          updatedById: user.id,
        },
      });

      const slug = input.projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      await tx.channel.create({ data: { workspaceId: user.workspaceId, name: slug, kind: "PROJECT", projectId: project.id } });

      const wonLead = await tx.lead.update({
        where: { id: lead.id },
        data: { stage: "WON", convertedClientId: client.id, convertedProjectId: project.id, updatedById: user.id },
      });

      await tx.notification.create({
        data: {
          workspaceId: user.workspaceId,
          userId: input.pmId,
          icon: "◧",
          text: `New project from Won deal: ${input.projectName}`,
          sourceType: "project",
          sourceId: project.id,
        },
      });

      return { lead: wonLead, client, project, alreadyConverted: false };
    });

    // Never re-apply a playbook to a project that already had one applied:
    // that is how a repeat conversion would still end up duplicating a
    // project's tasks and flow instances even with the project itself deduped.
    if (result.alreadyConverted) return result;

    if (result.project.playbookId) {
      await this.applyPlaybookDefaults(user, result.project.id, result.project.playbookId, result.project.eventDate, input.pmId);
    }
    return result;
  }

  /**
   * OPEN DECISION, defaulted conservatively — needs Anant's confirmation:
   * every task and every flow step this creates is owned by the project's
   * PM, never split by role. The playbook's defaultTasks have no per-task
   * owner field, and a brand-new project has no crew roster yet beyond the
   * PM to route anything else to — the PM reassigning tasks/steps afterward
   * (already-supported, existing functionality) is the fallback. Revisit if
   * a real playbook wants role-based routing at creation time.
   */
  private async applyPlaybookDefaults(user: RequestUser, projectId: string, playbookId: string, eventDate: Date, pmId: string) {
    const playbook = await this.prisma.client.playbook.findFirst({
      where: { id: playbookId, workspaceId: user.workspaceId, deletedAt: null },
    });
    if (!playbook) return; // chosen playbook was deleted between the request and now — the project itself still stands

    const tasks = playbook.defaultTasks as unknown as PlaybookTaskInput[];
    for (const t of tasks) {
      const dueAt = t.dueOffsetDays !== undefined ? new Date(eventDate.getTime() - t.dueOffsetDays * 86400000) : null;
      await this.prisma.client.task.create({
        data: {
          projectId, name: t.name, ownerId: pmId, dueAt, status: "BACKLOG", priority: "MEDIUM",
          createdById: user.id, updatedById: user.id,
        },
      });
    }

    for (const templateId of playbook.defaultFlowTemplateIds) {
      const template = await this.prisma.client.flowTemplate.findFirst({
        where: { id: templateId, workspaceId: user.workspaceId, deletedAt: null },
      });
      if (!template) continue; // referenced template was deleted since — skip rather than fail the whole conversion
      const steps = template.steps as unknown as Array<{ k: string }>;
      const ownerOverrides = Object.fromEntries(steps.map((s) => [s.k, pmId]));
      await this.flows.instantiate(user, { templateId, projectId, ownerOverrides });
    }
  }

  /**
   * Marks a lead Won without the manual conversion flow — the path the
   * automation engine's Deal-Won rule reacts to. Kept separate from
   * `updateStage`, which refuses WON precisely because a human conversion
   * needs project details.
   */
  async markWon(user: RequestUser, id: string) {
    const lead = await this.prisma.client.lead.findFirst({ where: { id, workspaceId: user.workspaceId, deletedAt: null } });
    if (!lead) throw new NotFoundException("Lead not found.");
    const updated = await this.prisma.client.lead.update({ where: { id: lead.id }, data: { stage: "WON", updatedById: user.id } });
    const results = await this.automation.emit({
      trigger: "lead.stage_changed:Won",
      workspaceId: user.workspaceId,
      entityId: lead.id,
      entityType: "lead",
    });
    return { lead: updated, automation: results };
  }
}
