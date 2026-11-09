import type { Prisma, TaskStatus } from "@/generated/prisma/client";
import { demoTaskDetail, demoTasks, isDemoMode } from "@/lib/demo-mode";
import type { TaskDTO } from "@/lib/dto";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { parseFilter, taskMatches, type FilterTask } from "@/lib/filter-query";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { nextOccurrence, type RecurrenceDraft } from "@/lib/recurrence";
import { sanitizeText } from "@/lib/sanitize";
import type { AppContext } from "@/lib/session";
import { appUrl } from "@/lib/email";
import { endOfZonedDay, startOfZonedDay } from "@/lib/zoned";
import type { TaskWrite } from "@/lib/validators";
import { audit, mentionsIn, notifyUser } from "./notify";

const taskInclude = {
  assignees: true,
  labels: { include: { label: true } },
  checklist: { orderBy: { position: "asc" as const } },
  recurrence: true,
  _count: { select: { comments: true, children: true, attachments: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export function toTaskDTO(task: TaskRow): TaskDTO {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    dueAt: task.dueAt?.toISOString() ?? null,
    startAt: task.startAt?.toISOString() ?? null,
    estimateMinutes: task.estimateMinutes,
    trackedMinutes: task.trackedMinutes,
    position: task.position,
    projectId: task.projectId,
    sectionId: task.sectionId,
    parentId: task.parentId,
    reporterId: task.reporterId,
    completedAt: task.completedAt?.toISOString() ?? null,
    assigneeIds: task.assignees.map((item) => item.userId),
    labelIds: task.labels.map((item) => item.labelId),
    labels: task.labels.map((item) => ({ id: item.label.id, name: item.label.name, color: item.label.color })),
    checklist: task.checklist.map((item) => ({
      id: item.id,
      title: item.title,
      done: item.done,
      position: item.position,
    })),
    commentCount: task._count.comments,
    subtaskCount: task._count.children,
    attachmentCount: task._count.attachments,
    recurrence: task.recurrence
      ? {
          frequency: task.recurrence.frequency,
          interval: task.recurrence.interval,
          byWeekday: task.recurrence.byWeekday,
          ordinal: task.recurrence.ordinal,
          customText: task.recurrence.customText,
        }
      : null,
  };
}

function visibility(ctx: AppContext): Prisma.TaskWhereInput {
  if (can(ctx.role, "task.readAll")) return {};
  return {
    OR: [
      { reporterId: ctx.user.id },
      { assignees: { some: { userId: ctx.user.id } } },
      { project: { members: { some: { userId: ctx.user.id } } } },
    ],
  };
}

function viewFilter(view: string | undefined, ctx: AppContext, projectId?: string | null): Prisma.TaskWhereInput {
  const now = new Date();
  const start = startOfZonedDay(now, ctx.org.timezone);
  const end = endOfZonedDay(now, ctx.org.timezone);
  if (view === "inbox") return { projectId: null, status: { not: "DONE" } };
  if (view === "today") {
    return { status: { not: "DONE" }, OR: [{ dueAt: { gte: start, lte: end } }, { dueAt: { lt: now } }] };
  }
  if (view === "overdue") return { status: { not: "DONE" }, dueAt: { lt: now } };
  if (view === "upcoming") return { status: { not: "DONE" }, dueAt: { gt: end } };
  if (view === "completed") return { status: "DONE" };
  if (view === "assigned") return { status: { not: "DONE" }, assignees: { some: { userId: ctx.user.id } } };
  if (view === "project" && projectId) return { projectId };
  return {};
}

export async function listTasks(
  ctx: AppContext,
  query: { view?: string; projectId?: string; q?: string; filter?: string; parentId?: string },
) {
  if (isDemoMode()) {
    let tasks = demoTasks(ctx.user.id);
    if (query.view === "today") {
      const end = endOfZonedDay(new Date(), ctx.org.timezone);
      tasks = tasks.filter((item) => item.status !== "DONE" && item.dueAt && new Date(item.dueAt) <= end);
    } else if (query.view === "assigned") {
      tasks = tasks.filter((item) => item.status !== "DONE" && item.assigneeIds.includes(ctx.user.id));
    } else if (query.view === "completed") {
      tasks = tasks.filter((item) => item.status === "DONE");
    } else if (query.view === "inbox") {
      tasks = tasks.filter((item) => !item.projectId && item.status !== "DONE");
    } else if (query.view === "project" && query.projectId) {
      tasks = tasks.filter((item) => item.projectId === query.projectId);
    } else if (query.view === "overdue") {
      const now = new Date();
      tasks = tasks.filter((item) => item.status !== "DONE" && item.dueAt && new Date(item.dueAt) < now);
    } else if (query.view === "upcoming") {
      const end = endOfZonedDay(new Date(), ctx.org.timezone);
      tasks = tasks.filter((item) => item.status !== "DONE" && item.dueAt && new Date(item.dueAt) > end);
    }
    if (query.q) {
      const needle = query.q.toLowerCase();
      tasks = tasks.filter(
        (item) => item.title.toLowerCase().includes(needle) || (item.description ?? "").toLowerCase().includes(needle),
      );
    }
    return tasks;
  }
  const search: Prisma.TaskWhereInput = query.q
    ? {
        OR: [
          { title: { contains: query.q, mode: "insensitive" } },
          { description: { contains: query.q, mode: "insensitive" } },
        ],
      }
    : {};
  const rows = await prisma.task.findMany({
    where: {
      organizationId: ctx.organizationId,
      deletedAt: null,
      ...(query.parentId ? { parentId: query.parentId } : {}),
      AND: [visibility(ctx), viewFilter(query.view, ctx, query.projectId), search],
    },
    include: taskInclude,
    orderBy: query.view === "completed" ? [{ completedAt: "desc" }] : [{ position: "asc" }, { dueAt: "asc" }],
    take: 500,
  });
  let tasks = rows.map(toTaskDTO);
  if (query.filter) {
    const members = await prisma.membership.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: true },
    });
    const names: Record<string, string> = {};
    for (const member of members) names[member.user.name.toLowerCase()] = member.userId;
    const node = parseFilter(query.filter);
    tasks = tasks.filter((task) => {
      const shaped: FilterTask = {
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        dueAt: task.dueAt,
        assigneeIds: task.assigneeIds,
        labelNames: task.labels.map((label) => label.name),
        projectName: null,
      };
      return taskMatches(shaped, node, { meId: ctx.user.id, now: new Date(), timeZone: ctx.org.timezone, memberIdsByName: names });
    });
  }
  return tasks;
}

