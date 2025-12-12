import { Agent } from "@openai/agents";
import { getImageTool } from "../tools/getImageTool";
import { imageAnalyzerSystemPrompt } from "../config/systemPrompt";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-4o-mini";

/**
 * Image analyzer agent: focuses solely on visual analysis.
 * Expects a conversationId in the run context so it can call the get_images tool.
 */
export const imageAnalyzerAgent = new Agent({
  name: "Image Analyzer Agent",
  instructions: imageAnalyzerSystemPrompt,
  model: DEFAULT_MODEL,
  tools: [getImageTool],
});


