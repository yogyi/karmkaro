import { headers } from "next/headers";
import type { Role } from "@/generated/prisma/client";
import { auth } from "./auth";
import { demoContext, isDemoMode } from "./demo-mode";
import { AuthError } from "./errors";
import { prisma } from "./prisma";

export type AppContext = {
  user: {
    id: string;
    name: string;
    email: string;
    locale: string;
    theme: string;
    onboardingDone: boolean;
    image: string | null;
  };
  role: Role;
  organizationId: string;
  org: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    workingDays: number[];
    workStart: string;
    workEnd: string;
    notifyOnAssign: boolean;
    emailOnAssign: boolean;
    digestHour: number;
    weeklyReportDay: number;
    payrollDay: number;
    logoKey: string | null;
  };
  ip: string;
};

export async function getContext(): Promise<AppContext | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

  if (isDemoMode()) {
    const headerList = await headers();
    const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    return demoContext(userId, ip);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const memberships = await prisma.membership.findMany({
    where: { userId, active: true },
    include: { organization: true },
    orderBy: { updatedAt: "desc" },
  });
  const membership =
    memberships.find((item) => item.organizationId === user.activeOrganizationId) ?? memberships[0];
  if (!membership) return null;
  const headerList = await headers();
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: user.locale === "hi" ? "hi" : "en",
      theme: user.theme,
      onboardingDone: user.onboardingDone,
      image: user.image,
    },
    role: membership.role,
    organizationId: membership.organizationId,
    org: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
      timezone: membership.organization.timezone,
      workingDays: membership.organization.workingDays,
      workStart: membership.organization.workStart,
      workEnd: membership.organization.workEnd,
      notifyOnAssign: membership.organization.notifyOnAssign,
      emailOnAssign: membership.organization.emailOnAssign,
      digestHour: membership.organization.digestHour,
      weeklyReportDay: membership.organization.weeklyReportDay,
      payrollDay: membership.organization.payrollDay,
      logoKey: membership.organization.logoKey,
    },
    ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim() || "local",
  };
}

export async function requireContext() {
  const context = await getContext();
  if (!context) throw new AuthError();
  return context;
}