async function loadTask(ctx: AppContext, id: string) {
  const task = await prisma.task.findFirst({
    where: { id, organizationId: ctx.organizationId, deletedAt: null, AND: [visibility(ctx)] },
    include: taskInclude,
  });
  if (!task) throw new NotFoundError();
  return task;
}

function canEdit(ctx: AppContext, task: TaskRow) {
  if (can(ctx.role, "task.deleteAny") || can(ctx.role, "task.readAll")) return true;
  return task.reporterId === ctx.user.id || task.assignees.some((item) => item.userId === ctx.user.id);
}

async function assertAssignees(ctx: AppContext, assigneeIds: string[]) {
  if (!assigneeIds.length) return;
  if (!can(ctx.role, "task.assignOthers") && assigneeIds.some((id) => id !== ctx.user.id)) {
    throw new ForbiddenError("You can assign work only to yourself");
  }
  const count = await prisma.membership.count({
    where: { organizationId: ctx.organizationId, userId: { in: assigneeIds }, active: true },
  });
  if (count !== new Set(assigneeIds).size) throw new ForbiddenError("One of those people is not in this workspace");
}

async function resolveLabels(ctx: AppContext, labelIds: string[] = [], labelNames: string[] = []) {
  const ids = new Set(labelIds);
  if (labelIds.length) {
    const existing = await prisma.label.findMany({
      where: { organizationId: ctx.organizationId, id: { in: labelIds } },
    });
    if (existing.length !== new Set(labelIds).size) throw new ForbiddenError("Unknown label");
  }
  for (const name of labelNames) {
    const clean = sanitizeText(name, 40).toLowerCase();
    if (!clean) continue;
    const found = await prisma.label.findFirst({
      where: { organizationId: ctx.organizationId, name: { equals: clean, mode: "insensitive" } },
    });
    if (found) ids.add(found.id);
    else if (can(ctx.role, "project.manage")) {
      const created = await prisma.label.create({
        data: { organizationId: ctx.organizationId, name: clean, color: "#312e81" },
      });
      ids.add(created.id);
    }
  }
  return [...ids];
}

