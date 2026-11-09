import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { demoPayDesk, demoPayslips, isDemoMode } from "@/lib/demo-mode";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { appUrl, emailLinksExposed, emailShell, sendEmail } from "@/lib/email";
import { computePay, formatInr, formatInrPlain, monthLabel } from "@/lib/money";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { sanitizeText } from "@/lib/sanitize";
import type { AppContext } from "@/lib/session";
import { audit, notifyUser } from "./notify";

/** Keep about one year of slips online. */
export const PAYSLIP_RETENTION_MONTHS = 12;

export function payslipWindowStart(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startMonth = month - (PAYSLIP_RETENTION_MONTHS - 1);
  if (startMonth > 0) return { year, month: startMonth };
  return { year: year - 1, month: startMonth + 12 };
}

function inRetentionWindow(year: number, month: number, now = new Date()) {
  const start = payslipWindowStart(now);
  if (year > start.year) return true;
  if (year < start.year) return false;
  return month >= start.month;
}

export type SalaryInput = {
  baseSalary: number;
  hra?: number;
  specialAllowance?: number;
  pfDeduction?: number;
  taxDeduction?: number;
  otherDeduction?: number;
  bankLast4?: string | null;
  panMasked?: string | null;
  notes?: string | null;
  effectiveFrom?: string;
};

