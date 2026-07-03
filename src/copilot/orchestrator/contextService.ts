import { find as findTimezone } from "geo-tz";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";
import { messageRepository } from "../../api/repositories/message.repository";
import type { Message } from "../../types/conversation.types";
import type { ChatTurn } from "./graph/state";

/**
 * Assembles the per-conversation context the general copilot needs — technician
 * profile, current job + previous visits, image summaries, and timezone-formatted
 * timestamps. Ported verbatim from the old ClaraAgent (these methods never touched
 * the OpenAI Agents SDK); the only change is that the context builders now return
 * plain text instead of `AgentInputItem`s.
 *
 * `build()` returns:
 *   - systemContext: the "# TECHNICIAN DETAILS" + "# JOB CONTEXT" markdown block.
 *   - history:       the recent conversation as plain {role, content} turns, with
 *                    image-summary turns interleaved as assistant messages.
 */

const HISTORY_LIMIT = 15;

type TechnicianProfile = {
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
  userId?: bigint | string | null;
};

type JobContext = {
  jobNumber?: string;
  issueDescription?: string;
  visitNumber?: number;
  visitDescription?: string;
  jobTargetName?: string;
  address?: string;
  startTimestamp?: string;
  status?: string;
  companies?: string;
  description?: string;
  previousVisits?: {
    visitNumber: number;
    technicianName: string;
    description?: string;
    startTimestamp: string;
    status: string;
  }[];
};

function normalizeTimezone(timezone?: string): string | undefined {
  if (!timezone) return undefined;
  const trimmed = timezone.trim();
  if (!trimmed) return undefined;
  if (trimmed === "Asia/Calcutta") return "Asia/Kolkata";
  return trimmed;
}

function getTimezoneFromCoordinates(lat?: number | null, lng?: number | null): string | undefined {
  if (lat == null || lng == null) return undefined;
  try {
    const [tz] = findTimezone(lat, lng);
    return tz;
  } catch {
    return undefined;
  }
}

function tryFormatWithTimezone(ts: Date | string, timezone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(ts));
  } catch {
    return undefined;
  }
}

function formatTimestamp(
  ts: Date | string,
  options?: { timezone?: string; lat?: number | null; lng?: number | null }
): string {
  const headerTimezone = normalizeTimezone(options?.timezone);
  if (headerTimezone) {
    const formatted = tryFormatWithTimezone(ts, headerTimezone);
    if (formatted) return formatted;
  }
  const geoTimezone = getTimezoneFromCoordinates(options?.lat, options?.lng);
  if (geoTimezone) {
    const formatted = tryFormatWithTimezone(ts, geoTimezone);
    if (formatted) return formatted;
  }
  return String(ts);
}

async function getTechnicianProfile(conversationId: string): Promise<TechnicianProfile | null> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      userId: true,
      users: { select: { first_name: true, last_name: true, role: true } },
    },
  });
  if (!convo) return null;
  return {
    firstName: (convo as any)?.users?.first_name ?? null,
    lastName: (convo as any)?.users?.last_name ?? null,
    role: (convo as any)?.users?.role ?? null,
    userId: convo.userId ?? null,
  };
}

async function getJobContext(conversationId: string, timezone?: string): Promise<JobContext | null> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      jobs: {
        select: {
          id: true,
          company_id: true,
          job_target_name: true,
          address: true,
          start_timestamp: true,
          status: true,
          companies: true,
          meta_data: true,
          description: true,
          geocoded_lat: true,
          geocoded_lng: true,
        },
      },
    },
  });

  if (!convo?.jobs) return null;

  const meta = (convo.jobs.meta_data as Record<string, unknown>) ?? {};
  const jobNumber = (meta.jobNumber as string) ?? undefined;

  let previousVisits: JobContext["previousVisits"] = [];

  if (jobNumber) {
    const siblingJobs = await prisma.jobs.findMany({
      where: {
        company_id: convo.jobs.company_id,
        meta_data: { path: ["jobNumber"], equals: jobNumber },
        id: { not: convo.jobs.id },
      },
      orderBy: { start_timestamp: "desc" },
      take: 10,
      select: {
        meta_data: true,
        start_timestamp: true,
        status: true,
        description: true,
        geocoded_lat: true,
        geocoded_lng: true,
        users: { select: { first_name: true, last_name: true } },
      },
    });

    previousVisits = siblingJobs.map((v) => {
      const vMeta = (v.meta_data as Record<string, unknown>) ?? {};
      const techName = v.users ? `${v.users.first_name} ${v.users.last_name}` : "Unassigned";
      return {
        visitNumber: (vMeta.visitNumber as number) ?? 0,
        technicianName: techName,
        description: (vMeta.description as string) ?? v.description ?? undefined,
        startTimestamp: formatTimestamp(v.start_timestamp, {
          timezone,
          lat: v.geocoded_lat,
          lng: v.geocoded_lng,
        }),
        status: v.status,
      };
    });
    previousVisits.sort((a, b) => a.visitNumber - b.visitNumber);
  }

  return {
    jobTargetName: convo.jobs.job_target_name,
    address: convo.jobs.address,
    startTimestamp: formatTimestamp(convo.jobs.start_timestamp, {
      timezone,
      lat: convo.jobs.geocoded_lat,
      lng: convo.jobs.geocoded_lng,
    }),
    status: convo.jobs.status,
    description: convo.jobs.description ?? undefined,
    jobNumber,
    issueDescription: (meta.issueDescription as string) ?? convo.jobs.description ?? undefined,
    visitNumber: (meta.visitNumber as number) ?? undefined,
    visitDescription: (meta.description as string) ?? undefined,
    previousVisits: previousVisits.length > 0 ? previousVisits : undefined,
  };
}