async function assertProject(ctx: AppContext, projectId?: string | null, sectionId?: string | null) {
  if (!projectId) return;
  const project = await prisma.project.findFirst({
    where: { id: projectId, organizationId: ctx.organizationId, archivedAt: null },
  });
  if (!project) throw new NotFoundError("That project is not in this workspace");
  if (!can(ctx.role, "task.readAll")) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: ctx.user.id } },
    });
    if (!member && ctx.role === "EMPLOYEE") throw new ForbiddenError("You are not on that project");
  }
  if (sectionId) {
    const section = await prisma.section.findFirst({ where: { id: sectionId, projectId } });
    if (!section) throw new NotFoundError("That section is not in the project");
  }
}

export async function createTask(ctx: AppContext, input: TaskWrite) {
  const assigneeIds = input.assigneeIds?.length ? [...new Set(input.assigneeIds)] : [ctx.user.id];
  await assertAssignees(ctx, assigneeIds);
  await assertProject(ctx, input.projectId, input.sectionId);
  if (input.parentId) {
    await loadTask(ctx, input.parentId);
  }
  const labelIds = await resolveLabels(ctx, input.labelIds, input.labelNames);
  const position =
    (
      await prisma.task.aggregate({
        where: { organizationId: ctx.organizationId, projectId: input.projectId ?? null },
        _max: { position: true },
      })
    )._max.position ?? 0;

  const task = await prisma.task.create({
    data: {
      organizationId: ctx.organizationId,
      title: sanitizeText(input.title, 200),
      description: input.description ? sanitizeText(input.description) : null,
      status: input.status ?? "TODO",
      priority: input.priority ?? 4,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      startAt: input.startAt ? new Date(input.startAt) : null,
      estimateMinutes: input.estimateMinutes ?? null,
      projectId: input.projectId ?? null,
      sectionId: input.sectionId ?? null,
      parentId: input.parentId ?? null,
      reporterId: ctx.user.id,
      position: position + 1,
      completedAt: input.status === "DONE" ? new Date() : null,
      assignees: { create: assigneeIds.map((userId) => ({ userId })) },
      labels: { create: labelIds.map((labelId) => ({ labelId })) },
      checklist: {
        create: (input.checklist ?? []).map((title, index) => ({ title: sanitizeText(title, 200), position: index })),
      },
    },
    include: taskInclude,
  });

  if (input.recurrence) await writeRecurrence(task.id, input.recurrence, task.dueAt, ctx.org.timezone);
  if (input.remind && task.dueAt) await writeReminder(task.id, assigneeIds, task.dueAt);

  const fresh = await loadTask(ctx, task.id);
  await audit(ctx, "task.created", "task", task.id, { title: task.title });
  await announceAssignment(ctx, fresh, []);
  return toTaskDTO(fresh);
}

