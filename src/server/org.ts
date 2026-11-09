import type { Prisma, Role } from "@/generated/prisma/client";
import {
  demoAudit,
  demoBootstrap,
  demoDashboard,
  demoEmployeeProfile,
  demoReport,
  demoWorkload,
  isDemoMode,
} from "@/lib/demo-mode";
import type { Bootstrap, MemberDTO, ProjectDTO } from "@/lib/dto";
import { emailLinksExposed, emailShell, sendEmail, appUrl } from "@/lib/email";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { hashPassword, hashToken, newToken } from "@/lib/password";
import { can, canGrantRole } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { sanitizeText } from "@/lib/sanitize";
import type { AppContext } from "@/lib/session";
import { uniqueSlug } from "@/lib/utils";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { addDaysZoned, dayKey, startOfZonedDay } from "@/lib/zoned";
import { audit } from "./notify";

const DEFAULT_LABELS = [
  ["client", "#e8610a"],
  ["design", "#312e81"],
  ["finance", "#0f766e"],
  ["ops", "#57534e"],
  ["urgent", "#b91c1c"],
];

export async function createWorkspace(input: { name: string; userId: string; role?: Role }) {
  const slug = await uniqueSlug(input.name, async (candidate) => {
    const found = await prisma.organization.findUnique({ where: { slug: candidate } });
    return Boolean(found);
  });
  const org = await prisma.organization.create({
    data: {
      name: input.name.trim(),
      slug,
      labels: { create: DEFAULT_LABELS.map(([name, color]) => ({ name, color })) },
      memberships: { create: { userId: input.userId, role: input.role ?? "SUPER_ADMIN", title: "Founder" } },
    },
  });
  await prisma.user.update({ where: { id: input.userId }, data: { activeOrganizationId: org.id } });
  return org;
}

function memberDTO(row: Prisma.MembershipGetPayload<{ include: { user: true } }>): MemberDTO {
  return {
    id: row.user.id,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    active: row.active,
    title: row.title,
    image: row.user.image,
  };
}

export async function loadBootstrap(ctx: AppContext): Promise<Bootstrap> {
  if (isDemoMode()) return demoBootstrap(ctx.user.id);
  const [members, projects, labels, notifications, filters, me] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.project.findMany({
      where: { organizationId: ctx.organizationId },
      include: { sections: { orderBy: { position: "asc" } }, members: true },
      orderBy: { position: "asc" },
    }),
    prisma.label.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" } }),
    prisma.notification.findMany({
      where: { userId: ctx.user.id, organizationId: ctx.organizationId },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    prisma.savedFilter.findMany({ where: { userId: ctx.user.id, organizationId: ctx.organizationId } }),
    prisma.membership.findFirst({
      where: { userId: ctx.user.id, organizationId: ctx.organizationId },
      include: { user: true },
    }),
  ]);
  if (!me) throw new NotFoundError();
  const visibleProjects = can(ctx.role, "project.manage")
    ? projects
    : projects.filter((project) => project.members.some((member) => member.userId === ctx.user.id));
  return {
    me: { ...memberDTO(me), locale: ctx.user.locale, theme: ctx.user.theme, onboardingDone: ctx.user.onboardingDone },
    org: {
      id: ctx.org.id,
      name: ctx.org.name,
      slug: ctx.org.slug,
      timezone: ctx.org.timezone,
      workingDays: ctx.org.workingDays,
      workStart: ctx.org.workStart,
      workEnd: ctx.org.workEnd,
      notifyOnAssign: ctx.org.notifyOnAssign,
      emailOnAssign: ctx.org.emailOnAssign,
      digestHour: ctx.org.digestHour,
      weeklyReportDay: ctx.org.weeklyReportDay,
      payrollDay: ctx.org.payrollDay,
      hasLogo: Boolean(ctx.org.logoKey),
    },
    members: members.map(memberDTO),
    projects: visibleProjects.map(toProject),
    labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    notifications: notifications.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body,
      link: item.link,
      readAt: item.readAt?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    })),
    filters: filters.map((filter) => ({ id: filter.id, name: filter.name, query: filter.query })),
  };
}

function toProject(project: Prisma.ProjectGetPayload<{ include: { sections: true; members: true } }>): ProjectDTO {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    color: project.color,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    position: project.position,
    sections: project.sections.map((section) => ({ id: section.id, name: section.name, position: section.position })),
    memberIds: project.members.map((member) => member.userId),
  };
}