function toProfile(row: {
  id: string;
  userId: string;
  currency: string;
  baseSalary: number;
  hra: number;
  specialAllowance: number;
  pfDeduction: number;
  taxDeduction: number;
  otherDeduction: number;
  bankLast4: string | null;
  panMasked: string | null;
  notes: string | null;
  effectiveFrom: Date;
  updatedAt: Date;
  user?: { name: string; email: string };
}) {
  const totals = computePay(row);
  return {
    id: row.id,
    userId: row.userId,
    name: row.user?.name,
    email: row.user?.email,
    currency: row.currency,
    ...totals,
    bankLast4: row.bankLast4,
    panMasked: row.panMasked,
    notes: row.notes,
    effectiveFrom: row.effectiveFrom.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSlip(row: {
  id: string;
  userId: string;
  year: number;
  month: number;
  currency: string;
  baseSalary: number;
  hra: number;
  specialAllowance: number;
  gross: number;
  pfDeduction: number;
  taxDeduction: number;
  otherDeduction: number;
  totalDeductions: number;
  netPay: number;
  bankLast4: string | null;
  panMasked: string | null;
  status: string;
  notes: string | null;
  emailedAt: Date | null;
  createdAt: Date;
  user?: { name: string; email: string };
}) {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user?.name,
    email: row.user?.email,
    year: row.year,
    month: row.month,
    periodLabel: monthLabel(row.year, row.month),
    currency: row.currency,
    baseSalary: row.baseSalary,
    hra: row.hra,
    specialAllowance: row.specialAllowance,
    gross: row.gross,
    pfDeduction: row.pfDeduction,
    taxDeduction: row.taxDeduction,
    otherDeduction: row.otherDeduction,
    totalDeductions: row.totalDeductions,
    netPay: row.netPay,
    bankLast4: row.bankLast4,
    panMasked: row.panMasked,
    status: row.status,
    notes: row.notes,
    emailedAt: row.emailedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listPayDesk(ctx: AppContext) {
  if (!can(ctx.role, "pay.manage")) throw new ForbiddenError();
  if (isDemoMode()) return demoPayDesk();
  const members = await prisma.membership.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    include: { user: true },
    orderBy: { user: { name: "asc" } },
  });
  const profiles = await prisma.salaryProfile.findMany({
    where: { organizationId: ctx.organizationId },
    include: { user: true },
  });
  const byUser = new Map(profiles.map((profile) => [profile.userId, profile]));
  const now = new Date();
  const slips = await prisma.payslip.findMany({
    where: { organizationId: ctx.organizationId, year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 },
  });
  const slipByUser = new Map(slips.map((slip) => [slip.userId, slip]));
  return {
    people: members.map((member) => {
      const profile = byUser.get(member.userId);
      const slip = slipByUser.get(member.userId);
      return {
        id: member.userId,
        name: member.user.name,
        email: member.user.email,
        title: member.title,
        role: member.role,
        profile: profile ? toProfile(profile) : null,
        thisMonthSlipId: slip?.id ?? null,
        thisMonthStatus: slip?.status ?? null,
      };
    }),
    current: { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, label: monthLabel(now.getUTCFullYear(), now.getUTCMonth() + 1) },
  };
}

export async function upsertSalary(ctx: AppContext, userId: string, input: SalaryInput) {
  if (!can(ctx.role, "pay.manage")) throw new ForbiddenError();
  const membership = await prisma.membership.findFirst({
    where: { organizationId: ctx.organizationId, userId, active: true },
  });
  if (!membership) throw new NotFoundError("That person is not in this workspace");
  const pay = computePay(input);
  if (pay.baseSalary <= 0) throw new AppError("Base salary must be greater than zero");
  const profile = await prisma.salaryProfile.upsert({
    where: { organizationId_userId: { organizationId: ctx.organizationId, userId } },
    create: {
      organizationId: ctx.organizationId,
      userId,
      ...pay,
      bankLast4: input.bankLast4 ? sanitizeText(input.bankLast4, 4) : null,
      panMasked: input.panMasked ? sanitizeText(input.panMasked, 12) : null,
      notes: input.notes ? sanitizeText(input.notes, 500) : null,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : new Date(),
    },
    update: {
      ...pay,
      bankLast4: input.bankLast4 === undefined ? undefined : input.bankLast4 ? sanitizeText(input.bankLast4, 4) : null,
      panMasked: input.panMasked === undefined ? undefined : input.panMasked ? sanitizeText(input.panMasked, 12) : null,
      notes: input.notes === undefined ? undefined : input.notes ? sanitizeText(input.notes, 500) : null,
      effectiveFrom: input.effectiveFrom ? new Date(input.effectiveFrom) : undefined,
    },
    include: { user: true },
  });
  await audit(ctx, "pay.profile_saved", "salary", profile.id, { userId, netPay: pay.netPay });
  return toProfile(profile);
}

export async function generatePayslips(ctx: AppContext, input: { year: number; month: number; userIds?: string[] }) {
  if (!can(ctx.role, "pay.manage")) throw new ForbiddenError();
  if (input.month < 1 || input.month > 12) throw new AppError("Pick a real month");
  const where = {
    organizationId: ctx.organizationId,
    ...(input.userIds?.length ? { userId: { in: input.userIds } } : {}),
  };
  const profiles = await prisma.salaryProfile.findMany({ where, include: { user: true } });
  if (!profiles.length) throw new NotFoundError("Set salary packages before generating slips");
  const created = [];
  for (const profile of profiles) {
    const pay = computePay(profile);
    const slip = await prisma.payslip.upsert({
      where: {
        organizationId_userId_year_month: {
          organizationId: ctx.organizationId,
          userId: profile.userId,
          year: input.year,
          month: input.month,
        },
      },
      create: {
        organizationId: ctx.organizationId,
        userId: profile.userId,
        generatedById: ctx.user.id,
        year: input.year,
        month: input.month,
        currency: profile.currency,
        ...pay,
        bankLast4: profile.bankLast4,
        panMasked: profile.panMasked,
        status: "DRAFT",
      },
      update: {
        generatedById: ctx.user.id,
        currency: profile.currency,
        ...pay,
        bankLast4: profile.bankLast4,
        panMasked: profile.panMasked,
        // Keep emailed slips emailed; otherwise reset to draft so managers can edit before send.
        status: "DRAFT",
        emailedAt: null,
      },
      include: { user: true },
    });
    created.push(toSlip(slip));
  }
  await audit(ctx, "pay.slips_generated", "payslip", null, { year: input.year, month: input.month, count: created.length });
  return { slips: created, count: created.length };
}

function slipHtml(orgName: string, slip: ReturnType<typeof toSlip>) {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#57534e">${label}</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600">${value}</td></tr>`;
  return emailShell(
    `Salary slip · ${slip.periodLabel}`,
    `
      <p style="margin:0 0 16px">${orgName}</p>
      <p style="margin:0 0 4px"><strong>${slip.name}</strong></p>
      <p style="margin:0 0 16px;color:#57534e">${slip.email}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row("Basic", formatInr(slip.baseSalary))}
        ${row("HRA", formatInr(slip.hra))}
        ${row("Special allowance", formatInr(slip.specialAllowance))}
        ${row("Gross pay", formatInr(slip.gross))}
        ${row("PF", `− ${formatInr(slip.pfDeduction)}`)}
        ${row("Tax", `− ${formatInr(slip.taxDeduction)}`)}
        ${row("Other deductions", `− ${formatInr(slip.otherDeduction)}`)}
        ${row("Net pay", formatInr(slip.netPay))}
      </table>
      ${slip.bankLast4 ? `<p style="margin:16px 0 0;color:#57534e;font-size:13px">Credited to account ending ${slip.bankLast4}</p>` : ""}
      <p style="margin:20px 0 0"><a href="${appUrl(`/pay?slip=${slip.id}`)}" style="display:inline-block;background:#c2410c;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">Open in Karm Karo</a></p>
    `,
  );
}

export async function updatePayslip(
  ctx: AppContext,
  slipId: string,
  input: {
    baseSalary?: number;
    hra?: number;
    specialAllowance?: number;
    pfDeduction?: number;
    taxDeduction?: number;
    otherDeduction?: number;
    bankLast4?: string | null;
    notes?: string | null;
  },
) {
  if (!can(ctx.role, "pay.manage")) throw new ForbiddenError();
  const slip = await prisma.payslip.findFirst({
    where: { id: slipId, organizationId: ctx.organizationId },
  });
  if (!slip) throw new NotFoundError();
  const pay = computePay({
    baseSalary: input.baseSalary ?? slip.baseSalary,
    hra: input.hra ?? slip.hra,
    specialAllowance: input.specialAllowance ?? slip.specialAllowance,
    pfDeduction: input.pfDeduction ?? slip.pfDeduction,
    taxDeduction: input.taxDeduction ?? slip.taxDeduction,
    otherDeduction: input.otherDeduction ?? slip.otherDeduction,
  });
  if (pay.baseSalary <= 0) throw new AppError("Base salary must be greater than zero");
  const updated = await prisma.payslip.update({
    where: { id: slip.id },
    data: {
      ...pay,
      bankLast4: input.bankLast4 === undefined ? undefined : input.bankLast4 ? sanitizeText(input.bankLast4, 4) : null,
      notes: input.notes === undefined ? undefined : input.notes ? sanitizeText(input.notes, 500) : null,
      status: slip.status === "EMAILED" ? "DRAFT" : slip.status === "ISSUED" ? "DRAFT" : slip.status,
      emailedAt: null,
    },
    include: { user: true },
  });
  await audit(ctx, "pay.slip_edited", "payslip", slip.id, { userId: slip.userId, netPay: pay.netPay });
  return toSlip(updated);
}

export async function deletePayslip(ctx: AppContext, slipId: string) {
  if (!can(ctx.role, "pay.manage")) throw new ForbiddenError();
  const slip = await prisma.payslip.findFirst({
    where: { id: slipId, organizationId: ctx.organizationId },
  });
  if (!slip) throw new NotFoundError();
  await prisma.payslip.delete({ where: { id: slip.id } });
  await audit(ctx, "pay.slip_removed", "payslip", slip.id, { userId: slip.userId, year: slip.year, month: slip.month });
  return { ok: true };
}

export async function emailPayslip(ctx: AppContext, slipId: string) {
  const slip = await prisma.payslip.findFirst({
    where: { id: slipId, organizationId: ctx.organizationId },
    include: { user: true },
  });
  if (!slip) throw new NotFoundError();
  if (!can(ctx.role, "pay.manage") && slip.userId !== ctx.user.id) throw new ForbiddenError();
  const dto = toSlip(slip);
  await sendEmail({
    to: slip.user.email,
    subject: `${ctx.org.name} salary slip · ${dto.periodLabel}`,
    organizationId: ctx.organizationId,
    html: slipHtml(ctx.org.name, dto),
  });
  const updated = await prisma.payslip.update({
    where: { id: slip.id },
    data: { status: "EMAILED", emailedAt: new Date() },
    include: { user: true },
  });
  await audit(ctx, "pay.slip_emailed", "payslip", slip.id, { userId: slip.userId, year: slip.year, month: slip.month });
  await notifyUser(ctx, slip.userId, {
    type: "pay.email",
    title: "Salary slip emailed",
    body: `We sent your ${dto.periodLabel} slip to ${slip.user.email}.`,
    link: appUrl(`/pay?slip=${slip.id}`),
    email: false,
  });
  return {
    slip: toSlip(updated),
    ...(emailLinksExposed() ? { note: "No email provider is configured. The slip HTML is stored in EmailOutbox." } : {}),
  };
}

export async function emailPayslipsForMonth(
  ctx: AppContext,
  year: number,
  month: number,
  userIds?: string[],
) {
  if (!can(ctx.role, "pay.manage")) throw new ForbiddenError();
  const slips = await prisma.payslip.findMany({
    where: {
      organizationId: ctx.organizationId,
      year,
      month,
      ...(userIds?.length ? { userId: { in: userIds } } : {}),
      status: { in: ["DRAFT", "ISSUED"] },
    },
    select: { id: true },
  });
  const results = [];
  for (const slip of slips) results.push(await emailPayslip(ctx, slip.id));
  return { count: results.length, results };
}

export async function listMyPayslips(ctx: AppContext) {
  if (isDemoMode()) return demoPayslips();
  const start = payslipWindowStart();
  const whereWindow = {
    OR: [
      { year: { gt: start.year } },
      { year: start.year, month: { gte: start.month } },
    ],
  };
  if (can(ctx.role, "pay.manage")) {
    const slips = await prisma.payslip.findMany({
      where: { organizationId: ctx.organizationId, AND: [whereWindow] },
      include: { user: true },
      orderBy: [{ year: "desc" }, { month: "desc" }, { user: { name: "asc" } }],
      take: 200,
    });
    return slips.map(toSlip);
  }
  const slips = await prisma.payslip.findMany({
    where: { organizationId: ctx.organizationId, userId: ctx.user.id, AND: [whereWindow] },
    include: { user: true },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: PAYSLIP_RETENTION_MONTHS,
  });
  return slips.map(toSlip);
}

export async function getPayslip(ctx: AppContext, id: string) {
  const slip = await prisma.payslip.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { user: true },
  });
  if (!slip) throw new NotFoundError();
  if (!can(ctx.role, "pay.manage") && slip.userId !== ctx.user.id) throw new ForbiddenError();
  return toSlip(slip);
}

