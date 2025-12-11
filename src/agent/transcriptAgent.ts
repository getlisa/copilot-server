import { Agent } from "@openai/agents";
import { transcriptSystemPrompt } from "../config/systemPrompt";


export const transcriptAgent = new Agent({
  name: "Transcript Agent",
  instructions: transcriptSystemPrompt,
  model: process.env.OPENAI_AGENT_MODEL,
});