export async function createProject(
  ctx: AppContext,
  input: { name: string; description?: string | null; color?: string; memberIds?: string[] },
) {
  if (!can(ctx.role, "project.manage")) throw new ForbiddenError();
  const project = await prisma.project.create({
    data: {
      organizationId: ctx.organizationId,
      name: sanitizeText(input.name, 80),
      description: input.description ? sanitizeText(input.description, 2000) : null,
      color: input.color || "#e8610a",
      sections: { create: [{ name: "To shape", position: 0 }, { name: "In motion", position: 1 }, { name: "Ready", position: 2 }] },
      members: {
        create: [...new Set([ctx.user.id, ...(input.memberIds ?? [])])].map((userId) => ({
          userId,
          role: userId === ctx.user.id ? "OWNER" : "EDITOR",
        })),
      },
    },
    include: { sections: true, members: true },
  });
  await audit(ctx, "project.created", "project", project.id, { name: project.name });
  return toProject(project);
}

export async function updateProject(
  ctx: AppContext,
  id: string,
  input: { name?: string; description?: string | null; color?: string; archived?: boolean; memberIds?: string[] },
) {
  if (!can(ctx.role, "project.manage")) throw new ForbiddenError();
  const project = await prisma.project.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!project) throw new NotFoundError();
  await prisma.project.update({
    where: { id },
    data: {
      name: input.name ? sanitizeText(input.name, 80) : undefined,
      description: input.description === undefined ? undefined : input.description ? sanitizeText(input.description, 2000) : null,
      color: input.color,
      archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null,
    },
    include: { sections: true, members: true },
  });
  if (input.memberIds) {
    const ids = [...new Set(input.memberIds)];
    const count = await prisma.membership.count({
      where: { organizationId: ctx.organizationId, userId: { in: ids }, active: true },
    });
    if (count !== ids.length) throw new ForbiddenError("A project member is outside this workspace");
    await prisma.projectMember.deleteMany({ where: { projectId: id } });
    await prisma.projectMember.createMany({
      data: ids.map((userId) => ({ projectId: id, userId, role: userId === ctx.user.id ? "OWNER" as const : "EDITOR" as const })),
    });
  }
  if (input.archived) await audit(ctx, "project.archived", "project", id, { name: project.name });
  const fresh = await prisma.project.findFirstOrThrow({
    where: { id },
    include: { sections: true, members: true },
  });
  return toProject(fresh);
}

export async function createSection(ctx: AppContext, projectId: string, name: string) {
  if (!can(ctx.role, "project.manage")) throw new ForbiddenError();
  const project = await prisma.project.findFirst({ where: { id: projectId, organizationId: ctx.organizationId } });
  if (!project) throw new NotFoundError();
  const position = await prisma.section.count({ where: { projectId } });
  return prisma.section.create({ data: { projectId, name: sanitizeText(name, 80), position } });
}

export async function invitePerson(ctx: AppContext, input: { email: string; name?: string; role: "ADMIN" | "EMPLOYEE" }) {
  if (!can(ctx.role, "member.invite")) throw new ForbiddenError();
  if (!canGrantRole(ctx.role, input.role)) throw new ForbiddenError("You cannot invite someone into that role");
  const email = input.email.toLowerCase().trim();
  const token = newToken();
  const invite = await prisma.invite.create({
    data: {
      organizationId: ctx.organizationId,
      email,
      name: input.name?.trim() || null,
      role: input.role,
      tokenHash: hashToken(token),
      invitedById: ctx.user.id,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    },
  });
  const url = appUrl(`/invite/${token}`);
  await sendEmail({
    to: email,
    subject: `${ctx.user.name} invited you to ${ctx.org.name}`,
    organizationId: ctx.organizationId,
    html: emailShell(
      "You have work waiting",
      `<p>${escapeHtml(ctx.user.name)} invited you to <strong>${escapeHtml(ctx.org.name)}</strong> on Karm Karo.</p><p><a href="${url}">Accept the invite</a></p>`,
    ),
  });
  await audit(ctx, "member.invited", "invite", invite.id, { email, role: input.role });
  return { id: invite.id, email, url: emailLinksExposed() ? url : undefined };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

export async function inviteCsv(ctx: AppContext, csv: string) {
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const start = lines[0]?.toLowerCase().includes("email") ? 1 : 0;
  const results = [];
  for (const line of lines.slice(start)) {
    const [email, name, roleRaw] = line.split(",").map((part) => part?.trim() ?? "");
    if (!email.includes("@")) continue;
    const role = roleRaw.toUpperCase() === "ADMIN" ? "ADMIN" : "EMPLOYEE";
    results.push(await invitePerson(ctx, { email, name, role }));
  }
  return results;
}

export async function previewInvite(token: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { organization: true },
  });
  if (!invite || invite.status !== "PENDING" || invite.expiresAt < new Date()) return null;
  return { email: invite.email, name: invite.name, organization: invite.organization.name, role: invite.role };
}

