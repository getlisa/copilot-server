import { Agent } from "@openai/agents";
import { imageAnalyzerSystemPrompt } from "../config/systemPrompt";
import dotenv from "dotenv";
import logger from "../lib/logger";

dotenv.config();

const DEFAULT_MODEL = process.env.OPENAI_AGENT_MODEL ?? "gpt-4o-mini";

/**
 * Image analyzer agent: focuses solely on analyzing the images and providing a summary of the images.
 */
export const imageAnalyzerAgent = new Agent({
  name: "Image Analyzer Agent",
  instructions: imageAnalyzerSystemPrompt,
  model: DEFAULT_MODEL
});


