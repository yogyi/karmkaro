import { z } from "zod";
import { isDemoMode } from "@/lib/demo-mode";
import { AppError } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { requireContext } from "@/lib/session";
import {
  bulkSchema,
  commentSchema,
  inviteSchema,
  projectSchema,
  taskPatchSchema,
  taskWriteSchema,
} from "@/lib/validators";
import { breakdown, chat, digestFor, quickAdd, smartAssign, weeklyFor } from "./ai";
import {
  createProject,
  createSection,
  dashboard,
  employeeProfile,
  inviteCsv,
  invitePerson,
  listAudit,
  loadBootstrap,
  report,
  reportCsv,
  reportPdf,
  sendPasswordReset,
  updateMember,
  updateProject,
  updateSettings,
  workload,
} from "./org";
import {
  deletePayslip,
  emailPayslip,
  emailPayslipsForMonth,
  generatePayslips,
  getPayslip,
  listMyPayslips,
  listPayDesk,
  payslipPdf,
  updatePayslip,
  upsertSalary,
} from "./salary";
import {
  addChecklistItem,
  addComment,
  bulkUpdate,
  createTask,
  getTaskDetail,
  listTasks,
  reorderTasks,
  softDeleteTask,
  toggleChecklist,
  updateTask,
} from "./tasks";

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function assertSameOrigin(request: Request) {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new AppError("Cross-origin request blocked", 403, "csrf");
  }
  if (!origin || !host) return;
  if (new URL(origin).host !== host) throw new AppError("Cross-origin request blocked", 403, "csrf");
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new AppError("Send JSON");
  }
}

