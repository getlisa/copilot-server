import OpenAI from "openai";
import logger from "./logger";
import { ResponseInputMessageContentList } from "openai/resources/responses/responses";
import { imageSummarySystemPrompt } from "./systemPrompt";

const openai = new OpenAI();
const SUMMARY_MODEL =
  process.env.OPENAI_IMAGE_SUMMARY_MODEL ??
  process.env.IMAGE_SUMMARY_MODEL ??
  "gpt-4o-mini";

/**
 * Structured image summary format we store with each IMAGE message.
 */
export type StructuredSummary = {
  source: "user_upload";
  summary: string;
  objects?: string[];
  observations?: string[];
  inferred_issue?: string;
  confidence?: number;
  linked_entities?: string[];
};

/**
 * Generate a structured summary for a presigned image URL.
 * Returns null when the summary cannot be produced or parsed.
 */
export async function summarizeImageUrl(imageUrl: string): Promise<StructuredSummary | null> {
  if (!imageUrl || typeof imageUrl !== "string") {
    return null;
  }
  console.log("SUMMARY_MODEL:", SUMMARY_MODEL);

  try {
    const response = await openai.responses.create({
      model: SUMMARY_MODEL,
      max_output_tokens: 400,
      stream: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: imageSummarySystemPrompt
            },
            {
              type: "input_image",
              image_url: imageUrl
            }
          ] as ResponseInputMessageContentList
        }
      ]
    });

    const segments = Array.isArray(response.output)
      ? response.output
          .flatMap((block: any) =>
            Array.isArray(block?.content)
              ? block.content
                  .filter((item: any) => item?.type === "output_text")
                  .map((item: any) => (item?.text ?? "").trim())
                  .filter((item: any) => Boolean(item))
              : []
          )
      : [];

    const raw = segments.join(" ").trim();
    if (!raw) return null;

    const extractJson = (text: string) => {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return text.slice(start, end + 1);
      }
      return text;
    };

    const candidate = extractJson(raw);

    let parsed: StructuredSummary | null = null;
    try {
      parsed = JSON.parse(candidate) as StructuredSummary;
    } catch (jsonErr) {
      logger.warn("Image summary JSON parse failed", {
        imageUrl,
        raw,
        error: jsonErr instanceof Error ? jsonErr.message : String(jsonErr),
      });
      return null;
    }

    // Normalize defaults to reduce downstream nulls
    parsed.source = parsed.source ?? "user_upload";
    parsed.summary = parsed.summary ?? "";
    parsed.objects = Array.isArray(parsed.objects) ? parsed.objects : [];
    parsed.observations = Array.isArray(parsed.observations) ? parsed.observations : [];
    parsed.inferred_issue = parsed.inferred_issue ?? "";
    parsed.linked_entities = Array.isArray(parsed.linked_entities) ? parsed.linked_entities : [];

    return parsed;
  } catch (error) {
    logger.warn("Image summary generation failed", {
      imageUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