async function writeRecurrence(taskId: string, rule: NonNullable<TaskWrite["recurrence"]>, dueAt: Date | null, timeZone: string) {
  const draft: RecurrenceDraft = {
    frequency: rule.frequency,
    interval: rule.interval ?? 1,
    byWeekday: rule.byWeekday ?? [],
    ordinal: rule.ordinal ?? null,
    customText: rule.customText ?? null,
  };
  const next = dueAt ?? nextOccurrence(draft, new Date(), timeZone);
  await prisma.recurringRule.create({
    data: {
      taskId,
      frequency: draft.frequency,
      interval: draft.interval,
      byWeekday: draft.byWeekday,
      ordinal: draft.ordinal,
      customText: draft.customText,
      timezone: timeZone,
      nextRunAt: next,
    },
  });
}

async function writeReminder(taskId: string, userIds: string[], dueAt: Date) {
  await prisma.reminder.createMany({
    data: userIds.flatMap((userId) => [
      { taskId, userId, remindAt: dueAt, channel: "IN_APP" as const },
      { taskId, userId, remindAt: dueAt, channel: "EMAIL" as const },
    ]),
  });
}

async function announceAssignment(ctx: AppContext, task: TaskRow, previous: string[]) {
  if (!ctx.org.notifyOnAssign) return;
  const added = task.assignees.map((item) => item.userId).filter((id) => id !== ctx.user.id && !previous.includes(id));
  for (const userId of added) {
    await notifyUser(ctx, userId, {
      type: "task.assigned",
      title: "A task is yours",
      body: `${ctx.user.name} assigned “${task.title}” to you.`,
      link: appUrl(`/assigned?task=${task.id}`),
      email: ctx.org.emailOnAssign,
    });
    await audit(ctx, "task.assigned", "task", task.id, { userId });
  }
}

export async function getTaskDetail(ctx: AppContext, id: string) {
  if (isDemoMode()) {
    const detail = demoTaskDetail(ctx.user.id, id);
    if (!detail) throw new NotFoundError();
    return {
      task: detail,
      comments: detail.comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        author: { id: comment.user.id, name: comment.user.name },
      })),
      children: [],
      attachments: [],
      activity: [],
    };
  }
  const task = await loadTask(ctx, id);
  const [comments, children, attachments, activity] = await Promise.all([
    prisma.comment.findMany({ where: { taskId: id }, include: { author: true }, orderBy: { createdAt: "asc" } }),
    prisma.task.findMany({
      where: { parentId: id, deletedAt: null, organizationId: ctx.organizationId, AND: [visibility(ctx)] },
      include: taskInclude,
      orderBy: { position: "asc" },
    }),
    prisma.attachment.findMany({ where: { taskId: id }, orderBy: { createdAt: "desc" } }),
    prisma.activityLog.findMany({
      where: { organizationId: ctx.organizationId, entityId: id },
      include: { actor: true },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
  ]);
  return {
    task: toTaskDTO(task),
    comments: comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      author: { id: comment.author.id, name: comment.author.name },
    })),
    children: children.map(toTaskDTO),
    attachments: attachments.map((file) => ({
      id: file.id,
      filename: file.filename,
      mime: file.mime,
      size: file.size,
      createdAt: file.createdAt.toISOString(),
    })),
    activity: activity.map((item) => ({
      id: item.id,
      action: item.action,
      createdAt: item.createdAt.toISOString(),
      actor: item.actor?.name ?? "System",
      metadata: item.metadata,
    })),
  };
}

