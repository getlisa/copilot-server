import {
    Agent,
    run,
    InputGuardrail,
  } from '@openai/agents';
  import { z } from 'zod';
  
  const guardrailAgent = new Agent({
    name: 'Guardrail check',
    instructions: 'Check if the user is asking questions related to the field service industries like HVAC, plumbing, electrical, fire protection, and more.',
    outputType: z.object({
      isFieldServiceQuestion: z.boolean(),
      reasoning: z.string(),
    }),
  });
  
export const fieldServiceQuestionGuardrail: InputGuardrail = {
  name: "Field Service Question Guardrail",
  // Set runInParallel to false to block the model until the guardrail completes.
  runInParallel: false,
  execute: async ({ input, context }) => {
    const result = await run(guardrailAgent, input, { context });
    const isFieldService = result.finalOutput?.isFieldServiceQuestion ?? false;

    const playfulGuidance = [
      "I’m on the clock for HVAC, plumbing, or electrical—got any leaky pipes or noisy vents for me?",
      "I’m a field service brain. Ask me about gear, not geopolitics.",
      "Happy to help with tools and troubleshooting—what’s the issue in front of you?",
      "Nice try champ, let's focus on the job at the hand first."
    ];
    const guidance =
      playfulGuidance[Math.floor(Math.random() * playfulGuidance.length)] ??
      "I’m focused on field service (HVAC, plumbing, electrical, fire protection, job context). Please ask something related to the job or equipment you’re working on.";

    // Tripwire when the question is NOT field-service related.
    return {
      outputInfo: {
        ...result.finalOutput,
        guidance,
      },
      tripwireTriggered: !isFieldService,
    };
  },
};