function technicianBlock(profile: TechnicianProfile): string {
  return [
    "# TECHNICIAN DETAILS",
    `- First Name: ${profile.firstName ?? "N/A"}`,
    `- Last Name: ${profile.lastName ?? "N/A"}`,
    `- Role: ${profile.role ?? "N/A"}`,
  ].join("\n");
}

function jobBlock(job: JobContext): string {
  const visitLines = job.previousVisits?.length
    ? job.previousVisits
        .map(
          (v) =>
            `  - Visit #${v.visitNumber}: ${v.technicianName} | ${v.startTimestamp} | ${v.status}${
              v.description ? ` | ${v.description}` : ""
            }`
        )
        .join("\n")
    : "  None";

  return [
    "# JOB CONTEXT",
    `- Job Target Name: ${job.jobTargetName ?? "N/A"}`,
    `- Address: ${job.address ?? "N/A"}`,
    `- Start Timestamp: ${job.startTimestamp ?? "N/A"}`,
    `- Status: ${job.status ?? "N/A"}`,
    `- Companies: ${job.companies ?? "N/A"}`,
    `- Job Number: ${job.jobNumber ?? "N/A"}`,
    `- Job Description: ${job.issueDescription ?? job.description ?? "N/A"}`,
    `- Current Visit Number: ${job.visitNumber ?? "N/A"}`,
    `- Current Visit Description: ${job.visitDescription ?? "N/A"}`,
    "",
    `## Previous Visits (${job.previousVisits?.length ?? 0})`,
    visitLines,
  ].join("\n");
}

function formatImageSummary(summary: any): string {
  const parts: string[] = [];
  parts.push(
    `Image summary (${summary.attachmentId ?? summary.imageFileId ?? summary.image_id ?? "image"}):`
  );
  if (summary.summary) parts.push(summary.summary);
  if (Array.isArray(summary.objects) && summary.objects.length > 0) {
    parts.push(`Objects: ${summary.objects.join(", ")}`);
  }
  if (Array.isArray(summary.observations) && summary.observations.length > 0) {
    parts.push(`Observations: ${summary.observations.join("; ")}`);
  }
  if (summary.inferred_issue) parts.push(`Inferred issue: ${summary.inferred_issue}`);
  if (Array.isArray(summary.linked_entities) && summary.linked_entities.length > 0) {
    parts.push(`Linked entities: ${summary.linked_entities.join(", ")}`);
  }
  return parts.join(" ");
}

function imageSummaryTurns(message: Message): ChatTurn[] {
  const summaries = Array.isArray(message.metadata?.imageSummaries)
    ? (message.metadata!.imageSummaries as any[])
    : [];
  return summaries.map((summary) => ({
    role: "assistant" as const,
    content: formatImageSummary(summary),
  }));
}

export const contextService = {
  /** Assemble the system-context block + recent history for a conversation. */
  async build(
    conversationId: string,
    timezone?: string
  ): Promise<{ systemContext: string; history: ChatTurn[] }> {
    const [recent, profile, job] = await Promise.all([
      messageRepository.getLastMessages(conversationId, HISTORY_LIMIT),
      getTechnicianProfile(conversationId),
      getJobContext(conversationId, timezone),
    ]);

    const contextParts: string[] = [];
    if (profile) contextParts.push(technicianBlock(profile));
    if (job) contextParts.push(jobBlock(job));

    const history: ChatTurn[] = [];
    for (const msg of recent) {
      history.push(...imageSummaryTurns(msg));
      if (msg.content) {
        history.push({
          role: msg.senderType === "AI" ? "assistant" : "user",
          content: msg.content as string,
        });
      }
    }

    logger.info("Orchestrator context assembled", {
      conversationId,
      hasProfile: Boolean(profile),
      hasJob: Boolean(job),
      historyItems: history.length,
    });

    return { systemContext: contextParts.join("\n\n"), history };
  },
};