export async function acceptInvite(input: { token: string; name: string; password: string }) {
  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!invite || invite.status !== "PENDING" || invite.expiresAt < new Date()) {
    throw new NotFoundError("This invite is no longer valid");
  }
  const passwordHash = await hashPassword(input.password);
  const existing = await prisma.user.findUnique({ where: { email: invite.email } });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        name: input.name.trim(),
        email: invite.email,
        passwordHash,
        emailVerified: new Date(),
        activeOrganizationId: invite.organizationId,
      },
    }));
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, emailVerified: existing.emailVerified ?? new Date(), activeOrganizationId: invite.organizationId, name: existing.name || input.name },
    });
  }
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: invite.organizationId } },
    update: { active: true, role: invite.role },
    create: { userId: user.id, organizationId: invite.organizationId, role: invite.role, title: "Teammate" },
  });
  await prisma.invite.update({ where: { id: invite.id }, data: { status: "ACCEPTED", acceptedAt: new Date() } });
  return { email: user.email };
}

export async function updateMember(
  ctx: AppContext,
  userId: string,
  input: { role?: Role; active?: boolean; title?: string | null },
) {
  if (!can(ctx.role, "member.manage")) throw new ForbiddenError();
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId: ctx.organizationId },
    include: { user: true },
  });
  if (!membership) throw new NotFoundError();
  if (input.role && !canGrantRole(ctx.role, input.role)) throw new ForbiddenError("You cannot grant that role");
  if (input.role && membership.role === "SUPER_ADMIN" && ctx.role !== "SUPER_ADMIN") {
    throw new ForbiddenError("Only a super admin can change a super admin");
  }
  if (userId === ctx.user.id && input.role && input.role !== "SUPER_ADMIN" && ctx.role === "SUPER_ADMIN") {
    const supers = await prisma.membership.count({
      where: { organizationId: ctx.organizationId, role: "SUPER_ADMIN", active: true },
    });
    if (supers <= 1) throw new ForbiddenError("The workspace needs at least one super admin");
  }
  await prisma.membership.update({
    where: { id: membership.id },
    data: {
      role: input.role,
      active: input.active,
      title: input.title === undefined ? undefined : input.title,
    },
  });
  await audit(ctx, input.active === false ? "member.deactivated" : "member.role_changed", "user", userId, {
    role: input.role ?? membership.role,
    active: input.active ?? membership.active,
  });
}

