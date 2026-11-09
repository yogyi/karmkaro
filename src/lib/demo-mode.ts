import type { Bootstrap, TaskDTO } from "@/lib/dto";
import { computePay, monthLabel } from "@/lib/money";
import type { AppContext } from "@/lib/session";

/** Preview mode when Vercel has no Postgres yet. */
export function isDemoMode() {
  if (process.env.DEMO_MODE === "1") return true;
  if (process.env.DEMO_MODE === "0") return false;
  return !process.env.DATABASE_URL;
}

export const DEMO_PASSWORD = "KarmKaro#2026";

export const DEMO_USERS = [
  {
    id: "demo-user-aanya",
    name: "Aanya Sharma",
    email: "aanya.sharma@karmkaro.dev",
    role: "SUPER_ADMIN" as const,
    title: "Founder",
  },
  {
    id: "demo-user-arjun",
    name: "Arjun Mehta",
    email: "arjun.mehta@karmkaro.dev",
    role: "ADMIN" as const,
    title: "Studio manager",
  },
  {
    id: "demo-user-rahul",
    name: "Rahul Verma",
    email: "rahul.verma@karmkaro.dev",
    role: "EMPLOYEE" as const,
    title: "Designer",
  },
] as const;

const ORG = {
  id: "demo-org-indus",
  name: "Indus Collective",
  slug: "indus-collective",
  timezone: "Asia/Kolkata",
  workingDays: [1, 2, 3, 4, 5],
  workStart: "09:30",
  workEnd: "18:30",
  notifyOnAssign: true,
  emailOnAssign: true,
  digestHour: 8,
  weeklyReportDay: 1,
  payrollDay: 1,
  logoKey: null as string | null,
};

const LABELS = [
  { id: "demo-label-client", name: "client", color: "#e85d04" },
  { id: "demo-label-design", name: "design", color: "#312e81" },
  { id: "demo-label-finance", name: "finance", color: "#0f766e" },
];

const PROJECTS = [
  {
    id: "demo-project-client",
    name: "Client Delivery",
    description: "Active client work",
    color: "#e85d04",
    archivedAt: null,
    position: 0,
    sections: [
      { id: "demo-section-todo", name: "To do", position: 0 },
      { id: "demo-section-doing", name: "Doing", position: 1 },
    ],
    memberIds: DEMO_USERS.map((user) => user.id),
  },
  {
    id: "demo-project-festival",
    name: "Festival Campaign",
    description: null,
    color: "#7c3aed",
    archivedAt: null,
    position: 1,
    sections: [{ id: "demo-section-fest", name: "Ideas", position: 0 }],
    memberIds: DEMO_USERS.map((user) => user.id),
  },
];

export function findDemoUser(email: string) {
  return DEMO_USERS.find((user) => user.email === email.toLowerCase().trim()) ?? null;
}

export function demoAuthUser(email: string, password: string) {
  if (password !== DEMO_PASSWORD) return null;
  const user = findDemoUser(email);
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name, image: null };
}

export function demoContext(userId: string, ip = "demo"): AppContext | null {
  const user = DEMO_USERS.find((item) => item.id === userId);
  if (!user) return null;
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: "en",
      theme: "system",
      onboardingDone: true,
      image: null,
    },
    role: user.role,
    organizationId: ORG.id,
    org: { ...ORG },
    ip,
  };
}

export function demoBootstrap(userId: string): Bootstrap {
  const me = DEMO_USERS.find((item) => item.id === userId) ?? DEMO_USERS[0];
  return {
    me: {
      id: me.id,
      name: me.name,
      email: me.email,
      role: me.role,
      active: true,
      title: me.title,
      image: null,
      locale: "en",
      theme: "system",
      onboardingDone: true,
    },
    org: {
      id: ORG.id,
      name: ORG.name,
      slug: ORG.slug,
      timezone: ORG.timezone,
      workingDays: ORG.workingDays,
      workStart: ORG.workStart,
      workEnd: ORG.workEnd,
      notifyOnAssign: ORG.notifyOnAssign,
      emailOnAssign: ORG.emailOnAssign,
      digestHour: ORG.digestHour,
      weeklyReportDay: ORG.weeklyReportDay,
      payrollDay: ORG.payrollDay,
      hasLogo: false,
    },
    members: DEMO_USERS.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: true,
      title: user.title,
      image: null,
    })),
    projects: PROJECTS,
    labels: LABELS,
    notifications: [
      {
        id: "demo-note-1",
        type: "assign",
        title: "Preview workspace",
        body: "This is a frontend demo. Add DATABASE_URL later for a real database.",
        link: "/today",
        readAt: null,
        createdAt: new Date().toISOString(),
      },
    ],
    filters: [],
  };
}

function task(
  partial: Pick<TaskDTO, "id" | "title" | "priority" | "status" | "assigneeIds" | "labelIds"> &
    Partial<TaskDTO>,
): TaskDTO {
  const labels = LABELS.filter((label) => partial.labelIds.includes(label.id));
  return {
    description: null,
    dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    startAt: null,
    estimateMinutes: 60,
    trackedMinutes: 0,
    position: 0,
    projectId: "demo-project-client",
    sectionId: "demo-section-todo",
    parentId: null,
    reporterId: "demo-user-arjun",
    completedAt: null,
    labels,
    checklist: [],
    commentCount: 0,
    subtaskCount: 0,
    attachmentCount: 0,
    recurrence: null,
    ...partial,
  };
}