export async function updateTask(ctx: AppContext, id: string, input: Partial<TaskWrite> & { trackedMinutes?: number }) {
  const current = await loadTask(ctx, id);
  if (!canEdit(ctx, current)) throw new ForbiddenError();
  if (input.assigneeIds) await assertAssignees(ctx, input.assigneeIds);
  if (input.projectId !== undefined || input.sectionId !== undefined) {
    await assertProject(ctx, input.projectId === undefined ? current.projectId : input.projectId, input.sectionId);
  }
  const previousAssignees = current.assignees.map((item) => item.userId);
  const nextStatus = (input.status ?? current.status) as TaskStatus;
  const completing = nextStatus === "DONE" && current.status !== "DONE";

  await prisma.task.update({
    where: { id },
    data: {
      title: input.title ? sanitizeText(input.title, 200) : undefined,
      description: input.description === undefined ? undefined : input.description ? sanitizeText(input.description) : null,
      status: input.status,
      priority: input.priority,
      dueAt: input.dueAt === undefined ? undefined : input.dueAt ? new Date(input.dueAt) : null,
      startAt: input.startAt === undefined ? undefined : input.startAt ? new Date(input.startAt) : null,
      estimateMinutes: input.estimateMinutes === undefined ? undefined : input.estimateMinutes,
      projectId: input.projectId === undefined ? undefined : input.projectId,
      sectionId: input.sectionId === undefined ? undefined : input.sectionId,
      completedAt: completing ? new Date() : input.status && input.status !== "DONE" ? null : undefined,
      trackedMinutes: input.trackedMinutes ? { increment: input.trackedMinutes } : undefined,
    },
  });

  if (input.trackedMinutes) {
    await prisma.timeEntry.create({
      data: { taskId: id, userId: ctx.user.id, minutes: input.trackedMinutes },
    });
  }
  if (input.assigneeIds) {
    await prisma.taskAssignee.deleteMany({ where: { taskId: id } });
    await prisma.taskAssignee.createMany({ data: input.assigneeIds.map((userId) => ({ taskId: id, userId })) });
  }
  if (input.labelIds || input.labelNames) {
    const labelIds = await resolveLabels(ctx, input.labelIds ?? current.labels.map((item) => item.labelId), input.labelNames);
    await prisma.taskLabel.deleteMany({ where: { taskId: id } });
    await prisma.taskLabel.createMany({ data: labelIds.map((labelId) => ({ taskId: id, labelId })) });
  }
  if (input.recurrence) {
    await prisma.recurringRule.deleteMany({ where: { taskId: id } });
    const due = input.dueAt ? new Date(input.dueAt) : current.dueAt;
    await writeRecurrence(id, input.recurrence, due, ctx.org.timezone);
  }

  let rolled: string | null = null;
  if (completing && current.recurrence) rolled = await rollRecurrence(ctx, current);
  const fresh = await loadTask(ctx, id);
  await audit(ctx, completing ? "task.completed" : "task.updated", "task", id, { title: fresh.title });
  if (input.assigneeIds) await announceAssignment(ctx, fresh, previousAssignees);
  return { task: toTaskDTO(fresh), rolled };
}

async function rollRecurrence(ctx: AppContext, task: TaskRow) {
  if (!task.recurrence) return null;
  const rule = task.recurrence;
  const draft: RecurrenceDraft = {
    frequency: rule.frequency as RecurrenceDraft["frequency"],
    interval: rule.interval,
    byWeekday: rule.byWeekday,
    ordinal: rule.ordinal,
    customText: rule.customText,
  };
  const due = nextOccurrence(draft, task.dueAt ?? new Date(), ctx.org.timezone);
  const created = await prisma.task.create({
    data: {
      organizationId: ctx.organizationId,
      title: task.title,
      description: task.description,
      priority: task.priority,
      projectId: task.projectId,
      sectionId: task.sectionId,
      reporterId: task.reporterId,
      dueAt: due,
      estimateMinutes: task.estimateMinutes,
      position: task.position,
      assignees: { create: task.assignees.map((item) => ({ userId: item.userId })) },
      labels: { create: task.labels.map((item) => ({ labelId: item.labelId })) },
      checklist: { create: task.checklist.map((item) => ({ title: item.title, position: item.position })) },
    },
  });
  await prisma.recurringRule.update({ where: { id: rule.id }, data: { taskId: created.id, nextRunAt: due } });
  return created.id;
}