export async function dispatch(request: Request, parts: string[]) {
  assertSameOrigin(request);
  const ctx = await requireContext();
  const method = request.method;
  const [a, b, c, d] = parts;
  const url = new URL(request.url);

  // Preview deploy has no Postgres — allow browsing, soft-ack writes.
  if (isDemoMode() && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    if (a === "ai") {
      return json({
        reply: "Demo preview only — connect DATABASE_URL to use AI actions for real.",
        demo: true,
      });
    }
    return json({ ok: true, demo: true });
  }

  if (a === "me" && !b && method === "GET") return json(await loadBootstrap(ctx));
  if (a === "me" && !b && method === "PATCH") {
    const body = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      locale: z.enum(["en", "hi"]).optional(),
      theme: z.enum(["light", "dark", "system"]).optional(),
      onboardingDone: z.boolean().optional(),
    }).parse(await readJson(request));
    await prisma.user.update({ where: { id: ctx.user.id }, data: body });
    return json({ ok: true });
  }
  if (a === "me" && b === "push" && method === "POST") {
    const body = z.object({ endpoint: z.string().url(), p256dh: z.string(), auth: z.string() }).parse(await readJson(request));
    await prisma.user.update({
      where: { id: ctx.user.id },
      data: { pushEndpoint: body.endpoint, pushP256dh: body.p256dh, pushAuth: body.auth },
    });
    return json({ ok: true });
  }

  if (a === "tasks" && b === "bulk" && method === "POST") {
    const body = bulkSchema.parse(await readJson(request));
    return json(await bulkUpdate(ctx, body.ids, body));
  }
  if (a === "tasks" && b === "reorder" && method === "POST") {
    const body = z.object({
      ids: z.array(z.string()).min(1),
      status: z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]).optional(),
    }).parse(await readJson(request));
    await reorderTasks(ctx, body.ids, body.status);
    return json({ ok: true });
  }
  if (a === "tasks" && !b && method === "GET") {
    return json(await listTasks(ctx, {
      view: url.searchParams.get("view") ?? undefined,
      projectId: url.searchParams.get("projectId") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      filter: url.searchParams.get("filter") ?? undefined,
    }));
  }
  if (a === "tasks" && !b && method === "POST") return json(await createTask(ctx, taskWriteSchema.parse(await readJson(request))));
  if (a === "tasks" && b && c === "comments" && method === "POST") {
    return json(await addComment(ctx, b, commentSchema.parse(await readJson(request)).body));
  }
  if (a === "tasks" && b && c === "checklist" && !d && method === "POST") {
    const body = z.object({ title: z.string().min(1).max(200) }).parse(await readJson(request));
    return json(await addChecklistItem(ctx, b, body.title));
  }
  if (a === "tasks" && b && c === "checklist" && d && method === "PATCH") {
    const body = z.object({ done: z.boolean() }).parse(await readJson(request));
    return json(await toggleChecklist(ctx, b, d, body.done));
  }
  if (a === "tasks" && b && !c && method === "GET") return json(await getTaskDetail(ctx, b));
  if (a === "tasks" && b && !c && method === "PATCH") return json(await updateTask(ctx, b, taskPatchSchema.parse(await readJson(request))));
  if (a === "tasks" && b && !c && method === "DELETE") {
    await softDeleteTask(ctx, b);
    return json({ ok: true });
  }

  if (a === "projects" && !b && method === "GET") return json((await loadBootstrap(ctx)).projects);
  if (a === "projects" && !b && method === "POST") return json(await createProject(ctx, projectSchema.parse(await readJson(request))));
  if (a === "projects" && b && !c && method === "PATCH") return json(await updateProject(ctx, b, projectSchema.partial().extend({ archived: z.boolean().optional() }).parse(await readJson(request))));
  if (a === "projects" && b && c === "sections" && method === "POST") {
    const body = z.object({ name: z.string().min(1).max(80) }).parse(await readJson(request));
    return json(await createSection(ctx, b, body.name));
  }

  if (a === "labels" && method === "POST") {
    if (!can(ctx.role, "project.manage")) throw new AppError("Only a manager can add labels", 403);
    const body = z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).parse(await readJson(request));
    const label = await prisma.label.upsert({
      where: { organizationId_name: { organizationId: ctx.organizationId, name: body.name.toLowerCase() } },
      update: { color: body.color },
      create: { organizationId: ctx.organizationId, name: body.name.toLowerCase(), color: body.color || "#312e81" },
    });
    return json(label);
  }
  if (a === "labels" && b && method === "DELETE") {
    if (!can(ctx.role, "project.manage")) throw new AppError("Only a manager can remove labels", 403);
    await prisma.label.deleteMany({ where: { id: b, organizationId: ctx.organizationId } });
    return json({ ok: true });
  }

  if (a === "filters" && method === "GET") return json((await loadBootstrap(ctx)).filters);
  if (a === "filters" && method === "POST") {
    const body = z.object({ name: z.string().min(1).max(60), query: z.string().min(1).max(300) }).parse(await readJson(request));
    const filter = await prisma.savedFilter.create({
      data: { organizationId: ctx.organizationId, userId: ctx.user.id, name: body.name, query: body.query },
    });
    return json(filter);
  }
  if (a === "filters" && b && method === "DELETE") {
    await prisma.savedFilter.deleteMany({ where: { id: b, userId: ctx.user.id, organizationId: ctx.organizationId } });
    return json({ ok: true });
  }

  if (a === "notifications" && method === "POST") {
    await prisma.notification.updateMany({
      where: { userId: ctx.user.id, organizationId: ctx.organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    return json({ ok: true });
  }

  if (a === "invites" && b === "csv" && method === "POST") {
    const body = z.object({ csv: z.string().min(3).max(100_000) }).parse(await readJson(request));
    return json(await inviteCsv(ctx, body.csv));
  }
  if (a === "invites" && !b && method === "POST") return json(await invitePerson(ctx, inviteSchema.parse(await readJson(request))));

  if (a === "members" && b && c === "reset" && method === "POST") return json(await sendPasswordReset(ctx, b));
  if (a === "members" && b && !c && method === "GET") return json(await employeeProfile(ctx, b));
  if (a === "members" && b && !c && method === "PATCH") {
    const body = z.object({
      role: z.enum(["SUPER_ADMIN", "ADMIN", "EMPLOYEE"]).optional(),
      active: z.boolean().optional(),
      title: z.string().max(80).nullable().optional(),
    }).parse(await readJson(request));
    await updateMember(ctx, b, body);
    return json({ ok: true });
  }

  if (a === "admin" && b === "dashboard" && method === "GET") return json(await dashboard(ctx));
  if (a === "admin" && b === "workload" && method === "GET") return json(await workload(ctx));
  if (a === "admin" && b === "reports" && method === "GET") {
    const data = await report(ctx, url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined);
    if (url.searchParams.get("format") === "csv") {
      return new Response(reportCsv(data), { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=karm-karo-report.csv" } });
    }
    if (url.searchParams.get("format") === "pdf") {
      const bytes = await reportPdf(ctx, data);
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=karm-karo-report.pdf" } });
    }
    return json(data);
  }
  if (a === "admin" && b === "audit" && method === "GET") return json(await listAudit(ctx));
  if (a === "admin" && b === "pay" && !c && method === "GET") return json(await listPayDesk(ctx));
  if (a === "admin" && b === "pay" && c === "profile" && method === "POST") {
    const body = z.object({
      userId: z.string().min(1),
      baseSalary: z.number().int().positive().max(100_000_000),
      hra: z.number().int().min(0).max(100_000_000).optional(),
      specialAllowance: z.number().int().min(0).max(100_000_000).optional(),
      pfDeduction: z.number().int().min(0).max(100_000_000).optional(),
      taxDeduction: z.number().int().min(0).max(100_000_000).optional(),
      otherDeduction: z.number().int().min(0).max(100_000_000).optional(),
      bankLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
      panMasked: z.string().max(12).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
      effectiveFrom: z.string().datetime().optional(),
    }).parse(await readJson(request));
    const { userId, ...rest } = body;
    return json(await upsertSalary(ctx, userId, rest));
  }
  if (a === "admin" && b === "pay" && c === "generate" && method === "POST") {
    const body = z.object({
      year: z.number().int().min(2020).max(2100),
      month: z.number().int().min(1).max(12),
      userIds: z.array(z.string()).max(200).optional(),
    }).parse(await readJson(request));
    return json(await generatePayslips(ctx, body));
  }
  if (a === "admin" && b === "pay" && c === "email-month" && method === "POST") {
    const body = z.object({
      year: z.number().int().min(2020).max(2100),
      month: z.number().int().min(1).max(12),
      userIds: z.array(z.string()).max(200).optional(),
    }).parse(await readJson(request));
    return json(await emailPayslipsForMonth(ctx, body.year, body.month, body.userIds));
  }
  if (a === "payslips" && !b && method === "GET") return json(await listMyPayslips(ctx));
  if (a === "payslips" && b && c === "email" && method === "POST") return json(await emailPayslip(ctx, b));
  if (a === "payslips" && b && c === "pdf" && method === "GET") {
    const file = await payslipPdf(ctx, b);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
      },
    });
  }
  if (a === "payslips" && b && !c && method === "GET") return json(await getPayslip(ctx, b));
  if (a === "payslips" && b && !c && method === "PATCH") {
    const body = z.object({
      baseSalary: z.number().int().positive().max(100_000_000).optional(),
      hra: z.number().int().min(0).max(100_000_000).optional(),
      specialAllowance: z.number().int().min(0).max(100_000_000).optional(),
      pfDeduction: z.number().int().min(0).max(100_000_000).optional(),
      taxDeduction: z.number().int().min(0).max(100_000_000).optional(),
      otherDeduction: z.number().int().min(0).max(100_000_000).optional(),
      bankLast4: z.string().regex(/^\d{4}$/).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
    }).parse(await readJson(request));
    return json(await updatePayslip(ctx, b, body));
  }
  if (a === "payslips" && b && !c && method === "DELETE") return json(await deletePayslip(ctx, b));
  if (a === "admin" && b === "settings" && method === "PATCH") {
    const body = z.object({
      name: z.string().min(2).max(80).optional(),
      timezone: z.string().min(1).max(80).optional(),
      workingDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      workStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      workEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      notifyOnAssign: z.boolean().optional(),
      emailOnAssign: z.boolean().optional(),
      digestHour: z.number().int().min(0).max(23).optional(),
      weeklyReportDay: z.number().int().min(0).max(6).optional(),
      payrollDay: z.number().int().min(1).max(28).optional(),
    }).parse(await readJson(request));
    await updateSettings(ctx, body);
    return json({ ok: true });
  }

  if (a === "ai" && b === "quick-add" && method === "POST") {
    rateLimit(`ai:${ctx.user.id}`, 30, 10 * 60 * 1000);
    const body = z.object({ text: z.string().trim().min(2).max(2_000) }).parse(await readJson(request));
    return json(await quickAdd(ctx, body.text));
  }
  if (a === "ai" && b === "breakdown" && method === "POST") {
    const body = z.object({ taskId: z.string() }).parse(await readJson(request));
    return json(await breakdown(ctx, body.taskId));
  }
  if (a === "ai" && b === "assign" && method === "POST") {
    const body = z.object({ taskId: z.string() }).parse(await readJson(request));
    return json(await smartAssign(ctx, body.taskId));
  }
  if (a === "ai" && b === "chat" && method === "POST") {
    const body = z.object({ message: z.string().trim().min(1).max(2_000) }).parse(await readJson(request));
    return json(await chat(ctx, body.message));
  }
  if (a === "ai" && b === "digest" && method === "POST") return json(await digestFor(ctx));
  if (a === "ai" && b === "weekly" && method === "POST") return json(await weeklyFor(ctx));

  if (a === "search" && method === "GET") {
    return json(await listTasks(ctx, { q: url.searchParams.get("q") ?? "", view: "search" }));
  }

  throw new AppError("Not found", 404, "not_found");
}
