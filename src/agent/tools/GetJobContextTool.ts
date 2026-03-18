import { tool } from "@openai/agents";
import { z } from "zod";
import prisma from "../../lib/prisma";
import logger from "../../lib/logger";

export const getJobContextTool = tool({
  name: "get_job_context",
  description:
    "Fetch the technician's current job details — job number, address, scheduled time, status, job description, and visit information. Call this whenever the user asks about their current job, visit, customer, address, or any job-related details.",
  parameters: z.object({}),
  async execute(
    _params,
    runContext?: { context?: { conversationId?: string; userId?: string; timezone?: string } }
  ) {
    const conversationId = runContext?.context?.conversationId;
    const timezone = runContext?.context?.timezone;

    if (!conversationId) {
      return "No conversation context available to look up job details.";
    }

    logger.info("get_job_context invoked", { conversationId });

    try {
      const convo = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          jobs: {
            select: {
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

      if (!convo?.jobs) {
        return "No job is currently assigned to this conversation.";
      }

      const meta = (convo.jobs.meta_data as Record<string, unknown>) ?? {};

      let startTimestamp: string;
      if (timezone && convo.jobs.start_timestamp) {
        try {
          startTimestamp = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(convo.jobs.start_timestamp));
        } catch {
          startTimestamp = String(convo.jobs.start_timestamp);
        }
      } else {
        startTimestamp = String(convo.jobs.start_timestamp);
      }

      const lines = [
        "# JOB CONTEXT",
        `- Job Target Name: ${convo.jobs.job_target_name ?? "N/A"}`,
        `- Address: ${convo.jobs.address ?? "N/A"}`,
        `- Scheduled Time: ${startTimestamp}`,
        `- Status: ${convo.jobs.status ?? "N/A"}`,
        `- Companies: ${convo.jobs.companies ? JSON.stringify(convo.jobs.companies) : "N/A"}`,
        `- Job Number: ${(meta.jobNumber as string) ?? "N/A"}`,
        `- Job Description: ${(meta.issueDescription as string) ?? convo.jobs.description ?? "N/A"}`,
        `- Visit Number: ${(meta.visitNumber as number) ?? "N/A"}`,
        `- Visit Description: ${(meta.description as string) ?? "N/A"}`,
      ];

      return lines.join("\n");
    } catch (error) {
      logger.error("get_job_context tool failed", {
        conversationId,
        error: String(error),
      });
      return "Failed to retrieve job context. Please try again.";
    }
  },
});