export async function softDeleteTask(ctx: AppContext, id: string) {
  const task = await loadTask(ctx, id);
  if (!can(ctx.role, "task.deleteAny") && task.reporterId !== ctx.user.id) throw new ForbiddenError();
  await prisma.task.update({ where: { id }, data: { deletedAt: new Date() } });
  await audit(ctx, "task.deleted", "task", id, { title: task.title });
}

export async function addComment(ctx: AppContext, taskId: string, body: string) {
  await loadTask(ctx, taskId);
  const clean = sanitizeText(body, 8_000);
  const comment = await prisma.comment.create({
    data: { taskId, authorId: ctx.user.id, body: clean },
    include: { author: true },
  });
  await audit(ctx, "task.commented", "task", taskId, {});
  const mentioned = await mentionsIn(clean, ctx.organizationId);
  for (const userId of mentioned) {
    if (userId === ctx.user.id) continue;
    await notifyUser(ctx, userId, {
      type: "mention",
      title: `${ctx.user.name} mentioned you`,
      body: clean.slice(0, 180),
      link: appUrl(`/assigned?task=${taskId}`),
    });
  }
  return {
    id: comment.id,
    body: comment.body,
    createdAt: comment.createdAt.toISOString(),
    author: { id: comment.author.id, name: comment.author.name },
  };
}

export async function addChecklistItem(ctx: AppContext, taskId: string, title: string) {
  const task = await loadTask(ctx, taskId);
  if (!canEdit(ctx, task)) throw new ForbiddenError();
  const position = task.checklist.length;
  return prisma.checklistItem.create({
    data: { taskId, title: sanitizeText(title, 200), position },
  });
}

export async function toggleChecklist(ctx: AppContext, taskId: string, itemId: string, done: boolean) {
  const task = await loadTask(ctx, taskId);
  if (!canEdit(ctx, task)) throw new ForbiddenError();
  const item = await prisma.checklistItem.findFirst({ where: { id: itemId, taskId } });
  if (!item) throw new NotFoundError();
  return prisma.checklistItem.update({ where: { id: itemId }, data: { done } });
}

export async function reorderTasks(ctx: AppContext, ids: string[], status?: TaskStatus) {
  const rows = await prisma.task.findMany({
    where: { id: { in: ids }, organizationId: ctx.organizationId, deletedAt: null, AND: [visibility(ctx)] },
  });
  if (rows.length !== ids.length) throw new ForbiddenError();
  await prisma.$transaction(
    ids.map((id, index) =>
      prisma.task.update({
        where: { id },
        data: { position: index + 1, ...(status ? { status, completedAt: status === "DONE" ? new Date() : null } : {}) },
      }),
    ),
  );
}

export async function bulkUpdate(
  ctx: AppContext,
  ids: string[],
  patch: {
    status?: TaskStatus;
    priority?: number;
    assigneeIds?: string[];
    projectId?: string | null;
    dueAt?: string | null;
    deleted?: boolean;
  },
) {
  if (patch.deleted && !can(ctx.role, "task.deleteAny")) throw new ForbiddenError();
  if (patch.assigneeIds) await assertAssignees(ctx, patch.assigneeIds);
  const rows = await prisma.task.findMany({
    where: { id: { in: ids }, organizationId: ctx.organizationId, deletedAt: null, AND: [visibility(ctx)] },
    include: taskInclude,
  });
  if (rows.length !== ids.length) throw new ForbiddenError();
  for (const row of rows) {
    if (patch.deleted) await softDeleteTask(ctx, row.id);
    else {
      await updateTask(ctx, row.id, {
        status: patch.status,
        priority: patch.priority,
        assigneeIds: patch.assigneeIds,
        projectId: patch.projectId,
        dueAt: patch.dueAt,
      });
    }
  }
  return { updated: ids.length };
}