export async function payslipPdf(ctx: AppContext, id: string) {
  const slipRow = await prisma.payslip.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { user: true },
  });
  if (!slipRow) throw new NotFoundError();
  if (!can(ctx.role, "pay.manage") && slipRow.userId !== ctx.user.id) throw new ForbiddenError();
  if (!inRetentionWindow(slipRow.year, slipRow.month) && !can(ctx.role, "pay.manage")) {
    throw new ForbiddenError("That slip is outside the one-year history");
  }
  const slip = toSlip(slipRow);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const draw = (text: string, x: number, y: number, size = 12, useBold = false) => {
    page.drawText(text, {
      x,
      y,
      size,
      font: useBold ? bold : font,
      color: useBold ? rgb(0.1, 0.09, 0.2) : rgb(0.15, 0.14, 0.13),
    });
  };
  draw("Karm Karo", 48, 790, 12, true);
  page.drawText("Salary slip", { x: 48, y: 770, size: 11, font, color: rgb(0.76, 0.25, 0.05) });
  draw(ctx.org.name, 48, 742, 20, true);
  draw(slip.periodLabel, 48, 716, 14, true);
  draw(slip.name ?? slipRow.user.name, 48, 688, 13, true);
  draw(slip.email ?? slipRow.user.email, 48, 670, 11);
  const lines: [string, string][] = [
    ["Basic", formatInrPlain(slip.baseSalary)],
    ["HRA", formatInrPlain(slip.hra)],
    ["Special allowance", formatInrPlain(slip.specialAllowance)],
    ["Gross pay", formatInrPlain(slip.gross)],
    ["PF", `- ${formatInrPlain(slip.pfDeduction)}`],
    ["Tax", `- ${formatInrPlain(slip.taxDeduction)}`],
    ["Other deductions", `- ${formatInrPlain(slip.otherDeduction)}`],
    ["Total deductions", `- ${formatInrPlain(slip.totalDeductions)}`],
    ["Net pay", formatInrPlain(slip.netPay)],
  ];
  let y = 630;
  for (const [label, value] of lines) {
    draw(label, 48, y, 12);
    draw(value, 360, y, 12, label === "Net pay" || label === "Gross pay");
    y -= 24;
  }
  if (slip.bankLast4) draw(`Bank account ending ${slip.bankLast4}`, 48, y - 12, 11);
  draw(`Generated for ${ctx.org.name}`, 48, 64, 10);
  return {
    bytes: Buffer.from(await pdf.save()),
    filename: `salary-slip-${(slip.name ?? "employee").toLowerCase().replace(/\s+/g, "-")}-${slip.year}-${String(slip.month).padStart(2, "0")}.pdf`,
  };
}

export async function pruneOldPayslips() {
  const start = payslipWindowStart();
  const deleted = await prisma.payslip.deleteMany({
    where: {
      OR: [{ year: { lt: start.year } }, { year: start.year, month: { lt: start.month } }],
    },
  });
  return deleted.count;
}