export async function sendPasswordReset(ctx: AppContext, userId: string) {
  if (!can(ctx.role, "member.manage")) throw new ForbiddenError();
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId: ctx.organizationId },
    include: { user: true },
  });
  if (!membership) throw new NotFoundError();
  const token = newToken();
  await prisma.passwordReset.create({
    data: { userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  const url = appUrl(`/reset/${token}`);
  await sendEmail({
    to: membership.user.email,
    subject: "Reset your Karm Karo password",
    organizationId: ctx.organizationId,
    html: emailShell("Choose a new password", `<p><a href="${url}">Reset password</a>. This link lasts one hour.</p>`),
  });
  await audit(ctx, "member.password_reset", "user", userId, {});
  return { url: emailLinksExposed() ? url : undefined };
}

export async function updateSettings(
  ctx: AppContext,
  input: {
    name?: string;
    timezone?: string;
    workingDays?: number[];
    workStart?: string;
    workEnd?: string;
    notifyOnAssign?: boolean;
    emailOnAssign?: boolean;
    digestHour?: number;
    weeklyReportDay?: number;
    payrollDay?: number;
  },
) {
  if (!can(ctx.role, "org.settings")) throw new ForbiddenError();
  await prisma.organization.update({
    where: { id: ctx.organizationId },
    data: {
      name: input.name ? sanitizeText(input.name, 80) : undefined,
      timezone: input.timezone,
      workingDays: input.workingDays,
      workStart: input.workStart,
      workEnd: input.workEnd,
      notifyOnAssign: input.notifyOnAssign,
      emailOnAssign: input.emailOnAssign,
      digestHour: input.digestHour,
      weeklyReportDay: input.weeklyReportDay,
      payrollDay: input.payrollDay,
    },
  });
  await audit(ctx, "org.updated", "organization", ctx.organizationId, {});
}

export async function dashboard(ctx: AppContext) {
  if (!can(ctx.role, "reports.view")) throw new ForbiddenError();
  if (isDemoMode()) return demoDashboard();
  const tasks = await prisma.task.findMany({
    where: { organizationId: ctx.organizationId, deletedAt: null },
    select: {
      status: true,
      dueAt: true,
      completedAt: true,
      createdAt: true,
      assignees: { select: { userId: true } },
    },
  });
  const now = new Date();
  const open = tasks.filter((task) => task.status !== "DONE");
  const overdue = open.filter((task) => task.dueAt && task.dueAt < now);
  const done = tasks.filter((task) => task.status === "DONE");
  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    include: { user: true },
  });
  const perEmployee = members.map((member) => {
    const mine = tasks.filter((task) => task.assignees.some((item) => item.userId === member.userId));
    const mineOpen = mine.filter((task) => task.status !== "DONE");
    const mineDone = mine.filter((task) => task.status === "DONE");
    return {
      id: member.userId,
      name: member.user.name,
      open: mineOpen.length,
      done: mineDone.length,
      overdue: mineOpen.filter((task) => task.dueAt && task.dueAt < now).length,
      completionRate: mine.length ? Math.round((mineDone.length / mine.length) * 100) : 0,
    };
  });
  const weekly = Array.from({ length: 8 }, (_, index) => {
    const end = addDaysZoned(now, -7 * (7 - index), ctx.org.timezone);
    const start = addDaysZoned(end, -7, ctx.org.timezone);
    return {
      week: dayKey(start, ctx.org.timezone),
      completed: done.filter((task) => task.completedAt && task.completedAt >= start && task.completedAt < end).length,
      created: tasks.filter((task) => task.createdAt >= start && task.createdAt < end).length,
    };
  });
  return {
    totals: { tasks: tasks.length, open: open.length, done: done.length, overdue: overdue.length },
    completionRate: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0,
    perEmployee,
    weekly,
  };
}

export async function workload(ctx: AppContext) {
  if (!can(ctx.role, "reports.view")) throw new ForbiddenError();
  if (isDemoMode()) return demoWorkload();
  const now = new Date();
  const days = Array.from({ length: 7 }, (_, index) => addDaysZoned(startOfZonedDay(now, ctx.org.timezone), index, ctx.org.timezone));
  const tasks = await prisma.task.findMany({
    where: { organizationId: ctx.organizationId, deletedAt: null, status: { not: "DONE" }, dueAt: { not: null } },
    select: { dueAt: true, assignees: { select: { userId: true } } },
  });
  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    include: { user: true },
  });
  return {
    days: days.map((day) => dayKey(day, ctx.org.timezone)),
    rows: members.map((member) => ({
      id: member.userId,
      name: member.user.name,
      counts: days.map((day) => {
        const key = dayKey(day, ctx.org.timezone);
        return tasks.filter(
          (task) => task.dueAt && dayKey(task.dueAt, ctx.org.timezone) === key && task.assignees.some((item) => item.userId === member.userId),
        ).length;
      }),
    })),
  };
}