export function demoTasks(userId: string): TaskDTO[] {
  const all = [
    task({
      id: "demo-task-1",
      title: "Send the client report",
      priority: 1,
      status: "TODO",
      assigneeIds: ["demo-user-rahul"],
      labelIds: ["demo-label-client"],
      dueAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    }),
    task({
      id: "demo-task-2",
      title: "Revise the homepage hero",
      priority: 2,
      status: "IN_PROGRESS",
      assigneeIds: ["demo-user-rahul"],
      labelIds: ["demo-label-design"],
      sectionId: "demo-section-doing",
    }),
    task({
      id: "demo-task-3",
      title: "Review invoices",
      priority: 2,
      status: "TODO",
      assigneeIds: ["demo-user-arjun"],
      labelIds: ["demo-label-finance"],
    }),
    task({
      id: "demo-task-4",
      title: "Cut the marigold reel",
      priority: 3,
      status: "IN_REVIEW",
      assigneeIds: ["demo-user-rahul"],
      labelIds: ["demo-label-design", "demo-label-client"],
    }),
  ];
  const user = DEMO_USERS.find((item) => item.id === userId);
  if (!user || user.role === "EMPLOYEE") {
    return all.filter((item) => item.assigneeIds.includes(userId) || item.reporterId === userId);
  }
  return all;
}

export function demoTaskDetail(userId: string, taskId: string) {
  const found = demoTasks(userId).find((item) => item.id === taskId) ?? demoTasks("demo-user-aanya").find((item) => item.id === taskId);
  if (!found) return null;
  return {
    ...found,
    comments: [
      {
        id: "demo-comment-1",
        body: "Looks good for the preview — real data lands once Postgres is connected.",
        createdAt: new Date().toISOString(),
        user: { id: "demo-user-arjun", name: "Arjun Mehta", image: null },
      },
    ],
    attachments: [],
    activity: [],
  };
}

export function demoDashboard() {
  const tasks = demoTasks("demo-user-aanya");
  const open = tasks.filter((item) => item.status !== "DONE");
  return {
    totals: { tasks: tasks.length, open: open.length, done: 0, overdue: 0 },
    completionRate: 0,
    perEmployee: DEMO_USERS.map((user) => {
      const mine = tasks.filter((item) => item.assigneeIds.includes(user.id));
      return {
        id: user.id,
        name: user.name,
        open: mine.length,
        done: 0,
        overdue: 0,
        completionRate: 0,
      };
    }),
    weekly: Array.from({ length: 8 }, (_, index) => ({
      week: `W${index + 1}`,
      completed: index % 3,
      created: index % 4 + 1,
    })),
  };
}

export function demoWorkload() {
  return {
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    rows: DEMO_USERS.map((user) => ({
      id: user.id,
      name: user.name,
      counts: [1, 0, 2, 1, 0, 0, 0],
    })),
  };
}

export function demoPayDesk() {
  const now = new Date();
  return {
    people: DEMO_USERS.map((user) => {
      const pay = computePay({
        baseSalary: user.role === "EMPLOYEE" ? 45000 : 90000,
        hra: 12000,
        specialAllowance: 5000,
        pfDeduction: 1800,
        taxDeduction: 2000,
        otherDeduction: 0,
      });
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        title: user.title,
        role: user.role,
        profile: {
          id: `demo-salary-${user.id}`,
          userId: user.id,
          name: user.name,
          email: user.email,
          currency: "INR",
          ...pay,
          bankLast4: "4242",
          panMasked: "ABCDE****",
          notes: null,
          effectiveFrom: now.toISOString(),
          updatedAt: now.toISOString(),
        },
        thisMonthSlipId: null,
        thisMonthStatus: null,
      };
    }),
    current: {
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      label: monthLabel(now.getUTCFullYear(), now.getUTCMonth() + 1),
    },
  };
}

export function demoPayslips() {
  return [] as unknown[];
}

export function demoReport() {
  return {
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
    perEmployee: DEMO_USERS.map((user) => ({
      name: user.name,
      email: user.email,
      role: user.role,
      open: user.role === "EMPLOYEE" ? 3 : 1,
      completed: 0,
      overdue: 0,
      avgCycleHours: 0,
    })),
    perProject: PROJECTS.map((project) => ({
      name: project.name,
      open: 2,
      completed: 0,
    })),
  };
}

export function demoAudit() {
  return [
    {
      id: "demo-audit-1",
      action: "auth.login",
      entityType: "user",
      entityId: "demo-user-aanya",
      actor: "Aanya Sharma",
      ip: "demo",
      metadata: null,
      createdAt: new Date().toISOString(),
    },
  ];
}

export function demoEmployeeProfile(userId: string) {
  const user = DEMO_USERS.find((item) => item.id === userId);
  if (!user) return null;
  const tasks = demoTasks(userId);
  return {
    member: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: true,
      title: user.title,
      image: null,
    },
    open: tasks.filter((item) => item.status !== "DONE").length,
    done: 0,
    tasks: tasks.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      dueAt: item.dueAt,
    })),
  };
}