export async function report(ctx: AppContext, fromIso?: string, toIso?: string) {
  if (!can(ctx.role, "reports.view")) throw new ForbiddenError();
  if (isDemoMode()) return demoReport();
  const from = fromIso ? new Date(fromIso) : addDaysZoned(new Date(), -30, ctx.org.timezone);
  const to = toIso ? new Date(toIso) : new Date();
  const [tasks, projects, members] = await Promise.all([
    prisma.task.findMany({
      where: { organizationId: ctx.organizationId, deletedAt: null, createdAt: { lte: to } },
      include: { assignees: true, project: true },
    }),
    prisma.project.findMany({ where: { organizationId: ctx.organizationId } }),
    prisma.membership.findMany({ where: { organizationId: ctx.organizationId }, include: { user: true } }),
  ]);
  const inRange = (date: Date | null) => Boolean(date && date >= from && date <= to);
  const perEmployee = members.map((member) => {
    const mine = tasks.filter((task) => task.assignees.some((item) => item.userId === member.userId));
    const done = mine.filter((task) => task.completedAt && inRange(task.completedAt));
    const open = mine.filter((task) => task.status !== "DONE");
    const cycles = done
      .map((task) => (task.completedAt ? (task.completedAt.getTime() - task.createdAt.getTime()) / 36e5 : 0))
      .filter((hours) => hours > 0);
    return {
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      open: open.length,
      completed: done.length,
      overdue: open.filter((task) => task.dueAt && task.dueAt < new Date()).length,
      avgCycleHours: cycles.length ? Math.round(cycles.reduce((sum, hours) => sum + hours, 0) / cycles.length) : 0,
    };
  });
  const perProject = projects.map((project) => {
    const mine = tasks.filter((task) => task.projectId === project.id);
    return {
      name: project.name,
      open: mine.filter((task) => task.status !== "DONE").length,
      completed: mine.filter((task) => task.completedAt && inRange(task.completedAt)).length,
    };
  });
  return { from: from.toISOString(), to: to.toISOString(), perEmployee, perProject };
}

export function reportCsv(data: Awaited<ReturnType<typeof report>>) {
  const lines = ["name,email,role,open,completed,overdue,avg_cycle_hours"];
  for (const row of data.perEmployee) {
    lines.push([row.name, row.email, row.role, row.open, row.completed, row.overdue, row.avgCycleHours].map(csvCell).join(","));
  }
  return lines.join("\n");
}

function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function reportPdf(ctx: AppContext, data: Awaited<ReturnType<typeof report>>) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Karm Karo", { x: 48, y: 790, size: 12, font, color: rgb(0.91, 0.38, 0.04) });
  page.drawText(`${ctx.org.name} — team report`, { x: 48, y: 760, size: 22, font: bold, color: rgb(0.19, 0.18, 0.32) });
  page.drawText(`From ${data.from.slice(0, 10)} to ${data.to.slice(0, 10)}`, { x: 48, y: 736, size: 11, font });
  let y = 700;
  page.drawText("Person", { x: 48, y, size: 11, font: bold });
  page.drawText("Open", { x: 260, y, size: 11, font: bold });
  page.drawText("Done", { x: 320, y, size: 11, font: bold });
  page.drawText("Overdue", { x: 380, y, size: 11, font: bold });
  page.drawText("Avg hours", { x: 460, y, size: 11, font: bold });
  y -= 22;
  for (const row of data.perEmployee.slice(0, 24)) {
    page.drawText(row.name.slice(0, 28), { x: 48, y, size: 11, font });
    page.drawText(String(row.open), { x: 260, y, size: 11, font });
    page.drawText(String(row.completed), { x: 320, y, size: 11, font });
    page.drawText(String(row.overdue), { x: 380, y, size: 11, font });
    page.drawText(String(row.avgCycleHours), { x: 460, y, size: 11, font });
    y -= 18;
    if (y < 80) break;
  }
  return Buffer.from(await pdf.save());
}

export async function listAudit(ctx: AppContext) {
  if (!can(ctx.role, "audit.view")) throw new ForbiddenError();
  if (isDemoMode()) return demoAudit();
  const rows = await prisma.activityLog.findMany({
    where: { organizationId: ctx.organizationId },
    include: { actor: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: row.actor?.name ?? "System",
    ip: row.ip,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function employeeProfile(ctx: AppContext, userId: string) {
  if (!can(ctx.role, "reports.view") && userId !== ctx.user.id) throw new ForbiddenError();
  if (isDemoMode()) {
    const profile = demoEmployeeProfile(userId);
    if (!profile) throw new NotFoundError();
    return profile;
  }
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId: ctx.organizationId },
    include: { user: true },
  });
  if (!membership) throw new NotFoundError();
  const tasks = await prisma.task.findMany({
    where: {
      organizationId: ctx.organizationId,
      deletedAt: null,
      assignees: { some: { userId } },
    },
    orderBy: { dueAt: "asc" },
    take: 50,
  });
  const open = tasks.filter((task) => task.status !== "DONE");
  const done = tasks.filter((task) => task.status === "DONE");
  return {
    member: memberDTO(membership),
    open: open.length,
    done: done.length,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt?.toISOString() ?? null,
    })),
  };
}
